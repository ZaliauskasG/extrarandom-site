/* ============================================================================
   SQUAD UP — server
   Small HTTP server: server-rendered pages plus a JSON API. All the decision
   logic lives in lib/core.js; this file is routing, permissions, and
   notification fan-out.
   ========================================================================== */
const http = require("http");
const C = require("../lib/core");
const V = require("../lib/views");
const { makeDb } = require("../lib/db");
const { makeNotifier, notifyAll, makeGuard, useGuard, link, activityLink, replyLink, BASE,
        twilioSignatureOk } = require("../lib/notify");

const PORT = process.env.PORT || 3000;
const db = makeDb();
const notifier = makeNotifier();
// every email and text passes the daily limits in lib/notify.js
const guard = makeGuard(db);
useGuard(guard);
const smsOn = () => !!notifier.backends.sms;

/* ---------- plumbing ---------- */
const json = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};
const html = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
};
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", d => {
      s += d;
      if (s.length > 1e6) { reject(new Error("too big")); req.destroy(); }
    });
    req.on("end", () => {
      // Twilio posts forms; everything else is JSON
      if (/x-www-form-urlencoded/.test(req.headers["content-type"] || "")) {
        return resolve(Object.fromEntries(new URLSearchParams(s)));
      }
      try { resolve(s ? JSON.parse(s) : {}); } catch (e) { resolve({}); }
    });
    req.on("error", reject);
  });
}
class Fail extends Error {
  constructor(msg, code) { super(msg); this.code = code || 400; }
}
async function viewerFrom(token) {
  if (!token) return null;
  return db.getPersonByToken(String(token));
}
async function requireViewer(token) {
  const p = await viewerFrom(token);
  if (!p) throw new Fail("That link isn't valid any more.", 403);
  return p;
}

/* ---------- shared reads ---------- */
async function activityBundle(id) {
  const a = await db.getActivity(id);
  if (!a) return null;
  const [options, responses, tag] = await Promise.all([
    db.listOptions(id), db.listResponses(id), db.getTag(a.tag_id)
  ]);
  options.sort((x, y) => String(x.starts_at).localeCompare(String(y.starts_at)));
  return { a, options, responses, tag };
}

async function subscribersFor(a) {
  const subs = await db.subscribersOfTag(a.tag_id);
  const creator = await db.getPerson(a.creator_id);
  if (creator && !subs.some(p => p.id === creator.id)) subs.push(creator);
  return subs;
}

// Anyone who has engaged with the activity should hear about changes, even
// if they've since unsubscribed from the category -- they've shown they care
// about this particular one.
// Invited people count too, whatever categories they follow.
async function audienceFor(a) {
  const subs = await subscribersFor(a);
  const [responses, invites] = await Promise.all([db.listResponses(a.id), db.listInvites(a.id)]);
  const have = new Set(subs.map(p => p.id));
  for (const id of [...responses.map(r => r.person_id), ...invites.map(i => i.person_id)]) {
    if (have.has(id)) continue;
    const p = await db.getPerson(id);
    if (p) { subs.push(p); have.add(p.id); }
  }
  return subs;
}

const INVITES_PER_DAY = Number(process.env.SQUAD_INVITES_PER_DAY) || 40;  // per person sending them
const NEW_PEOPLE_PER_DAY = Number(process.env.SQUAD_NEW_PEOPLE_PER_DAY) || 10;  // brand-new people one person can add

const xmlEsc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* A text came in. Work out who sent it and what they meant, act on it, and
   return the reply to text back (or null to stay quiet). A bare answer
   applies to the last thing we asked them, within the last two weeks. */
async function handleText(from, text) {
  const phone = C.normalizePhone(from);
  const me = phone ? await db.getPersonByPhone(phone) : null;
  if (!me) return null;                          // not someone we know; say nothing
  const r = C.parseReply(text);
  const page = link(me);

  if (r.kind === "stop") {
    await db.updatePerson(me.id, { opted_out_at: new Date().toISOString() });
    return null;   // the carrier sends its own "you're unsubscribed" confirmation
  }
  if (r.kind === "start") {
    await db.updatePerson(me.id, { opted_out_at: null });
    await confirmPerson(me);
    return `You're back on Squad Up. ${page}`;
  }
  if (me.opted_out_at) return null;

  // replies are texts too, so they count against the same daily limits
  if (await guard.check(me, "sms", "reply")) return null;
  const say = async msg => { await guard.record(me, "sms", "reply"); return msg; };

  const help = `Squad Up: reply YES or NO to the last plan we sent you, or the number of a time. ` +
               `Your page: ${page} Reply STOP to opt out.`;
  if (r.kind === "help" || r.kind === "unknown") return say(help);

  const ask = await db.latestAsk(me.id, new Date(Date.now() - 14 * 864e5).toISOString());
  const bundle = ask ? await activityBundle(ask.activity_id) : null;
  if (!bundle) return say(`Nothing's waiting on an answer from you right now. Your page: ${page}`);
  const { a, options } = bundle;
  const asked = ask.option_ids.filter(id => options.some(o => o.id === id));
  const pending = asked.filter(id => options.find(o => o.id === id).status === "pending");

  let what;
  if (pending.length && r.kind === "yes") what = "approve:" + pending[0];        // "ADD"/"yes" to a suggestion
  else if (r.kind === "no") what = "no";
  else if (r.kind === "both") what = asked.length ? "opts:" + asked.join(",") : "all";
  else if (r.kind === "pick") {
    const id = asked[r.n - 1];
    if (!id) return say(`There's no time ${r.n} on that one. ${activityUrl(a.id, me)}`);
    what = "opt:" + id;
  } else if (r.kind === "yes") {
    const id = asked.includes(a.locked_option_id) ? a.locked_option_id : asked[0] || a.locked_option_id;
    what = "opt:" + id;
  }
  try {
    const wasWaiting = !me.confirmed_at;
    const saved = await answer(me, bundle, what);
    const url = activityUrl(a.id, me);
    if (saved === "added") return say(`Added. Everyone can now say if it works. ${url}`);
    if (saved === "out") return say(wasWaiting
      ? `Got it, you're out for ${C.fullTitle(a)}. We won't text you again. Change your mind? Reply YES. ${url}`
      : `Got it, you're out for ${C.fullTitle(a)}. Changed your mind? ${url}`);
    const mine = (await db.listResponses(a.id)).find(x => x.person_id === me.id);
    const times = options.filter(o => (mine.option_ids || []).includes(o.id)).sort(byTime)
      .map(o => C.formatWhen(o.starts_at)).join(" and ");
    return say(`${wasWaiting ? "Welcome to Squad Up! " : ""}Got it, you're in for ${C.fullTitle(a)}: ${times}. ${url}`);
  } catch (e) {
    if (e instanceof Fail) return say(`${e.message} ${activityUrl(a.id, me)}`);
    throw e;
  }
}

// The invite list for one plan: who's been asked (with how they answered),
// and everyone else, people into this category first.
async function inviteData(a, viewer, responses) {
  const [invites, people, subs] = await Promise.all([
    db.listInvites(a.id), db.listPeople(), db.subscribersOfTag(a.tag_id)
  ]);
  const byId = {};
  people.forEach(p => { byId[p.id] = p; });
  const answer = id => {
    const r = responses.find(x => x.person_id === id);
    if (!r) return "none";
    if (r.can_make_it === false) return "out";
    return (r.option_ids || []).length ? "in" : "none";
  };
  const invited = invites
    .sort((x, y) => String(x.invited_at).localeCompare(String(y.invited_at)))
    .filter(i => byId[i.person_id])
    .map(i => ({ id: i.person_id, name: byId[i.person_id].name, status: answer(i.person_id),
                 by: (byId[i.invited_by] || {}).name || null }));
  const taken = new Set([...invites.map(i => i.person_id), a.creator_id, viewer ? viewer.id : null]);
  const into = new Set(subs.map(p => p.id));
  const byName = (x, y) => x.name.localeCompare(y.name);
  const open = people.filter(p => !taken.has(p.id) && !p.opted_out_at).map(p => ({ id: p.id, name: p.name }));
  return {
    invited,
    into: open.filter(p => into.has(p.id)).sort(byName),
    others: open.filter(p => !into.has(p.id)).sort(byName)
  };
}

// always pass the person: their key goes in the link so they land signed in
const activityUrl = (id, person) => activityLink(id, person);

const firstWord = n => String(n || "").split(" ")[0];
const byTime = (x, y) => String(x.starts_at).localeCompare(String(y.starts_at));

// One-tap buttons for a "does this work for you" email. Mirrors the buttons
// on the plan page, so answering from the inbox and from the site are the
// same thing. (Text-message replies will map onto these same answers.)
// Each button also carries the word to text back ("YES", "1", "BOTH"...),
// and the message remembers which times it asked about, so a texted reply
// answers exactly what that message asked.
function askMsg(a, person, options) {
  const times = options.filter(o => o.status === "approved").slice().sort(byTime);
  if (!times.length) return { actions: [] };
  const acts = times.length === 1
    ? [{ label: "I'm in", url: replyLink(a.id, person, "opt:" + times[0].id), reply: "YES" }]
    : times.map((o, i) => ({ label: `${C.formatWhen(o.starts_at)} works`,
        url: replyLink(a.id, person, "opt:" + o.id), reply: String(i + 1), replyLabel: C.formatWhen(o.starts_at) }));
  if (times.length > 1) acts.push({ label: times.length === 2 ? "Both work" : "All work",
    url: replyLink(a.id, person, "all"), reply: times.length === 2 ? "BOTH" : "ALL" });
  acts.push({ label: "Can't make it", url: replyLink(a.id, person, "no"), quiet: true, reply: "NO" });
  return { actions: acts, ask: { activity_id: a.id, option_ids: times.map(o => o.id) } };
}

// The invite itself, for someone already on Squad Up or brand new.
function inviteMsg(me, a, approved, per, isNew) {
  const when = approved.map(o => C.formatWhen(o.starts_at)).join(" or ");
  const first = firstWord(me.name);
  return {
    subject: `${first} invited you: ${C.fullTitle(a)}`,
    body: isNew
      ? `${me.name} invited you to ${C.fullTitle(a)}: ${when}. Squad Up is how ${first}'s friends make plans. ` +
        `Can you make it? This is the only message you'll get from us unless you say you're in.`
      : `${me.name} wants you at ${C.fullTitle(a)}: ${when}. Can you make it?`,
    sms: `${me.name} invited you to ${C.fullTitle(a)}: ${when}.` +
         (isNew ? ` Squad Up is how ${first}'s friends make plans. No more texts unless you say you're in.` : ""),
    url: activityUrl(a.id, per),
    firstContact: !!isNew,
    ...askMsg(a, per, approved)
  };
}

// Someone said they're in (yes to a plan, followed a category, tapped
// "Get Squad Up messages", or texted START): from now on they get messages.
// Saying yes to a plan also follows its category, so they hear about the
// next one like it. Saying no, or just opening a link, doesn't opt anyone in.
async function confirmPerson(person, tagId) {
  if (!person.confirmed_at) {
    await db.updatePerson(person.id, { confirmed_at: new Date().toISOString() });
    person.confirmed_at = true;
  }
  if (tagId) await db.setSubscription(person.id, tagId, true);
}

// Make sure the creator is down as available for every time they set.
async function markCreatorIn(a, optionIds) {
  const responses = await db.listResponses(a.id);
  const mine = responses.find(r => r.person_id === a.creator_id);
  const ids = new Set(mine && mine.can_make_it !== false ? (mine.option_ids || []) : []);
  optionIds.forEach(id => ids.add(id));
  await db.upsertResponse({ activity_id: a.id, person_id: a.creator_id,
    option_ids: [...ids], can_make_it: true });
}

// A time moved or went away: answers given for the old time no longer mean
// anything, so they're cleared (except the creator's, who set it).
async function clearAnswersFor(a, optionId, keepCreator) {
  for (const r of await db.listResponses(a.id)) {
    const ids = r.option_ids || [];
    if (!ids.includes(optionId)) continue;
    if (keepCreator && r.person_id === a.creator_id) continue;
    await db.upsertResponse({ ...r, option_ids: ids.filter(x => x !== optionId) });
  }
}

async function approveOption(me, bundle, opt) {
  await db.updateOption(opt.id, { status: "approved" });
  const people = await audienceFor(bundle.a);
  const fresh = { ...opt, status: "approved" };
  await notifyAll(notifier, people, per => ({
    subject: `New time on the table for ${C.fullTitle(bundle.a)}`,
    body: `${C.formatWhen(opt.starts_at)} is now an option. Does it work for you?`,
    url: activityUrl(bundle.a.id, per),
    ...askMsg(bundle.a, per, [fresh])
  }), { skipPersonId: me.id });
}

// Shared by the plan page buttons and the one-tap email links.
// Returns a short code the plan page turns into a "Saved" note.
async function answer(me, bundle, what) {
  const { a, options } = bundle;
  if (a.canceled_at) throw new Fail("That plan was deleted.");
  if (planIsOver(bundle)) throw new Fail("That one already happened.");

  const w = String(what || "");
  if (w.startsWith("approve:")) {
    if (!C.isCreator(me, a)) throw new Fail("Only whoever posted it can add times.", 403);
    const opt = options.find(o => o.id === w.slice(8));
    if (!opt) throw new Fail("That suggestion is gone.", 404);
    if (opt.status !== "approved") await approveOption(me, bundle, opt);
    return "added";
  }

  const existing = bundle.responses.find(r => r.person_id === me.id);
  if (w === "no") {
    await db.upsertResponse({ activity_id: a.id, person_id: me.id, option_ids: [], can_make_it: false });
    return "out";
  }
  const approved = options.filter(o => o.status === "approved");
  let ids = existing && existing.can_make_it !== false ? (existing.option_ids || []).slice() : [];
  if (w === "all") ids = approved.map(o => o.id);
  else if (w.startsWith("opts:")) {
    const want = w.slice(5).split(",").filter(id => approved.some(o => o.id === id));
    if (!want.length) throw new Fail("Those times aren't on the board any more.");
    want.forEach(id => { if (!ids.includes(id)) ids.push(id); });
  } else if (w.startsWith("opt:")) {
    const opt = approved.find(o => o.id === w.slice(4));
    if (!opt) throw new Fail("That time isn't on the board any more.");
    if (!ids.includes(opt.id)) ids.push(opt.id);   // add, never toggle off
  } else throw new Fail("Not sure what that link was asking.");
  await db.upsertResponse({ activity_id: a.id, person_id: me.id, option_ids: ids, can_make_it: true });
  await confirmPerson(me, me.confirmed_at ? null : a.tag_id);
  return "in";
}

function planIsOver(bundle) {
  const locked = bundle.options.find(o => o.id === bundle.a.locked_option_id);
  return C.isOver(locked && locked.starts_at, new Date());
}

// The creator's second time: whichever of their own two isn't the plan now.
function otherCreatorTime(a, options) {
  return options.find(o => o.id !== a.locked_option_id && o.status === "approved" &&
    (o.kind === "primary" || o.kind === "backup")) || null;
}

// Activities with their options, split into what's coming and what's past.
async function plansWithOptions(list, now) {
  const out = [];
  for (const a of list) {
    const options = (await db.listOptions(a.id)).sort(byTime);
    const locked = options.find(o => o.id === a.locked_option_id) || null;
    const responses = await db.listResponses(a.id);
    out.push({
      ...a, options, locked,
      past: C.isPastPlan(a, locked, now),
      inCount: locked ? responses.filter(r => (r.option_ids || []).includes(locked.id)).length : 0,
      pendingCount: options.filter(o => o.status === "pending").length
    });
  }
  return out;
}

// Pick an existing category or make a new one -- shared by activities and ideas.
async function resolveTag(me, body) {
  if (body.tag_id) {
    const t = await db.getTag(String(body.tag_id));
    if (!t) throw new Fail("That category is gone. Pick another.");
    return { tag: t, fresh: false };
  }
  const name = String(body.tag_name || "").trim();
  if (!name) throw new Fail("Pick a category or name a new one.");
  const found = await db.getTagByName(name);
  // createTag subscribes everyone, so a brand-new category still reaches people
  const tag = found || await db.createTag({ name, created_by: me.id });
  return { tag, fresh: !found };
}

// Email and phone from a form: tidied, checked, at least one required.
// While texting is off, an email is needed so the person can be reached.
function contactFields(body) {
  const email = String(body.email || "").trim() || null;
  const phone = C.normalizePhone(body.phone);
  if (email && !C.EMAIL_RE.test(email)) throw new Fail("That email doesn't look right.");
  if (phone === false) throw new Fail("That phone number doesn't look right.");
  if (!email && !phone) throw new Fail(smsOn() ? "Add an email or a phone number." : "Add an email.");
  if (!email && !smsOn()) throw new Fail("Add an email too. Texting isn't switched on yet.");
  if (!email && !notifier.canText(phone)) throw new Fail("Add an email too. Texting is only on for test numbers right now.");
  return { email, phone: phone || null };
}

async function liveIdea(id) {
  const idea = id ? await db.getIdea(String(id)) : null;
  if (!C.isIdeaLive(idea, new Date())) throw new Fail("That one's no longer on the list.", 404);
  return idea;
}

// Everything the "Let's do this sometime" section needs, for one viewer.
async function ideasFor(viewer) {
  const now = new Date();
  const [ideas, members, people] = await Promise.all([
    db.listIdeas(), db.listAllIdeaMembers(), db.listPeople()
  ]);
  const byId = {};
  people.forEach(p => { byId[p.id] = p; });
  const live = ideas.filter(i => C.isIdeaLive(i, now)).map(i => {
    const mine = members.filter(m => m.idea_id === i.id)
      .sort((x, y) => String(x.joined_at).localeCompare(String(y.joined_at)));
    return {
      ...i,
      members: mine.map(m => byId[m.person_id]).filter(Boolean)
        .map(p => ({ id: p.id, name: p.name })),
      iAmIn: !!viewer && mine.some(m => m.person_id === viewer.id),
      expiresAt: C.ideaExpiresAt(i).toISOString(),
      nudgeAgainAt: (d => d && d.toISOString())(C.ideaNudgeAvailableAt(i, now))
    };
  });
  return C.sortIdeas(live);
}

/* ---------- "Find a time" polls ---------- */
async function pollBundle(id) {
  const poll = id ? await db.getPoll(String(id)) : null;
  if (!poll || poll.canceled_at) return null;
  const [options, votes] = await Promise.all([db.listPollOptions(poll.id), db.listPollVotes(poll.id)]);
  return { poll, options: C.sortPollOptions(options), votes };
}
// votes as the page sees them: never the guest keys
const publicVotes = votes => votes.map(v => ({ id: v.id, name: v.name, member: !!v.person_id,
  option_ids: v.option_ids || [] }));
const tidyName = n => String(n || "").replace(/\s+/g, " ").trim().slice(0, C.POLL_NAME_MAX);

// Open polls for someone's home page: ones they started or answered.
async function pollsFor(person, now) {
  const [all, mine] = await Promise.all([db.listPolls(), db.listPollVotesForPerson(person.id)]);
  const answered = new Set(mine.map(v => v.poll_id));
  const out = [];
  for (const poll of all) {
    if (poll.finalized_at) continue;
    if (poll.creator_id !== person.id && !answered.has(poll.id)) continue;
    const b = await pollBundle(poll.id);
    if (!b || C.pollIsStale(b.options, now)) continue;
    const live = b.options.filter(o => !C.pollOptionPast(o, now));
    const best = C.pollRanking(live, b.votes)[0];
    out.push({ ...poll, dateCount: live.length, voterCount: b.votes.length,
      best: best && best.names.length ? { when: C.pollWhen(best.option), n: best.names.length } : null,
      mine: poll.creator_id === person.id });
  }
  return out.sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
}

/* ---------- routes ---------- */
async function handle(req, res, url) {
  const p = url.pathname.replace(/\/+$/, "") || "/squadup";
  const token = url.searchParams.get("t");

  if (p === "/health") { res.writeHead(200); return res.end("ok"); }

  // A real scheduler can hit this; guarded when CRON_SECRET is set.
  if (p === "/squadup/cron/nudge") {
    const secret = process.env.CRON_SECRET;
    if (secret && url.searchParams.get("key") !== secret)
      return json(res, 403, { error: "Bad key." });
    const sent = await runNudges();
    const archived = await sweepIdeas();
    return json(res, 200, { sent, archived });
  }

  /* ---- pages ---- */
  if (req.method === "GET" && (p === "/squadup" || p === "/squadup/join")) {
    const viewer = await viewerFrom(token);
    if (viewer) { res.writeHead(302, { Location: `/squadup/p/${viewer.personal_token}` }); return res.end(); }
    return html(res, 200, V.joinPage(await db.listTags(), { smsOn: smsOn() }));
  }

  if (req.method === "GET" && p.startsWith("/squadup/p/")) {
    const person = await db.getPersonByToken(p.split("/")[3]);
    if (!person) return html(res, 404, V.simplePage("Squad Up",
      "This link is no longer good.", "It may have been replaced. Ask whoever invited you for a new one."));

    const [tags, subs, all, myInvites, answered] = await Promise.all([
      db.listTags(), db.listSubscriptions(person.id), db.listActivities(),
      db.listInvitesForPerson(person.id), db.listRespondedActivityIds(person.id)
    ]);
    // your categories, plus anything you made, were invited to, or answered
    const mineToo = new Set([...myInvites.map(i => i.activity_id), ...answered]);
    const subSet = new Set(subs);
    const tagById = {};
    tags.forEach(t => { tagById[t.id] = t; });

    const visible = all.filter(a => subSet.has(a.tag_id) || a.creator_id === person.id || mineToo.has(a.id));
    // deleted plans and ones whose day has passed live on Past Plans instead
    const withOpts = (await plansWithOptions(visible, new Date()))
      .filter(a => !a.past)
      .map(a => ({ ...a, pendingCount: a.creator_id === person.id ? a.pendingCount : 0 }))
      .sort((x, y) => String(x.locked ? x.locked.starts_at : "9999")
        .localeCompare(String(y.locked ? y.locked.starts_at : "9999")));
    // ideas are shown to everyone, whatever they're subscribed to -- the
    // point is to pull people slightly out of their usual lanes
    const ideas = await ideasFor(person);
    const polls = await pollsFor(person, new Date());
    return html(res, 200, V.personPage(person,
      { tags, subs, activities: withOpts, ideas, polls, tagById, baseUrl: BASE,
        awaitingOptIn: !person.confirmed_at && !person.opted_out_at }));
  }

  if (req.method === "GET" && p === "/squadup/new") {
    const person = await viewerFrom(token);
    if (!person) return html(res, 403, V.simplePage("Squad Up",
      "You'll need your own link for that.", "Open the link we emailed you, then try again."));
    let idea = null;
    const ideaId = url.searchParams.get("idea");
    if (ideaId) {
      const i = await db.getIdea(ideaId);
      if (C.isIdeaLive(i, new Date())) {
        idea = { ...i, memberCount: (await db.listIdeaMembers(i.id)).length };
      }
    }
    // "Do it again" from Past Plans: same everything, new times
    let prefill = null;
    const againId = url.searchParams.get("again");
    if (!idea && againId) {
      const old = await db.getActivity(againId);
      if (old) prefill = { title: old.title, location: old.location, tag_id: old.tag_id, note: old.note };
    }
    // "Make it a plan" from a Find-a-time poll: the picked date, with the
    // next most popular one filled in as the backup
    let fromPoll = null;
    const pollId = url.searchParams.get("poll");
    if (pollId) {
      const b = await pollBundle(pollId);
      if (!b || b.poll.creator_id !== person.id) return html(res, 403, V.simplePage("Squad Up",
        "Only whoever started it can make it a plan.", "Open your own link and try again."));
      if (b.poll.finalized_at && b.poll.activity_id) {
        res.writeHead(302, { Location: `/squadup/a/${b.poll.activity_id}?t=${encodeURIComponent(person.personal_token)}` });
        return res.end();
      }
      const now = new Date();
      const ranked = C.pollRanking(b.options.filter(o => !C.pollOptionPast(o, now)), b.votes);
      const pick = ranked.find(r => r.option.id === url.searchParams.get("opt")) || ranked[0];
      if (pick) {
        const runner = ranked.find(r => r !== pick && r.names.length > 0 &&
          C.pollStart(r.option) !== C.pollStart(pick.option));
        fromPoll = { id: b.poll.id, optionId: pick.option.id, backupOptionId: runner ? runner.option.id : null,
          when: C.pollWhen(pick.option), n: pick.names.length, of: b.votes.length };
        prefill = { title: b.poll.title, location: b.poll.location, note: b.poll.note,
          primary: C.pollStart(pick.option), backup: runner ? C.pollStart(runner.option) : "" };
        if (b.poll.idea_id) {
          const i = await db.getIdea(b.poll.idea_id);
          if (C.isIdeaLive(i, now)) { idea = i; prefill.tag_id = i.tag_id; }
        }
      }
    }
    return html(res, 200, V.newPage(person, await db.listTags(), { idea, prefill, fromPoll }));
  }

  // "+ New plan": pick a date now, or find one together
  if (req.method === "GET" && p === "/squadup/start") {
    const person = await viewerFrom(token);
    if (!person) return html(res, 403, V.simplePage("Squad Up",
      "You'll need your own link for that.", "Open the link we emailed you, then try again."));
    const ideaId = url.searchParams.get("idea");
    return html(res, 200, V.startPage(person, ideaId));
  }

  if (req.method === "GET" && p === "/squadup/find") {
    const person = await viewerFrom(token);
    if (!person) return html(res, 403, V.simplePage("Squad Up",
      "You'll need your own link for that.", "Open the link we emailed you, then try again."));
    let idea = null;
    const ideaId = url.searchParams.get("idea");
    if (ideaId) {
      const i = await db.getIdea(ideaId);
      if (C.isIdeaLive(i, new Date())) idea = i;
    }
    return html(res, 200, V.findPage(person, { idea, today: C.dateOf(C.toLocalStamp(new Date())) }));
  }

  // A Find-a-time poll. Works for anyone with the link: Squad Up members are
  // recognized by their own link, everyone else answers with just a name.
  if (req.method === "GET" && p.startsWith("/squadup/f/")) {
    const b = await pollBundle(p.split("/")[3]);
    if (!b) return html(res, 404, V.simplePage("Squad Up",
      "This one's gone.", "Whoever started it may have deleted it."));
    const viewer = await viewerFrom(token);
    const creator = await db.getPerson(b.poll.creator_id);
    let plan = null;
    if (b.poll.activity_id) {
      const ab = await activityBundle(b.poll.activity_id);
      if (ab && !ab.a.canceled_at) {
        const locked = ab.options.find(o => o.id === ab.a.locked_option_id);
        plan = { id: ab.a.id, title: C.fullTitle(ab.a), when: locked ? C.formatWhen(locked.starts_at) : "" };
      }
    }
    const now = new Date();
    return html(res, 200, V.pollPage(b.poll, {
      options: b.options.map(o => ({ ...o, when: C.pollWhen(o), past: C.pollOptionPast(o, now) })),
      votes: publicVotes(b.votes), viewer, creator, plan,
      isCreator: !!viewer && viewer.id === b.poll.creator_id,
      myVote: viewer ? (b.votes.find(v => v.person_id === viewer.id) || null) : null,
      created: url.searchParams.has("created"),
      shareUrl: `${BASE}/f/${b.poll.id}`, today: C.dateOf(C.toLocalStamp(now))
    }));
  }

  if (req.method === "GET" && p.startsWith("/squadup/edit/")) {
    const person = await viewerFrom(token);
    const bundle = await activityBundle(p.split("/")[3]);
    if (!bundle) return html(res, 404, V.simplePage("Squad Up",
      "No such plan.", "It may have been removed."));
    if (!C.isCreator(person, bundle.a)) return html(res, 403, V.simplePage("Squad Up",
      "Only whoever posted it can edit it.", "Open your own link and try again."));
    const { a, options } = bundle;
    const locked = options.find(o => o.id === a.locked_option_id);
    const other = otherCreatorTime(a, options);
    return html(res, 200, V.newPage(person, await db.listTags(), {
      editId: a.id, deleted: !!a.canceled_at,
      prefill: { title: a.title, location: a.location, tag_id: a.tag_id, note: a.note,
                 primary: locked ? locked.starts_at : "", backup: other ? other.starts_at : "" }
    }));
  }

  if (req.method === "GET" && p === "/squadup/past") {
    const person = await viewerFrom(token);
    if (!person) return html(res, 403, V.simplePage("Squad Up",
      "You'll need your own link for that.", "Open the link we emailed you, then try again."));
    const [tags, all] = await Promise.all([db.listTags(), db.listActivities()]);
    const tagById = {};
    tags.forEach(t => { tagById[t.id] = t; });
    // everyone's past plans, not just your categories -- it's for ideas
    const past = (await plansWithOptions(all, new Date())).filter(a => a.past)
      .sort((x, y) => String(y.locked ? y.locked.starts_at : y.created_at)
        .localeCompare(String(x.locked ? x.locked.starts_at : x.created_at)));
    return html(res, 200, V.pastPage(person, { plans: past, tagById }));
  }

  if (req.method === "GET" && p === "/squadup/stop") {
    const person = await viewerFrom(token);
    if (!person) return html(res, 404, V.simplePage("Squad Up",
      "That link didn't work.", "Open Squad Up from your own link instead."));
    return html(res, 200, V.stopPage(person));
  }

  // one-tap answer from an email: show a page that saves it, then the plan
  if (req.method === "GET" && p.startsWith("/squadup/r/")) {
    const id = p.split("/")[3];
    const person = await viewerFrom(token);
    const a = await db.getActivity(id);
    if (!person || !a) return html(res, 404, V.simplePage("Squad Up",
      "That link didn't work.", "Open Squad Up from your own link instead."));
    return html(res, 200, V.replyPage(a, person, url.searchParams.get("do") || ""));
  }

  if (req.method === "GET" && p.startsWith("/squadup/a/")) {
    const bundle = await activityBundle(p.split("/")[3]);
    if (!bundle) return html(res, 404, V.simplePage("Squad Up",
      "No such thing.", "This activity may have been removed."));
    const { a, options, responses, tag } = bundle;
    const viewer = await viewerFrom(token);
    const isCreator = C.isCreator(viewer, a);

    const shown = C.visibleOptions(options, isCreator);
    const counts = C.tally(shown, responses);
    const creator = await db.getPerson(a.creator_id);

    const peopleById = {};
    for (const r of responses) {
      const per = await db.getPerson(r.person_id);
      if (per) peopleById[per.id] = per;
    }
    if (creator) peopleById[creator.id] = creator;

    const lockedOpt = options.find(o => o.id === a.locked_option_id);
    const invites = viewer ? await inviteData(a, viewer, responses) : null;
    return html(res, 200, V.activityPage(a, {
      invites, smsOn: smsOn(),
      invitedNote: url.searchParams.has("invited")
        ? { n: +url.searchParams.get("invited") || 0, held: +url.searchParams.get("held") || 0,
            unreachable: +url.searchParams.get("unreachable") || 0,
            waiting: +url.searchParams.get("waiting") || 0 } : null,
      viewer, isCreator, options: shown, responses, counts, tag, creator,
      over: C.isOver(lockedOpt && lockedOpt.starts_at, new Date()),
      saved: url.searchParams.get("saved"),
      suggestion: C.switchSuggestion(a, options, responses),
      myResponse: viewer ? responses.find(r => r.person_id === viewer.id) : null,
      peopleById, baseUrl: BASE
    }));
  }

  /* ---- api ---- */
  if (req.method !== "POST") return html(res, 404, V.simplePage("Squad Up",
    "Nothing here.", "Check the link and try again."));
  const body = await readBody(req);

  if (p === "/squadup/api/signup") {
    const name = String(body.name || "").trim().slice(0, 60);
    const { email, phone } = contactFields(body);
    if (!name) throw new Fail("Add your name.");

    // Never hand back an existing person's link just because someone typed
    // their address or number -- send it to them instead.
    const existing = (email && await db.getPersonByEmail(email)) || (phone && await db.getPersonByPhone(phone));
    if (existing) {
      await notifyAll(notifier, [existing], () => ({
        subject: "Your Squad Up link",
        body: "Here's your link again. It's the only one you need.",
        url: `${BASE}/p/${existing.personal_token}`
      }), { kind: "link" });
      return json(res, 200, { emailed: true, via: notifier.channelFor(existing) === "sms" ? "text" : "email" });
    }

    const person = await db.createPerson({ name, email, phone });
    let tagIds = Array.isArray(body.tags) ? body.tags.slice() : [];

    if (body.activity_id) {
      const a = await db.getActivity(body.activity_id);
      // signing up through an activity link subscribes to that one category
      // only -- everything at once would be a rough first impression
      if (a && !tagIds.includes(a.tag_id)) tagIds.push(a.tag_id);
    }
    for (const t of tagIds) await db.setSubscription(person.id, t, true);

    if (body.activity_id) {
      await db.upsertResponse({
        activity_id: body.activity_id, person_id: person.id,
        option_ids: [], can_make_it: true
      });
    }

    await notifyAll(notifier, [person], () => ({
      subject: "Your Squad Up link",
      body: "This link is you. Bookmark it — there's no password to remember.",
      url: `${BASE}/p/${person.personal_token}`
    }), { kind: "link" });

    return json(res, 200, {
      token: person.personal_token, url: `${BASE}/p/${person.personal_token}`
    });
  }

  if (p === "/squadup/api/subscribe") {
    const me = await requireViewer(body.token);
    await db.setSubscription(me.id, String(body.tag_id), !!body.on);
    if (body.on) await confirmPerson(me);   // following something means you want to hear about it
    return json(res, 200, { ok: true });
  }

  // "Get Squad Up messages" on the home page of someone a friend added
  if (p === "/squadup/api/optin") {
    const me = await requireViewer(body.token);
    await confirmPerson(me);
    return json(res, 200, { ok: true });
  }

  if (p === "/squadup/api/reset-link") {
    const me = await requireViewer(body.token);
    const updated = await db.resetToken(me.id);
    return json(res, 200, { url: `${BASE}/p/${updated.personal_token}` });
  }

  if (p === "/squadup/api/activity") {
    const me = await requireViewer(body.token);
    const title = String(body.title || "").trim();
    if (!title) throw new Fail("Give it a name.");
    if (!body.primary) throw new Fail("Pick a first-choice time.");

    // scheduling an idea: check it's still up before anything is written
    const idea = body.idea_id ? await liveIdea(body.idea_id) : null;
    // finishing a Find-a-time poll: only its creator, and only once
    const fromPoll = body.poll_id ? await pollBundle(body.poll_id) : null;
    if (body.poll_id) {
      if (!fromPoll) throw new Fail("That poll is gone.", 404);
      if (fromPoll.poll.creator_id !== me.id) throw new Fail("Only whoever started it can make it a plan.", 403);
      if (fromPoll.poll.finalized_at) throw new Fail("That one's already a plan.");
    }

    const { tag: pickedTag, fresh: freshTag } = await resolveTag(me, body);
    const tagId = pickedTag.id;
    await db.setSubscription(me.id, tagId, true);

    const location = String(body.location || "").trim().slice(0, C.LOCATION_MAX) || null;
    const a = await db.createActivity({
      creator_id: me.id, title, tag_id: tagId, location,
      note: String(body.note || "").trim() || null
    });
    const primary = await db.createOption({
      activity_id: a.id, starts_at: body.primary, kind: "primary",
      status: "approved", proposed_by: me.id, label: null
    });
    const created = [primary];
    if (body.backup && body.backup !== body.primary) {
      created.push(await db.createOption({
        activity_id: a.id, starts_at: body.backup, kind: "backup",
        status: "approved", proposed_by: me.id, label: null
      }));
    }
    // the first choice is locked immediately, so it reads as a real plan
    // rather than an open-ended poll
    await db.updateActivity(a.id, { locked_option_id: primary.id });
    // whoever posts it can obviously make the times they picked
    await markCreatorIn(a, created.map(o => o.id));

    const tag = pickedTag;
    const people = await subscribersFor({ ...a, tag_id: tagId });

    // An idea that gets a time comes off the list, and everyone who said they
    // were in hears about it -- even if they don't follow that category, since
    // ideas are shown to everyone.
    const interested = new Set();
    if (idea) {
      const members = await db.listIdeaMembers(idea.id);
      const have = new Set(people.map(p => p.id));
      for (const m of members) {
        interested.add(m.person_id);
        if (have.has(m.person_id)) continue;
        const per = await db.getPerson(m.person_id);
        if (per) { people.push(per); have.add(per.id); }
      }
      await db.updateIdea(idea.id, {
        archived_at: new Date().toISOString(), converted_activity_id: a.id
      });
    }

    // Squad Up members who answered the poll get the plan on their page, and
    // anyone who said the chosen date works is already marked in for it.
    const voted = new Map();
    if (fromPoll) {
      const pickOpt = fromPoll.options.find(o => o.id === body.poll_option_id);
      const backOpt = fromPoll.options.find(o => o.id === body.poll_backup_option_id);
      const sameDay = (o, when) => o && when && o.day === C.dateOf(when);
      const have = new Set(people.map(p => p.id));
      for (const v of fromPoll.votes) {
        if (!v.person_id || v.person_id === me.id) continue;
        const per = await db.getPerson(v.person_id);
        if (!per) continue;
        const ids = [];
        if (sameDay(pickOpt, body.primary) && v.option_ids.includes(pickOpt.id)) ids.push(primary.id);
        if (created[1] && sameDay(backOpt, body.backup) && v.option_ids.includes(backOpt.id)) ids.push(created[1].id);
        if (ids.length) await db.upsertResponse({ activity_id: a.id, person_id: per.id, option_ids: ids, can_make_it: true });
        await db.addInvite({ activity_id: a.id, person_id: per.id, invited_by: me.id });
        voted.set(per.id, ids.length > 0);
        if (!have.has(per.id)) { people.push(per); have.add(per.id); }
      }
      await db.updatePoll(fromPoll.poll.id, { finalized_at: new Date().toISOString(), activity_id: a.id });
    }

    const named = C.fullTitle({ title, location });
    const when = created.length > 1
      ? `${C.formatWhen(body.primary)} (backup ${C.formatWhen(body.backup)})`
      : C.formatWhen(body.primary);
    await notifyAll(notifier, people, per => ({
      subject: `${named} — ${C.formatWhen(body.primary)}`,
      body: voted.has(per.id)
        ? `It's set: ${named}, ${when}.` + (voted.get(per.id) ? " You said that works, so you're down as in." : "")
        : interested.has(per.id)
        ? `You said you were in for ${idea.title} sometime. ${me.name} picked a time: ${when}.`
        : `${me.name} put up ${named}${freshTag ? ` under a new category, ${tag.name}` : ""}: ${when}.`,
      url: activityUrl(a.id, per),
      ...askMsg(a, per, created)
    }), { skipPersonId: me.id });

    return json(res, 200, { id: a.id });
  }

  if (p === "/squadup/api/activity-edit") {
    const me = await requireViewer(body.token);
    const bundle = await activityBundle(body.activity_id);
    if (!bundle) throw new Fail("That plan is gone.", 404);
    const { a, options } = bundle;
    if (!C.isCreator(me, a)) throw new Fail("Only whoever posted it can edit it.", 403);
    if (a.canceled_at) throw new Fail("That plan was deleted.");

    const title = String(body.title || "").trim();
    if (!title) throw new Fail("Give it a name.");
    if (!body.primary) throw new Fail("Pick a time.");
    if (body.backup && body.backup === body.primary) throw new Fail("The backup is the same as the main time.");
    const location = String(body.location || "").trim().slice(0, C.LOCATION_MAX) || null;
    const { tag } = await resolveTag(me, body);

    const changed = [];        // what everyone who's in should hear about
    const timesToAsk = [];     // times people need to answer again
    const patch = { title, location, tag_id: tag.id,
                    note: String(body.note || "").trim() || null };

    const locked = options.find(o => o.id === a.locked_option_id);
    if (locked && body.primary !== locked.starts_at) {
      const moved = await db.updateOption(locked.id, { starts_at: body.primary });
      await clearAnswersFor(a, locked.id, true);
      patch.finalize_nudge_sent_at = null;      // a new day deserves a new reminder
      changed.push(`Now ${C.formatWhen(body.primary)}.`);
      timesToAsk.push(moved);
    }

    const other = otherCreatorTime(a, options);
    if (body.backup && other && body.backup !== other.starts_at) {
      const moved = await db.updateOption(other.id, { starts_at: body.backup });
      await clearAnswersFor(a, other.id, true);
      changed.push(`Backup is now ${C.formatWhen(body.backup)}.`);
      timesToAsk.push(moved);
    } else if (body.backup && !other) {
      const added = await db.createOption({ activity_id: a.id, starts_at: body.backup,
        kind: "backup", status: "approved", proposed_by: me.id, label: null });
      changed.push(`Added a backup: ${C.formatWhen(body.backup)}.`);
      timesToAsk.push(added);
    } else if (!body.backup && other) {
      await clearAnswersFor(a, other.id, false);
      await db.deleteOption(other.id);
      changed.push(`The backup time (${C.formatWhen(other.starts_at)}) is off.`);
    }
    if ((a.location || null) !== location) {
      changed.push(location ? `Now at ${location}.` : "The location changed.");
    }

    const updated = await db.updateActivity(a.id, patch);
    if (timesToAsk.length) await markCreatorIn(a, timesToAsk.map(o => o.id));

    // Renames, notes and categories go out quietly; only changes to when or
    // where reach people's inboxes.
    if (changed.length) {
      const people = await audienceFor(updated);
      await notifyAll(notifier, people, per => ({
        subject: `${C.fullTitle(updated)} changed`,
        body: `${me.name} made a change. ${changed.join(" ")}`,
        url: activityUrl(a.id, per),
        ...askMsg(updated, per, timesToAsk)
      }), { skipPersonId: me.id });
    }
    return json(res, 200, { ok: true, notified: changed.length > 0 });
  }

  /* ---- Find a time ---- */
  if (p === "/squadup/api/poll") {
    const me = await requireViewer(body.token);
    const title = String(body.title || "").trim().slice(0, 120);
    if (!title) throw new Fail("Give it a name.");
    const parsed = C.parsePollOptions(body.options, new Date());
    if (parsed.error) throw new Fail(parsed.error);
    const idea = body.idea_id ? await liveIdea(body.idea_id) : null;
    const poll = await db.createPoll({ creator_id: me.id, title,
      location: String(body.location || "").trim().slice(0, C.LOCATION_MAX) || null,
      note: String(body.note || "").trim().slice(0, 280) || null, idea_id: idea ? idea.id : null });
    await db.addPollOptions(poll.id, parsed.options);
    return json(res, 200, { id: poll.id, url: `${BASE}/f/${poll.id}` });
  }

  if (p === "/squadup/api/poll-vote") {
    const b = await pollBundle(body.poll_id);
    if (!b) throw new Fail("This one's gone.", 404);
    if (b.poll.finalized_at) throw new Fail("It's already been made a plan.");
    const now = new Date();
    const open = new Set(b.options.filter(o => !C.pollOptionPast(o, now)).map(o => o.id));
    const ids = [...new Set((Array.isArray(body.option_ids) ? body.option_ids : []).map(String))]
      .filter(id => open.has(id));
    const me = await viewerFrom(body.token);
    if (me) {
      const mine = b.votes.find(v => v.person_id === me.id);
      const v = mine ? await db.updatePollVote(mine.id, { option_ids: ids, name: me.name })
        : await db.createPollVote({ poll_id: b.poll.id, name: me.name, person_id: me.id,
            voter_key: C.newToken(), option_ids: ids });
      return json(res, 200, { vote_id: v.id, name: v.name });
    }
    // a guest: their phone keeps a key that lets them change their own answers
    const key = String(body.key || "");
    const theirs = key && b.votes.find(v => !v.person_id && v.voter_key === key);
    if (theirs) {
      const v = await db.updatePollVote(theirs.id, { option_ids: ids });
      return json(res, 200, { vote_id: v.id, name: v.name });
    }
    const name = tidyName(body.name);
    if (!name) throw new Fail("Add your name first.");
    if (b.votes.some(v => !v.person_id && v.name.toLowerCase() === name.toLowerCase()))
      throw new Fail(`Someone already answered as "${name}". Add a last initial, or open this on the phone you used before.`, 409);
    if (b.votes.length >= C.POLL_MAX_VOTERS) throw new Fail("This one's full.", 429);
    const fresh = C.newToken();
    const v = await db.createPollVote({ poll_id: b.poll.id, name, person_id: null, voter_key: fresh, option_ids: ids });
    return json(res, 200, { vote_id: v.id, name: v.name, key: fresh });
  }

  if (p === "/squadup/api/poll-add") {
    const me = await requireViewer(body.token);
    const b = await pollBundle(body.poll_id);
    if (!b) throw new Fail("This one's gone.", 404);
    if (b.poll.creator_id !== me.id) throw new Fail("Only whoever started it can add dates.", 403);
    if (b.poll.finalized_at) throw new Fail("It's already been made a plan.");
    const parsed = C.parsePollOptions(body.options, new Date());
    if (parsed.error) throw new Fail(parsed.error);
    if (b.options.length + parsed.options.length > C.POLL_MAX_DATES)
      throw new Fail(`That's a lot of dates. Keep it to ${C.POLL_MAX_DATES}.`);
    const added = await db.addPollOptions(b.poll.id, parsed.options);
    return json(res, 200, { added: added.length });
  }

  if (p === "/squadup/api/poll-cancel") {
    const me = await requireViewer(body.token);
    const b = await pollBundle(body.poll_id);
    if (!b) throw new Fail("This one's gone.", 404);
    if (b.poll.creator_id !== me.id) throw new Fail("Only whoever started it can delete it.", 403);
    await db.updatePoll(b.poll.id, { canceled_at: new Date().toISOString() });
    return json(res, 200, { ok: true });
  }

  if (p === "/squadup/api/invite") {
    const me = await requireViewer(body.token);
    const bundle = await activityBundle(body.activity_id);
    if (!bundle) throw new Fail("That plan is gone.", 404);
    const { a, options } = bundle;
    if (a.canceled_at) throw new Fail("That plan was deleted.");
    if (planIsOver(bundle)) throw new Fail("That one already happened.");

    const ids = [...new Set((Array.isArray(body.person_ids) ? body.person_ids : []).map(String))]
      .filter(id => id !== me.id);
    if (!ids.length) throw new Fail("Pick at least one person.");
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const already = await db.countInvitesBy(me.id, since);
    if (already + ids.length > INVITES_PER_DAY)
      throw new Fail(`That's more than ${INVITES_PER_DAY} invites in a day. ` +
        `You have ${Math.max(0, INVITES_PER_DAY - already)} left today.`, 429);

    const fresh = [];
    for (const id of ids) {
      const per = await db.getPerson(id);
      if (!per) continue;
      if (await db.addInvite({ activity_id: a.id, person_id: per.id, invited_by: me.id })) fresh.push(per);
    }
    const approved = options.filter(o => o.status === "approved").sort(byTime);
    const sent = await notifyAll(notifier, fresh, per => inviteMsg(me, a, approved, per, !per.confirmed_at),
      { kind: "invite" });
    return json(res, 200, { ok: true, invited: fresh.length, emailed: sent.length, held: sent.held,
      waiting: sent.waiting || 0 });
  }

  // Invite someone who isn't on Squad Up yet. They're added as a person right
  // away (that's how new people join), but they don't follow any categories
  // or get anything beyond this plan until they answer.
  if (p === "/squadup/api/invite-new") {
    const me = await requireViewer(body.token);
    const bundle = await activityBundle(body.activity_id);
    if (!bundle) throw new Fail("That plan is gone.", 404);
    const { a, options } = bundle;
    if (a.canceled_at) throw new Fail("That plan was deleted.");
    if (planIsOver(bundle)) throw new Fail("That one already happened.");
    const name = String(body.name || "").trim().slice(0, 60);
    if (!name) throw new Fail("Add their name.");
    const { email, phone } = contactFields(body);

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    if (await db.countInvitesBy(me.id, since) + 1 > INVITES_PER_DAY)
      throw new Fail(`That's more than ${INVITES_PER_DAY} invites in a day.`, 429);

    // already on Squad Up? then it's an ordinary invite -- and we don't say
    // who matched, so this can't be used to look people up
    let per = (email && await db.getPersonByEmail(email)) || (phone && await db.getPersonByPhone(phone));
    const isNew = !per;
    if (per && per.id === me.id) throw new Fail("That's you!");
    if (isNew) {
      if (await db.countPeopleInvitedBy(me.id, since) >= NEW_PEOPLE_PER_DAY)
        throw new Fail(`You can add up to ${NEW_PEOPLE_PER_DAY} new people a day.`, 429);
      per = await db.createPerson({ name, email, phone, invited_by: me.id, confirmed: false });
    }
    const added = await db.addInvite({ activity_id: a.id, person_id: per.id, invited_by: me.id });
    const approved = options.filter(o => o.status === "approved").sort(byTime);
    const sent = added
      ? await notifyAll(notifier, [per], x => inviteMsg(me, a, approved, x, !x.confirmed_at), { kind: "invite" })
      : [];
    return json(res, 200, { ok: true, invited: added ? 1 : 0, emailed: sent.length,
      held: sent.held || 0, unreachable: sent.unreachable || 0, waiting: sent.waiting || 0, isNew });
  }

  if (p === "/squadup/api/stop") {
    const me = await requireViewer(body.token);
    await db.updatePerson(me.id, { opted_out_at: body.off === false ? null : new Date().toISOString() });
    return json(res, 200, { ok: true, off: body.off !== false });
  }

  // Texts people send back. Twilio posts them here (signed); the reply we
  // return is texted back to them.
  if (p === "/squadup/sms/inbound") {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) return json(res, 404, { error: "Texting isn't set up." });
    if (!twilioSignatureOk(authToken, `${BASE}/sms/inbound`, body, req.headers["x-twilio-signature"]))
      return json(res, 403, { error: "Bad signature." });
    const reply = await handleText(body.From, body.Body);
    res.writeHead(200, { "Content-Type": "text/xml" });
    return res.end(`<?xml version="1.0" encoding="UTF-8"?><Response>${
      reply ? `<Message>${xmlEsc(reply)}</Message>` : ""}</Response>`);
  }

  // one-tap answers (from emails) land here
  if (p === "/squadup/api/reply") {
    const me = await requireViewer(body.token);
    const bundle = await activityBundle(body.activity_id);
    if (!bundle) throw new Fail("That plan is gone.", 404);
    const saved = await answer(me, bundle, body.do);
    return json(res, 200, { ok: true, saved });
  }

  /* ---- "Let's do this sometime" ----
     None of these notify anyone except the weekly nudge, which only reaches
     people who put their own name on that idea. */
  if (p === "/squadup/api/idea") {
    const me = await requireViewer(body.token);
    const title = String(body.title || "").trim();
    if (!title) throw new Fail("What do you want to do?");
    if (title.length > 120) throw new Fail("Keep it shorter than that.");
    const { tag } = await resolveTag(me, body);
    const idea = await db.createIdea({
      creator_id: me.id, title, tag_id: tag.id,
      note: String(body.note || "").trim().slice(0, 280) || null
    });
    await db.addIdeaMember(idea.id, me.id);   // posting it means you're in
    return json(res, 200, { id: idea.id });
  }

  if (p === "/squadup/api/idea-join") {
    const me = await requireViewer(body.token);
    const idea = await liveIdea(body.idea_id);
    if (body.on) {
      const added = await db.addIdeaMember(idea.id, me.id);
      // a new name restarts the four-month clock
      if (added) await db.updateIdea(idea.id, { last_joined_at: new Date().toISOString() });
      return json(res, 200, { ok: true, in: true });
    }
    await db.removeIdeaMember(idea.id, me.id);
    // nobody left wanting it -- take it off the list
    const left = await db.listIdeaMembers(idea.id);
    if (!left.length) await db.updateIdea(idea.id, { archived_at: new Date().toISOString() });
    return json(res, 200, { ok: true, in: false, removed: !left.length });
  }

  if (p === "/squadup/api/idea-nudge") {
    const me = await requireViewer(body.token);
    const idea = await liveIdea(body.idea_id);
    const members = await db.listIdeaMembers(idea.id);
    if (!members.some(m => m.person_id === me.id))
      throw new Fail("Add your name first — the nudge goes to the people who are in.", 403);
    const again = C.ideaNudgeAvailableAt(idea, new Date());
    if (again) throw new Fail(`Someone already nudged this week. Again from ${C.formatDay(again)}.`, 429);
    if (members.length < 2) throw new Fail("You're the only one in so far — nobody to nudge yet.");

    await db.updateIdea(idea.id, {
      last_nudge_at: new Date().toISOString(), last_nudge_by: me.id
    });
    const people = [];
    for (const m of members) {
      if (m.person_id === me.id) continue;
      const per = await db.getPerson(m.person_id);
      if (per) people.push(per);
    }
    const sent = await notifyAll(notifier, people, per => ({
      subject: `Someone should schedule ${idea.title}`,
      body: `${me.name} is ready to make ${idea.title} happen. ` +
            `${members.length} of you said you're in — anyone can pick a time.`,
      url: link(per, `#idea-${idea.id}`)
    }));
    return json(res, 200, { ok: true, sent: sent.length });
  }

  if (p === "/squadup/api/rsvp") {
    const me = await requireViewer(body.token);
    const bundle = await activityBundle(body.activity_id);
    if (!bundle) throw new Fail("That activity is gone.", 404);
    if (bundle.a.canceled_at) throw new Fail("That plan was deleted.");
    if (planIsOver(bundle)) throw new Fail("That one already happened.");

    const existing = bundle.responses.find(r => r.person_id === me.id);
    let ids = existing ? (existing.option_ids || []).slice() : [];

    if (body.cant) {
      // a soft out: doesn't reopen the plan, doesn't notify anyone
      ids = [];
      await db.upsertResponse({ activity_id: bundle.a.id, person_id: me.id,
        option_ids: [], can_make_it: false });
    } else {
      const opt = bundle.options.find(o => o.id === body.option_id);
      if (!opt || opt.status !== "approved") throw new Fail("That time isn't on the board.");
      ids = ids.includes(opt.id) ? ids.filter(x => x !== opt.id) : ids.concat(opt.id);
      await db.upsertResponse({ activity_id: bundle.a.id, person_id: me.id,
        option_ids: ids, can_make_it: true });
    }
    return json(res, 200, { ok: true, option_ids: ids });
  }

  if (p === "/squadup/api/suggest") {
    const me = await requireViewer(body.token);
    const bundle = await activityBundle(body.activity_id);
    if (!bundle) throw new Fail("That activity is gone.", 404);
    if (bundle.a.canceled_at) throw new Fail("That plan was deleted.");
    if (planIsOver(bundle)) throw new Fail("That one already happened.");
    if (!body.starts_at) throw new Fail("Pick a time first.");

    // pending: only the creator sees it until they say yes, so a dismissed
    // idea never turns into a notification for the person who offered it
    const sugg = await db.createOption({
      activity_id: bundle.a.id, starts_at: body.starts_at, kind: "suggested",
      status: "pending", proposed_by: me.id,
      label: String(body.label || "").trim() || null
    });

    const creator = await db.getPerson(bundle.a.creator_id);
    if (creator && creator.id !== me.id) {
      await notifyAll(notifier, [creator], per => ({
        subject: `${me.name} suggested another time for ${C.fullTitle(bundle.a)}`,
        body: `${C.formatWhen(body.starts_at)}${sugg.label ? ` (“${sugg.label}”)` : ""}. ` +
              `Add it and everyone can say if it works, or just leave it.`,
        url: activityUrl(bundle.a.id, per),
        actions: [{ label: "Add it", url: replyLink(bundle.a.id, per, "approve:" + sugg.id), reply: "ADD" }],
        ask: { activity_id: bundle.a.id, option_ids: [sugg.id] }
      }));
    }
    return json(res, 200, { ok: true });
  }

  if (p === "/squadup/api/option-decide") {
    const me = await requireViewer(body.token);
    const opt = await db.getOption(String(body.option_id));
    if (!opt) throw new Fail("That suggestion is gone.", 404);
    const bundle = await activityBundle(opt.activity_id);
    if (!C.isCreator(me, bundle.a)) throw new Fail("Only whoever posted it can decide that.", 403);

    if (!body.approve) {
      await db.deleteOption(opt.id);
      return json(res, 200, { ok: true, dismissed: true });
    }
    await approveOption(me, bundle, opt);
    return json(res, 200, { ok: true });
  }

  if (p === "/squadup/api/lock") {
    const me = await requireViewer(body.token);
    const bundle = await activityBundle(body.activity_id);
    if (!bundle) throw new Fail("That activity is gone.", 404);
    if (!C.isCreator(me, bundle.a)) throw new Fail("Only whoever posted it can set the time.", 403);
    const opt = bundle.options.find(o => o.id === body.option_id);
    if (!opt || opt.status !== "approved") throw new Fail("That time isn't on the board.");

    await db.updateActivity(bundle.a.id, { locked_option_id: opt.id });
    const people = await audienceFor(bundle.a);
    await notifyAll(notifier, people, per => ({
      subject: `${C.fullTitle(bundle.a)} — ${C.formatWhen(opt.starts_at)}`,
      body: `That's the plan now: ${C.formatWhen(opt.starts_at)}.`,
      url: activityUrl(bundle.a.id, per),
      ...askMsg(bundle.a, per, [opt])
    }), { skipPersonId: me.id });
    return json(res, 200, { ok: true });
  }

  if (p === "/squadup/api/cancel") {
    const me = await requireViewer(body.token);
    const bundle = await activityBundle(body.activity_id);
    if (!bundle) throw new Fail("That activity is gone.", 404);
    if (!C.isCreator(me, bundle.a)) throw new Fail("Only whoever posted it can delete it.", 403);
    if (bundle.a.canceled_at) return json(res, 200, { ok: true });

    const reason = String(body.reason || "").trim() || null;
    await db.updateActivity(bundle.a.id,
      { canceled_at: new Date().toISOString(), canceled_reason: reason });

    const people = await audienceFor(bundle.a);
    await notifyAll(notifier, people, per => ({
      subject: `${C.fullTitle(bundle.a)} is off`,
      body: reason ? `${me.name} deleted the plan: “${reason}”` : `${me.name} deleted the plan.`,
      url: activityUrl(bundle.a.id, per)
    }), { skipPersonId: me.id });
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: "No such endpoint." });
}

/* ---------- the day-before nudge ----------
   The only time-based piece. Runs on three triggers, because a free Render
   instance sleeps when idle and a sleeping process fires no timers:
     1. an hourly interval, while the process happens to be awake
     2. GET/POST /squadup/cron/nudge, for a real scheduler (guarded by
        CRON_SECRET when one is set)
     3. opportunistically on any incoming request, throttled
   needsFinalizeNudge is time-of-day based rather than "exactly now", so a
   late run still catches anything pending that day. Silence from the creator
   changes nothing either way. */
async function runNudges(now) {
  const when = now || new Date();
  const all = await db.listActivities();
  let sent = 0;
  for (const a of all) {
    const options = await db.listOptions(a.id);
    if (!C.needsFinalizeNudge(a, options, when)) continue;

    const responses = await db.listResponses(a.id);
    const approved = options.filter(o => o.status === "approved");
    const counts = C.tally(approved, responses);
    const lines = approved.map(o =>
      `${C.formatWhen(o.starts_at)} — ${(counts[o.id] || []).length} in`).join("; ");
    const creator = await db.getPerson(a.creator_id);
    if (creator) {
      await notifyAll(notifier, [creator], per => ({
        subject: `${C.fullTitle(a)} is tomorrow`,
        body: `Where everyone landed: ${lines}. Change it or leave it.`,
        url: activityUrl(a.id, per),
        actions: [{ label: "Edit the plan", url: `${BASE}/edit/${a.id}?t=${encodeURIComponent(per.personal_token)}` }]
      }));
    }
    await db.updateActivity(a.id, { finalize_nudge_sent_at: new Date().toISOString() });
    sent++;
  }
  return sent;
}

/* Ideas past their four months are already hidden at read time; this just
   marks them archived so the table doesn't carry them forever. Quiet --
   nobody is told an idea faded. */
async function sweepIdeas(now) {
  const when = now || new Date();
  // the send log only needs the last day; keep a week for looking back
  await db.pruneSends(new Date(when.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .catch(e => console.error("send log prune failed:", e.message));
  let archived = 0;
  for (const i of await db.listIdeas()) {
    if (C.isIdeaLive(i, when)) continue;
    await db.updateIdea(i.id, { archived_at: when.toISOString() });
    archived++;
  }
  return archived;
}

let lastSweep = 0;
function sweepIfDue() {
  const now = Date.now();
  if (now - lastSweep < 10 * 60 * 1000) return;
  lastSweep = now;
  runNudges().catch(e => console.error("nudge sweep failed:", e.message));
  sweepIdeas().catch(e => console.error("idea sweep failed:", e.message));
}

/* ---------- boot ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  sweepIfDue();
  try {
    await handle(req, res, url);
  } catch (e) {
    if (e instanceof Fail) return json(res, e.code, { error: e.message });
    // a thrown request must never take the process down with it
    console.error("request failed:", req.method, url.pathname, e && e.stack || e);
    if (!res.headersSent) json(res, 500, { error: "Something broke on our end." });
  }
});

process.on("uncaughtException", e =>
  console.error("UNCAUGHT (server stayed up):", e && e.stack || e));
process.on("unhandledRejection", e =>
  console.error("UNHANDLED REJECTION (server stayed up):", e && e.stack || e));

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Squad Up listening on ${PORT} — storage: ${db.kind}, notify: ${notifier.kind}`);
  });
  setInterval(() => {
    runNudges().catch(e => console.error("nudge failed:", e.message));
    sweepIdeas().catch(e => console.error("idea sweep failed:", e.message));
  }, 60 * 60 * 1000);
}

module.exports = { server, handle, runNudges, sweepIdeas, db, notifier };
