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
        twilioSignatureOk, firstTextOff } = require("../lib/notify");
const L = require("../lib/legal");

const PORT = process.env.PORT || 3000;
const db = makeDb();
const notifier = makeNotifier();
// every email and text passes the daily limits in lib/notify.js
const guard = makeGuard(db);
useGuard(guard);
const smsOn = () => notifier.smsLive;   // Twilio set up and SQUAD_SMS_LIVE=on

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
// A guest is someone who gave just a name: no phone, no email, no messages.
const isGuest = p => !!p && !p.email && !p.phone;
// Most things need a Squad Up account; guests can only answer.
async function requireViewer(token) {
  const p = await viewerFrom(token);
  if (!p) throw new Fail("That link isn't valid any more.", 403);
  if (isGuest(p)) throw new Fail("Join Squad Up to do that. Guests can say which times work.", 403);
  return p;
}
async function requireAnyone(token) {
  const p = await viewerFrom(token);
  if (!p) throw new Fail("Add your name first.", 403);
  return p;
}
async function memberFrom(token) {
  const p = await viewerFrom(token);
  return isGuest(p) ? null : p;
}
// An email-only account hasn't tapped its confirmation link yet: nothing but
// that link goes to it. (undefined = the column isn't there yet: confirmed.)
const needsEmailConfirm = p => !!p && !!p.email && !p.phone && p.email_confirmed_at === null;

/* ---------- names ----------
   One rule, squad-wide: nobody shares a full name with anyone else, member
   or guest, ignoring capitals. Every way a name gets made goes through
   nameMatches, and the database refuses a duplicate as a backstop. (When
   there are several squads, this is the one place to scope to a squad.) */
const nameKey = n => String(n || "").replace(/\s+/g, " ").trim().toLowerCase();
async function nameMatches(name, exceptIds) {
  const want = nameKey(name), first = want.split(" ")[0], oneWord = !want.includes(" ");
  const except = new Set((exceptIds || []).filter(Boolean));
  const people = (await db.listPeople()).filter(p => !except.has(p.id));
  const exact = people.find(p => nameKey(p.name) === want) || null;
  // "Sam" when there's a "Sam K.", or "Tom Thompson" when there's a "Tom"
  const similar = people.filter(p => {
    if (p === exact) return false;
    const k = nameKey(p.name);
    return k.split(" ")[0] === first && (oneWord || !k.includes(" "));
  });
  return { exact, similar };
}
const matchOut = p => ({ id: p.id, name: p.name, guest: isGuest(p) });
// a "did you mean" answer: the page asks, then sends its choice back
function askWho(res, error, list, extra) {
  return json(res, 409, { error, match: list.map(matchOut), ...(extra || {}) });
}
// The organizer typed a name to fill in for. An existing guest with that name
// (or a close one) is offered first; a member's name is turned away, since
// they answer for themselves. Returns { person } for an existing guest,
// { name } for someone new, or null after asking the page "did you mean".
async function guestForName(res, body) {
  const name = tidyName(body.name);
  if (!name) throw new Fail("Type their name first.");
  const { exact, similar } = await nameMatches(name);
  if (exact && !isGuest(exact))
    throw new Fail(`${exact.name} has a Squad Up account, so they answer for themselves. Invite them instead.`, 409);
  if (exact && body.skipSimilar) throw new Fail(`There's already a guest called ${exact.name}. Pick them, or add a last initial.`, 409);
  if (exact && body.useExisting) return { person: exact };
  const guests = [exact, ...similar].filter(x => x && isGuest(x));
  if (guests.length && !body.skipSimilar) {
    askWho(res, exact ? `${exact.name} is already on Squad Up as a guest. Is it them?` : "Is it one of these guests?", guests, { exact: !!exact });
    return null;
  }
  return { name };
}
const TAKEN_MEMBER = n => `Someone on Squad Up already goes by ${n}. Add a last initial, like "${String(n).split(" ")[0]} K."`;

/* ---------- staying signed in ----------
   One cookie holds the person's key, so any Squad Up link opened in that
   browser knows who they are. It lasts a year and restarts on every visit. */
const COOKIE = "squadup";
const YEAR = 365 * 24 * 60 * 60;
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || "").split(";").forEach(part => {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
const secureCookie = /^https:/.test(BASE) ? "; Secure" : "";
function setSignedIn(res, token) {
  res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${YEAR}; HttpOnly; SameSite=Lax${secureCookie}`);
}
function setSignedOut(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secureCookie}`);
}

/* ---------- log-in links ----------
   "I already have an account" sends a link that signs this browser in. It's
   signed, so it can't be made up, and it carries anything the person did
   here as a guest, which moves into their account when they tap it -- even
   if the email opens in a different browser. Good for a week. */
const crypto = require("crypto");
const LINK_SECRET = process.env.SQUAD_LINK_SECRET || process.env.SUPABASE_SERVICE_KEY ||
  process.env.CRON_SECRET || crypto.randomBytes(32).toString("hex");
const b64u = s => Buffer.from(s).toString("base64url");
const sign = s => crypto.createHmac("sha256", LINK_SECRET).update(s).digest("base64url").slice(0, 32);
function loginUrl(person, opts) {
  const o = opts || {};
  const body = b64u(JSON.stringify({ p: person.id, g: o.guestId || null, k: (o.keys || []).slice(0, 30),
    n: safeNext(o.next) || null, e: Date.now() + 7 * 864e5,
    // sent to their email: tapping it shows the address is really theirs
    c: o.confirms ? nameKey(person.email) : undefined }));
  return `${BASE}/in/${body}.${sign(body)}`;
}
// The email that confirms an email-only account (and logs them in).
async function sendConfirm(person, next) {
  await notifyAll(notifier, [person], () => ({
    subject: "Confirm your email for Squad Up",
    body: "Tap to confirm this is your email. Until you do, Squad Up won't send you anything else. The link works for a week.",
    url: loginUrl(person, { next, confirms: true })
  }), { kind: "link" });
}
function readLoginLink(s) {
  const [body, sig] = String(s || "").split(".");
  if (!body || !sig || sign(body).length !== sig.length ||
      !crypto.timingSafeEqual(Buffer.from(sign(body)), Buffer.from(sig))) return null;
  try {
    const x = JSON.parse(Buffer.from(body, "base64url").toString());
    return x.e > Date.now() ? x : null;
  } catch (e) { return null; }
}
// only paths inside Squad Up, never somewhere else
const safeNext = n => {
  const s = String(n || "");
  return /^\/squadup\/[A-Za-z0-9/_?=&%.-]*$/.test(s) && !s.startsWith("//") ? s : null;
};
const cleanKeys = k => (Array.isArray(k) ? k : []).map(String).filter(x => /^[A-Za-z0-9_-]{8,80}$/.test(x)).slice(0, 30);

/* Everything a guest did moves to their account: plan answers and poll
   answers. If the account already answered the same thing, the account's
   answer stays. Then the guest is removed. */
async function mergeGuest(guest, person) {
  if (!isGuest(guest) || guest.id === person.id) return;
  for (const aid of await db.listRespondedActivityIds(guest.id)) {
    const rs = await db.listResponses(aid);
    const g = rs.find(r => r.person_id === guest.id);
    if (g && !rs.some(r => r.person_id === person.id))
      await db.upsertResponse({ activity_id: aid, person_id: person.id,
        option_ids: g.option_ids || [], can_make_it: g.can_make_it !== false });
  }
  const theirs = await db.listPollVotesForPerson(person.id);
  for (const v of await db.listPollVotesForPerson(guest.id)) {
    if (theirs.some(x => x.poll_id === v.poll_id)) await db.deletePollVote(v.id);
    else await db.updatePollVote(v.id, { person_id: person.id, name: person.name });
  }
  for (const m of await db.listIdeasForPerson(guest.id)) await db.addIdeaMember(m.idea_id, person.id);
  await db.deletePerson(guest.id);
}

// A guest who signs up keeps their own row: it becomes the account, with all
// their answers already on it. Their old guest key stops working.
async function upgradeGuest(guest, fields) {
  await db.updatePerson(guest.id, fields);
  return db.resetToken(guest.id);
}

// Can this organizer rename, merge or tidy up this guest? Yes if they added
// them, or (for guests from before that was recorded) if everything the
// guest answered is theirs.
async function canManageGuest(me, g) {
  if (!isGuest(g) || !me) return false;
  if (g.invited_by) return g.invited_by === me.id;
  for (const r of await db.listResponsesForPerson(g.id)) {
    const a = await db.getActivity(r.activity_id);
    if (!a || a.creator_id !== me.id) return false;
  }
  for (const v of await db.listPollVotesForPerson(g.id)) {
    const poll = await db.getPoll(v.poll_id);
    if (!poll || poll.creator_id !== me.id) return false;
  }
  return (await db.listIdeasForPerson(g.id)).length === 0;
}
// A guest someone added who no longer answers anything goes away entirely.
async function dropIfUnused(g) {
  if (!isGuest(g) || !g.invited_by) return;
  if ((await db.listResponsesForPerson(g.id)).length) return;
  if ((await db.listPollVotesForPerson(g.id)).length) return;
  if ((await db.listIdeasForPerson(g.id)).length) return;
  await db.deletePerson(g.id);
}

/* Once, at start-up: bring older data under the one-name rule.
   - Poll answers saved as just a name get a guest of their own (or join the
     guest who already has that name).
   - People who share a name: guests fold into the one member with that name
     (that's someone who answered as a guest, then joined), or into the
     oldest guest. Two members with one name can't be merged, so the newer
     one gets a number until they rename themselves.
   Safe to run any number of times. */
async function tidyNames() {
  const report = { linked: 0, merged: 0, renamed: 0 };
  const people = await db.listPeople();
  const keyOf = p => nameKey(p.name);
  const byKey = new Map();
  for (const p of people) { const k = keyOf(p); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(p); }
  const byAge = (x, y) => String(x.created_at).localeCompare(String(y.created_at));
  const freeName = base => { let n = 2; while (byKey.has(nameKey(`${base} ${n}`))) n++; return `${base} ${n}`; };

  for (const [k, group] of byKey) {
    if (group.length < 2) continue;
    const members = group.filter(p => !isGuest(p)).sort(byAge);
    const guests = group.filter(isGuest).sort(byAge);
    const keep = members[0] || guests[0];
    for (const g of guests) if (g.id !== keep.id && (members.length <= 1)) { await mergeGuest(g, keep); report.merged++; }
    const rest = members.length > 1 ? [...members.slice(1), ...guests] : [];
    for (const p of rest) {
      const name = freeName(p.name);
      await db.updatePerson(p.id, { name });
      byKey.set(nameKey(name), [p]);
      report.renamed++;
    }
    byKey.set(k, [keep]);
  }

  for (const poll of await db.listPolls()) {
    for (const v of await db.listPollVotes(poll.id)) {
      if (v.person_id) continue;
      const votes = await db.listPollVotes(poll.id);
      const same = (byKey.get(nameKey(v.name)) || [])[0];
      let who = null;
      if (same && isGuest(same) && !votes.some(x => x.person_id === same.id)) who = same;
      if (!who) {
        const name = same ? freeName(v.name) : tidyName(v.name) || "Guest";
        who = await db.createPerson({ name, confirmed: false, invited_by: poll.creator_id });
        byKey.set(nameKey(name), [who]);
      }
      await db.updatePollVote(v.id, { person_id: who.id, name: who.name });
      report.linked++;
    }
  }
  if (report.linked || report.merged || report.renamed) console.log("names tidied:", JSON.stringify(report));
  return report;
}
// Poll answers from before the welcome screen lived only in the browser,
// under a private key per poll. Those move to the person too.
async function claimKeys(person, keys) {
  const theirs = await db.listPollVotesForPerson(person.id);
  for (const k of cleanKeys(keys)) {
    const v = await db.getPollVoteByKey(k);
    if (!v || v.person_id || theirs.some(x => x.poll_id === v.poll_id)) continue;
    await db.updatePollVote(v.id, { person_id: person.id, name: person.name });
    theirs.push(v);
  }
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
    if (p && !isGuest(p)) { subs.push(p); have.add(p.id); }
  }
  return subs;
}

const INVITES_PER_DAY = Number(process.env.SQUAD_INVITES_PER_DAY) || 40;  // per person sending them

// A small in-memory brake for the public sign-up form, so it can't be used to
// text a pile of other people's numbers. Resets when the server restarts.
const hitLog = new Map();
function tooMany(key, max, windowMs) {
  const now = Date.now();
  const hits = (hitLog.get(key) || []).filter(t => now - t < windowMs);
  hits.push(now);
  hitLog.set(key, hits);
  if (hitLog.size > 5000) for (const [k, v] of hitLog) if (!v.length || now - v[v.length - 1] > 864e5) hitLog.delete(k);
  return hits.length > max;
}
const clientIp = req => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
const PHONE_SIGNUPS_PER_DAY = Number(process.env.SQUAD_PHONE_SIGNUPS_PER_DAY) || 30;
const PHONE_SIGNUPS_PER_IP_HOUR = Number(process.env.SQUAD_PHONE_SIGNUPS_PER_IP_HOUR) || 5;

const xmlEsc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* A text came in. Work out who sent it and what they meant, act on it, and
   return the reply to text back (or null to stay quiet). A bare answer
   applies to the last thing we asked them, within the last two weeks. */
async function handleText(from, text, twilioHandled) {
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
    return twilioHandled ? null : L.backSms(page);   // Twilio's own START reply, if it sent one
  }
  if (me.opted_out_at) return null;
  if (twilioHandled && r.kind === "help") return null;   // Twilio already answered HELP

  // replies are texts too, so they count against the same daily limits
  if (await guard.check(me, "sms", "reply")) return null;
  const say = async msg => { await guard.record(me, "sms", "reply"); return msg; };

  if (r.kind === "help" || r.kind === "unknown") return say(L.helpSms(page));

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
      .map(o => C.formatWhen(o.starts_at, a.timezone)).join(" and ");
    return say(`${wasWaiting ? L.WELCOME_YES + " " : ""}Got it, you're in for ${C.fullTitle(a)}: ${times}. ${url}`);
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
  const open = people.filter(p => !taken.has(p.id) && !p.opted_out_at && !isGuest(p))
    .map(p => ({ id: p.id, name: p.name, via: needsEmailConfirm(p) ? null : notifier.channelFor(p) }));
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
    : times.map((o, i) => ({ label: `${C.formatWhen(o.starts_at, a.timezone)} works`,
        url: replyLink(a.id, person, "opt:" + o.id), reply: String(i + 1), replyLabel: C.formatWhen(o.starts_at, a.timezone) }));
  if (times.length > 1) acts.push({ label: times.length === 2 ? "Both work" : "All work",
    url: replyLink(a.id, person, "all"), reply: times.length === 2 ? "BOTH" : "ALL" });
  acts.push({ label: "Can't make it", url: replyLink(a.id, person, "no"), quiet: true, reply: "NO" });
  return { actions: acts, ask: { activity_id: a.id, option_ids: times.map(o => o.id) } };
}

// The invite itself, for someone already on Squad Up or brand new.
function inviteMsg(me, a, approved, per, isNew) {
  const when = approved.map(o => C.formatWhen(o.starts_at, a.timezone)).join(" or ");
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

// notify: the organizer chose to tell everyone (from a text or email "ADD",
// which says so, it's always yes)
async function approveOption(me, bundle, opt, notify) {
  await db.updateOption(opt.id, { status: "approved" });
  if (!notify) return;
  const people = await audienceFor(bundle.a);
  const fresh = { ...opt, status: "approved" };
  await notifyAll(notifier, people, per => ({
    subject: `New time on the table for ${C.fullTitle(bundle.a)}`,
    body: `${C.formatWhen(opt.starts_at, bundle.a.timezone)} is now an option. Does it work for you?`,
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
    if (opt.status !== "approved") await approveOption(me, bundle, opt, true);
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
  return C.isOver(locked && locked.starts_at, new Date(), bundle.a.timezone);
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
  // a new category starts with only its maker following it: everyone else
  // sees it marked New on their page and turns it on if they want it
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
  if (!email && !phone) throw new Fail(smsOn() ? "Add a phone number or an email." : "Add an email.");
  if (!email && !smsOn()) throw new Fail("Add an email too. Texting is coming soon.");
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
        .map(p => ({ id: p.id, name: p.name, guest: isGuest(p) })),
      iAmIn: !!viewer && mine.some(m => m.person_id === viewer.id),
      mine: !!viewer && i.creator_id === viewer.id,
      expiresAt: C.ideaExpiresAt(i).toISOString()
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
// "member" means they have an account: guests (with a name only) can be
// filled in for by the organizer, and picked on the welcome screen
const publicVotes = (votes, guestIds, managed) => votes.map(v => ({ id: v.id, name: v.name,
  member: !!v.person_id && !(guestIds && guestIds.has(v.person_id)),
  pid: v.person_id && guestIds && guestIds.has(v.person_id) ? v.person_id : null,
  manage: !!(managed && managed.has(v.person_id)),
  option_ids: v.option_ids || [], maybe_ids: v.maybe_ids || [] }));
// everyone, for "Merge into…" (later: everyone in this squad)
async function mergeTargets() {
  return (await db.listPeople()).map(p => ({ id: p.id, name: p.name, guest: isGuest(p) }))
    .sort((x, y) => x.name.localeCompare(y.name));
}
const pollUrl = (id, person) => `${BASE}/f/${id}` + (person ? `?t=${encodeURIComponent(person.personal_token)}` : "");
const answeredPoll = v => !!v && ((v.option_ids || []).length > 0 || (v.maybe_ids || []).length > 0);

// The organizer's invite list for a poll, shaped like a plan's: who's been
// asked (and whether they've answered), then everyone else, category fans first.
async function pollInviteData(poll, viewer, votes) {
  const [invites, people, subs] = await Promise.all([
    db.listPollInvites(poll.id), db.listPeople(), poll.tag_id ? db.subscribersOfTag(poll.tag_id) : []
  ]);
  const byId = {};
  people.forEach(p => { byId[p.id] = p; });
  const status = id => {
    const v = votes.find(x => x.person_id === id);
    return !v ? "none" : answeredPoll(v) ? "in" : "out";
  };
  const invited = invites.sort((x, y) => String(x.invited_at).localeCompare(String(y.invited_at)))
    .filter(i => byId[i.person_id])
    .map(i => ({ id: i.person_id, name: byId[i.person_id].name, status: status(i.person_id),
                 by: (byId[i.invited_by] || {}).name || null }));
  const taken = new Set([...invites.map(i => i.person_id), poll.creator_id, viewer ? viewer.id : null,
    ...votes.filter(v => v.person_id).map(v => v.person_id)]);
  const into = new Set(subs.map(p => p.id));
  const byName = (x, y) => x.name.localeCompare(y.name);
  const open = people.filter(p => !taken.has(p.id) && !p.opted_out_at && !isGuest(p))
    .map(p => ({ id: p.id, name: p.name, via: needsEmailConfirm(p) ? null : notifier.channelFor(p) }));
  return { invited, into: open.filter(p => into.has(p.id)).sort(byName),
           others: open.filter(p => !into.has(p.id)).sort(byName) };
}

// "Gin wants to find a time for Trivia night" -- an invite to vote
function pollInviteMsg(me, poll, options, per, isNew) {
  const first = firstWord(me.name);
  const live = options.filter(o => !C.pollOptionPast(o, new Date()));
  const dates = live.slice(0, 3).map(C.pollWhen).join(", ") + (live.length > 3 ? ` and ${live.length - 3} more` : "");
  return {
    subject: `${first} wants to find a time: ${C.fullTitle(poll)}`,
    body: `${me.name} is picking a date for ${C.fullTitle(poll)}. Tap every date that works for you: ${dates}.` +
      (isNew ? ` Squad Up is how ${first}'s friends make plans. This is the only message you'll get from us unless you answer.` : ""),
    sms: `${me.name} is picking a date for ${C.fullTitle(poll)} (${dates}).` +
      (isNew ? ` Squad Up is how ${first}'s friends make plans. No more texts unless you answer.` : "") +
      " Tap the ones that work for you:",
    url: pollUrl(poll.id, per),
    firstContact: !!isNew
  };
}

async function invitesSentBy(personId, sinceIso) {
  const [a, b] = await Promise.all([db.countInvitesBy(personId, sinceIso), db.countPollInvitesBy(personId, sinceIso)]);
  return a + b;
}
const tidyName = n => String(n || "").replace(/\s+/g, " ").trim().slice(0, C.POLL_NAME_MAX);
const tidyName60 = n => String(n || "").replace(/\s+/g, " ").trim().slice(0, 60);

// A category made in the last month counts as new: people who haven't turned
// it on still see its plans, with the category marked New on their page.
const NEW_TAG_DAYS = 30;
const isNewTag = t => !!t && !!t.created_at && Date.now() - new Date(t.created_at).getTime() < NEW_TAG_DAYS * 864e5;

// Open polls for someone's home page: ones they started, answered, were
// invited to, or that are in a category they follow (or a new one).
async function pollsFor(person, now) {
  const [all, mine, invited, subs, tags] = await Promise.all([db.listPolls(), db.listPollVotesForPerson(person.id),
    db.listPollInvitesForPerson(person.id), db.listSubscriptions(person.id), db.listTags()]);
  const voted = new Map(mine.map(v => [v.poll_id, v]));
  const asked = new Set(invited.map(i => i.poll_id));
  const follows = new Set([...subs, ...tags.filter(isNewTag).map(t => t.id)]);
  const out = [];
  for (const poll of all) {
    if (poll.finalized_at) continue;
    if (poll.creator_id !== person.id && !voted.has(poll.id) && !asked.has(poll.id) &&
        !(poll.tag_id && follows.has(poll.tag_id))) continue;
    const b = await pollBundle(poll.id);
    if (!b || C.pollIsStale(b.options, now)) continue;
    const live = b.options.filter(o => !C.pollOptionPast(o, now));
    const best = C.pollRanking(live, b.votes)[0];
    out.push({ ...poll, dateCount: live.length, voterCount: b.votes.length,
      best: best && best.score > 0 ? { when: C.pollWhen(best.option), n: best.names.length, maybe: best.maybes.length } : null,
      mine: poll.creator_id === person.id,
      waitingOnMe: poll.creator_id !== person.id && !answeredPoll(voted.get(poll.id)) });
  }
  return out.sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
}

// Which of these people are guests (a name only)?
async function guestIdsOf(ids) {
  const out = new Set();
  for (const id of new Set(ids.filter(Boolean))) if (isGuest(await db.getPerson(id))) out.add(id);
  return out;
}
// What the welcome screen says about the plan or poll someone was sent.
async function eventCard(kind, id) {
  if (kind === "plan") {
    const b = await activityBundle(id);
    if (!b) return null;
    const by = await db.getPerson(b.a.creator_id);
    const times = b.options.filter(o => o.status === "approved").sort(byTime);
    const locked = times.find(o => o.id === b.a.locked_option_id) || times[0];
    return { kind, id, title: b.a.title, location: b.a.location, by: by ? by.name : null, tag: b.tag,
      when: locked ? C.formatWhen(locked.starts_at, b.a.timezone) : "", at: locked ? locked.starts_at : null,
      zone: C.zoneOf(b.a.timezone), more: Math.max(0, times.length - 1) };
  }
  const b = await pollBundle(id);
  if (!b) return null;
  const by = await db.getPerson(b.poll.creator_id);
  const live = b.options.filter(o => !C.pollOptionPast(o, new Date()));
  return { kind, id, title: b.poll.title, location: b.poll.location, by: by ? by.name : null,
    tag: b.poll.tag_id ? await db.getTag(b.poll.tag_id) : null, when: "", dates: live.length };
}
const redirect = (res, to) => { res.writeHead(302, { Location: to }); res.end(); };

// A guest's home: everything coming up, and every open poll.
async function guestHome(guest) {
  const now = new Date();
  const [tags, all, polls] = await Promise.all([db.listTags(), db.listActivities(), db.listPolls()]);
  const tagById = {};
  tags.forEach(t => { tagById[t.id] = t; });
  const activities = (await plansWithOptions(all.filter(a => !a.canceled_at), now)).filter(a => !a.past)
    .map(a => ({ ...a, pendingCount: 0 }))
    .sort((x, y) => String(x.locked ? x.locked.starts_at : "9999").localeCompare(String(y.locked ? y.locked.starts_at : "9999")));
  const mine = new Map((await db.listPollVotesForPerson(guest.id)).map(v => [v.poll_id, v]));
  const open = [];
  for (const poll of polls) {
    if (poll.finalized_at) continue;
    const b = await pollBundle(poll.id);
    if (!b || C.pollIsStale(b.options, now)) continue;
    const live = b.options.filter(o => !C.pollOptionPast(o, now));
    const best = C.pollRanking(live, b.votes)[0];
    open.push({ ...poll, dateCount: live.length, voterCount: b.votes.length,
      best: best && best.score > 0 ? { when: C.pollWhen(best.option), n: best.names.length, maybe: best.maybes.length } : null,
      mine: false, waitingOnMe: !answeredPoll(mine.get(poll.id)) });
  }
  open.sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
  return V.guestHomePage(guest, { activities, polls: open, tagById, smsOn: smsOn(), ideas: await ideasFor(guest) });
}

/* ---------- calendars ----------
   Plans have a start but no end, so calendars get two hours. Times go out
   as real instants (UTC), so every calendar app puts them in the right
   place wherever the phone is. */
const PLAN_HOURS = 2;
const icsTime = d => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
function planSpan(a, opt) {
  const start = C.stampToDate(opt.starts_at, a.timezone);
  return { start, end: new Date(start.getTime() + PLAN_HOURS * 36e5) };
}
function calendarLinks(a, opt) {
  const { start, end } = planSpan(a, opt);
  const q = new URLSearchParams({ action: "TEMPLATE", text: a.title, dates: `${icsTime(start)}/${icsTime(end)}`,
    details: `${a.note ? a.note + "\n\n" : ""}${BASE}/a/${a.id}`, location: a.location || "" });
  return { ics: `${BASE}/a/${a.id}/cal.ics`, google: `https://calendar.google.com/calendar/render?${q}` };
}
function icsFor(a, opt) {
  const { start, end } = planSpan(a, opt);
  const t = s => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Squad Up//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT", `UID:${a.id}-${opt.id}@squadup`, `DTSTAMP:${icsTime(new Date())}`,
    `DTSTART:${icsTime(start)}`, `DTEND:${icsTime(end)}`, `SUMMARY:${t(a.title)}`,
    a.location ? `LOCATION:${t(a.location)}` : null,
    `DESCRIPTION:${t((a.note ? a.note + "\n\n" : "") + BASE + "/a/" + a.id)}`, `URL:${BASE}/a/${a.id}`,
    "END:VEVENT", "END:VCALENDAR"].filter(Boolean).join("\r\n") + "\r\n";
}
let OG_PNG = null;
try { OG_PNG = require("fs").readFileSync(require("path").join(__dirname, "..", "og.png")); } catch (e) {}

/* ---------- routes ---------- */
async function handle(req, res, url) {
  const p = url.pathname.replace(/\/+$/, "") || "/squadup";
  const cookieToken = parseCookies(req)[COOKIE] || null;
  // A link's own key wins; otherwise this browser's cookie. Pages renew the
  // cookie on every visit, so it lasts a year from the last time they came.
  let token = url.searchParams.get("t");
  if (req.method === "GET" && p.startsWith("/squadup") && !p.startsWith("/squadup/cron")) {
    const who = (token && await viewerFrom(token)) || (cookieToken && await viewerFrom(cookieToken));
    token = who ? who.personal_token : null;
    if (who && !p.startsWith("/squadup/logout")) setSignedIn(res, who.personal_token);
  }

  if (p === "/health") { res.writeHead(200); return res.end("ok"); }

  // public pages: carriers and reviewers open these without a login
  if (req.method === "GET" && p === "/squadup/terms") return html(res, 200, V.termsPage());
  if (req.method === "GET" && p === "/squadup/privacy") return html(res, 200, V.privacyPage());

  // the picture shown when a Squad Up link is pasted into a text
  if (req.method === "GET" && p === "/squadup/og.png") {
    if (!OG_PNG) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" });
    return res.end(OG_PNG);
  }

  // "Add to calendar": a calendar file for Apple, Outlook and most phones
  if (req.method === "GET" && /^\/squadup\/a\/[^/]+\/cal\.ics$/.test(p)) {
    const b = await activityBundle(p.split("/")[3]);
    const locked = b && b.options.find(o => o.id === b.a.locked_option_id);
    if (!b || !locked || b.a.canceled_at) return html(res, 404, V.simplePage("Squad Up", "No such plan.", "It may have been deleted."));
    res.writeHead(200, { "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${C.fullTitle(b.a).replace(/[^A-Za-z0-9 ._-]+/g, "").trim().slice(0, 60) || "plan"}.ics"` });
    return res.end(icsFor(b.a, locked));
  }

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
  // The front door. Members go to their page; guests see what's going on;
  // anyone else gets the welcome screen (name, get updates, or log in).
  if (req.method === "GET" && (p === "/squadup" || p === "/squadup/join" || p === "/squadup/login")) {
    const viewer = await viewerFrom(token);
    if (viewer && !isGuest(viewer)) return redirect(res, `/squadup/p/${viewer.personal_token}`);
    const mode = p === "/squadup/join" ? "join" : p === "/squadup/login" ? "login" : "home";
    if (viewer && mode === "home") return html(res, 200, await guestHome(viewer));
    return html(res, 200, V.gatePage({ mode, guest: viewer, smsOn: smsOn(), next: safeNext(url.searchParams.get("next")) }));
  }

  // Log out: forget this browser, and any guest answers it was holding.
  if (req.method === "GET" && p === "/squadup/logout") {
    setSignedOut(res);
    return html(res, 200, V.logoutPage(safeNext(url.searchParams.get("next")) || "/squadup"));
  }

  // A log-in link from "I already have an account".
  if (req.method === "GET" && p.startsWith("/squadup/in/")) {
    const x = readLoginLink(p.slice("/squadup/in/".length));
    const person = x && await db.getPerson(x.p);
    if (!person) return html(res, 404, V.simplePage("Squad Up",
      "That log-in link has expired.", "Ask for a new one from the Log in link at the top of any page."));
    if (x.g) { const g = await db.getPerson(x.g); if (isGuest(g)) await mergeGuest(g, person); }
    // an emailed link: whoever opened it gets that inbox, so the address is real
    if (x.c && person.email && nameKey(person.email) === x.c && !person.email_confirmed_at)
      await db.updatePerson(person.id, { email_confirmed_at: new Date().toISOString() });
    await claimKeys(person, x.k);
    setSignedIn(res, person.personal_token);
    return redirect(res, safeNext(x.n) || `/squadup/p/${person.personal_token}`);
  }

  if (req.method === "GET" && p.startsWith("/squadup/p/")) {
    const person = await db.getPersonByToken(p.split("/")[3]);
    if (!person) return html(res, 404, V.simplePage("Squad Up",
      "This link is no longer good.", "It may have been replaced. Use Log in at the top to get a new one."));
    setSignedIn(res, person.personal_token);
    if (isGuest(person)) return html(res, 200, await guestHome(person));

    const [tags, subs, all, myInvites, answered] = await Promise.all([
      db.listTags(), db.listSubscriptions(person.id), db.listActivities(),
      db.listInvitesForPerson(person.id), db.listRespondedActivityIds(person.id)
    ]);
    // your categories, plus anything you made, were invited to, or answered
    const mineToo = new Set([...myInvites.map(i => i.activity_id), ...answered]);
    const subSet = new Set(subs);
    const tagById = {};
    tags.forEach(t => { tagById[t.id] = t; });

    // categories made in the last month that they haven't turned on yet: their
    // plans still show, and the category is marked New so they can pick it
    const newTags = new Set(tags.filter(t => isNewTag(t) && !subSet.has(t.id) && t.created_by !== person.id).map(t => t.id));
    const visible = all.filter(a => subSet.has(a.tag_id) || newTags.has(a.tag_id) || a.creator_id === person.id || mineToo.has(a.id));
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
    // what "Delete my account" would call off
    const upcomingMine = (await plansWithOptions(all.filter(a => a.creator_id === person.id && !a.canceled_at), new Date()))
      .filter(a => !a.past).map(a => C.fullTitle(a));
    const pollsMine = polls.filter(x => x.mine).map(x => C.fullTitle(x));
    const ideasMine = ideas.filter(i => i.mine).map(i => i.title);
    return html(res, 200, V.personPage(person,
      { tags, subs, activities: withOpts, ideas, polls, tagById, baseUrl: BASE, smsOn: smsOn(), newTags: [...newTags],
        awaitingOptIn: !person.confirmed_at && !person.opted_out_at, confirmEmail: needsEmailConfirm(person),
        leaving: { plans: upcomingMine, polls: pollsMine, ideas: ideasMine } }));
  }

  if (req.method === "GET" && p === "/squadup/new") {
    const person = await memberFrom(token);
    if (!person) return html(res, 403, V.simplePage("Squad Up",
      "You'll need your own link for that.", "Open the link we emailed you, then try again."));
    let idea = null;
    const ideaId = url.searchParams.get("idea");
    if (ideaId) {
      const i = await db.getIdea(ideaId);
      if (C.isIdeaLive(i, new Date())) {
        const people = [];
        for (const m of await db.listIdeaMembers(i.id)) {
          const per = await db.getPerson(m.person_id);
          if (per && per.id !== person.id) people.push({ name: per.name, guest: isGuest(per) });
        }
        idea = { ...i, memberCount: people.length + 1, members: people };
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
        const runner = ranked.find(r => r !== pick && r.score > 0 &&
          C.pollStart(r.option) !== C.pollStart(pick.option));
        fromPoll = { id: b.poll.id, optionId: pick.option.id, backupOptionId: runner ? runner.option.id : null,
          when: C.pollWhen(pick.option), n: pick.names.length, maybe: pick.maybes.length, of: b.votes.length };
        prefill = { title: b.poll.title, location: b.poll.location, note: b.poll.note, tag_id: b.poll.tag_id,
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
    const person = await memberFrom(token);
    if (!person) return html(res, 403, V.simplePage("Squad Up",
      "You'll need your own link for that.", "Open the link we emailed you, then try again."));
    const ideaId = url.searchParams.get("idea");
    return html(res, 200, V.startPage(person, ideaId));
  }

  if (req.method === "GET" && p === "/squadup/find") {
    const person = await memberFrom(token);
    if (!person) return html(res, 403, V.simplePage("Squad Up",
      "You'll need your own link for that.", "Open the link we emailed you, then try again."));
    let idea = null;
    const ideaId = url.searchParams.get("idea");
    if (ideaId) {
      const i = await db.getIdea(ideaId);
      if (C.isIdeaLive(i, new Date())) idea = i;
    }
    return html(res, 200, V.findPage(person, await db.listTags(), { idea, today: C.dateOf(C.toLocalStamp(new Date())) }));
  }

  // the organizer's edit page for a poll
  if (req.method === "GET" && p.startsWith("/squadup/fedit/")) {
    const person = await memberFrom(token);
    const b = await pollBundle(p.split("/")[3]);
    if (!b) return html(res, 404, V.simplePage("Squad Up", "This one's gone.", "It may have been deleted."));
    if (!person || person.id !== b.poll.creator_id) return html(res, 403, V.simplePage("Squad Up",
      "Only whoever started it can edit it.", "Open your own link and try again."));
    if (b.poll.finalized_at) {
      res.writeHead(302, { Location: `/squadup/f/${b.poll.id}?t=${encodeURIComponent(person.personal_token)}` });
      return res.end();
    }
    const now = new Date();
    const counts = {};
    b.options.forEach(o => { counts[o.id] = b.votes.filter(v => (v.option_ids || []).includes(o.id) ||
      (v.maybe_ids || []).includes(o.id)).length; });
    return html(res, 200, V.pollEditPage(person, b.poll, await db.listTags(), {
      options: b.options.map(o => ({ ...o, when: C.pollWhen(o), past: C.pollOptionPast(o, now), answers: counts[o.id] })),
      today: C.dateOf(C.toLocalStamp(now)) }));
  }

  // A Find-a-time poll. Works for anyone with the link: Squad Up members are
  // recognized by their own link, everyone else answers with just a name.
  if (req.method === "GET" && p.startsWith("/squadup/f/")) {
    const b = await pollBundle(p.split("/")[3]);
    if (!b) return html(res, 404, V.simplePage("Squad Up",
      "This one's gone.", "Whoever started it may have deleted it."));
    const viewer = await viewerFrom(token);
    // nobody we know yet: the welcome screen first, unless it's already decided
    if (!viewer && !b.poll.finalized_at) return html(res, 200, V.gatePage({ mode: "event",
      event: await eventCard("poll", b.poll.id), smsOn: smsOn(), url: `${BASE}/f/${b.poll.id}` }));
    const creator = await db.getPerson(b.poll.creator_id);
    let plan = null;
    if (b.poll.activity_id) {
      const ab = await activityBundle(b.poll.activity_id);
      if (ab && !ab.a.canceled_at) {
        const locked = ab.options.find(o => o.id === ab.a.locked_option_id);
        plan = { id: ab.a.id, title: C.fullTitle(ab.a), when: locked ? C.formatWhen(locked.starts_at, ab.a.timezone) : "" };
      }
    }
    const now = new Date();
    const isCreator = !!viewer && viewer.id === b.poll.creator_id;
    const guestIds = await guestIdsOf(b.votes.map(v => v.person_id));
    const managed = new Set();
    if (isCreator) for (const id of guestIds) if (await canManageGuest(viewer, await db.getPerson(id))) managed.add(id);
    return html(res, 200, V.pollPage(b.poll, {
      options: b.options.map(o => ({ ...o, when: C.pollWhen(o), past: C.pollOptionPast(o, now) })),
      votes: publicVotes(b.votes, guestIds, managed), viewer, guest: isGuest(viewer), creator, plan, isCreator,
      people: isCreator && !b.poll.finalized_at ? await mergeTargets() : null,
      tag: b.poll.tag_id ? await db.getTag(b.poll.tag_id) : null,
      invites: isCreator && !b.poll.finalized_at ? await pollInviteData(b.poll, viewer, b.votes) : null,
      invitedNote: url.searchParams.has("invited")
        ? { n: +url.searchParams.get("invited") || 0, held: +url.searchParams.get("held") || 0,
            unreachable: +url.searchParams.get("unreachable") || 0,
            waiting: +url.searchParams.get("waiting") || 0 } : null,
      smsOn: smsOn(), saved: url.searchParams.get("saved"),
      myVote: viewer ? (b.votes.find(v => v.person_id === viewer.id) || null) : null,
      created: url.searchParams.has("created"),
      shareUrl: `${BASE}/f/${b.poll.id}`, today: C.dateOf(C.toLocalStamp(now))
    }));
  }

  if (req.method === "GET" && p.startsWith("/squadup/edit/")) {
    const person = await memberFrom(token);
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
                 primary: locked ? locked.starts_at : "", backup: other ? other.starts_at : "",
                 timezone: C.zoneOf(a.timezone) }
    }));
  }

  if (req.method === "GET" && p === "/squadup/past") {
    const person = await memberFrom(token);
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
    const person = await memberFrom(token);
    if (!person) return html(res, 404, V.simplePage("Squad Up",
      "That link didn't work.", "Open Squad Up from your own link instead."));
    return html(res, 200, V.stopPage(person));
  }

  // one-tap answer from an email: show a page that saves it, then the plan
  if (req.method === "GET" && p.startsWith("/squadup/r/")) {
    const id = p.split("/")[3];
    const person = await memberFrom(token);
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
    const lockedNow = options.find(o => o.id === a.locked_option_id);
    const closedNow = !!a.canceled_at || C.isOver(lockedNow && lockedNow.starts_at, new Date(), a.timezone);
    if (!viewer && !closedNow) return html(res, 200, V.gatePage({ mode: "event",
      event: await eventCard("plan", a.id), smsOn: smsOn(), url: `${BASE}/a/${a.id}` }));
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
    const invites = viewer && !isGuest(viewer) ? await inviteData(a, viewer, responses) : null;
    // everyone's answers, so the organizer can fill in for guests in place
    const answers = [];
    for (const r of responses) {
      const per = peopleById[r.person_id];
      answers.push({ person_id: r.person_id, name: (per || {}).name || "", guest: isGuest(per),
        manage: isCreator && isGuest(per) && await canManageGuest(viewer, per),
        option_ids: r.option_ids || [], can_make_it: r.can_make_it !== false });
    }
    return html(res, 200, V.activityPage(a, {
      people: isCreator && !closedNow ? await mergeTargets() : null,
      calendar: lockedNow && !closedNow ? calendarLinks(a, lockedNow) : null,
      invites, smsOn: smsOn(), guest: isGuest(viewer), answers, shareUrl: `${BASE}/a/${a.id}`,
      invitedNote: url.searchParams.has("invited")
        ? { n: +url.searchParams.get("invited") || 0, held: +url.searchParams.get("held") || 0,
            unreachable: +url.searchParams.get("unreachable") || 0,
            waiting: +url.searchParams.get("waiting") || 0 } : null,
      viewer, isCreator, options: shown, responses, counts, tag, creator,
      over: C.isOver(lockedOpt && lockedOpt.starts_at, new Date(), a.timezone),
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
  // pages send their key; if one doesn't, this browser's cookie stands in
  // (JSON only: a cross-site form can't borrow it)
  if (!body.token && cookieToken && /json/.test(req.headers["content-type"] || "")) body.token = cookieToken;
  const browserGuest = async () => { const g = await viewerFrom(cookieToken); return isGuest(g) ? g : null; };

  // "Continue as a guest": just a name. A name that's already on Squad Up
  // asks first: "Are you Kayla?" picks up that guest's answers; a member's
  // name gets a log-in link instead; anyone else adds a last initial.
  if (p === "/squadup/api/guest") {
    if (tooMany("guest:" + clientIp(req), 60, 36e5)) throw new Fail("Lots of new guests right now. Try again in a bit.", 429);
    let person = null;
    if (body.claim) {
      person = await db.getPerson(String(body.claim.id || body.claim || ""));
      if (!isGuest(person)) throw new Fail("We couldn't find that name. Try typing it again.", 404);
    } else {
      const name = tidyName(body.name);
      if (!name) throw new Fail("Type your name first.");
      const { exact, similar: near } = await nameMatches(name);
      // people they've already said they aren't
      const notIds = new Set((Array.isArray(body.notIds) ? body.notIds : []).map(String));
      const similar = near.filter(x => !notIds.has(x.id));
      if (exact) return askWho(res, isGuest(exact) ? `Are you ${exact.name}?`
        : `${exact.name} has a Squad Up account.`, [exact], { exact: true });
      if (similar.length && !body.skipSimilar) return askWho(res, "Is one of these you?", similar);
      person = await db.createPerson({ name, confirmed: false });
    }
    await claimKeys(person, body.keys);
    setSignedIn(res, person.personal_token);
    return json(res, 200, { ok: true, name: person.name });
  }

  // "I already have an account": send their log-in link. The answer is the
  // same whether or not we found them, so nobody can check who's signed up.
  if (p === "/squadup/api/login") {
    const raw = String(body.contact || "").trim();
    if (!raw) throw new Fail("Type your phone number or email.");
    const isEmail = raw.includes("@");
    const phone = isEmail ? null : C.normalizePhone(raw);
    if (isEmail ? !C.EMAIL_RE.test(raw) : !phone) throw new Fail(isEmail ? "That email doesn't look right." : "That phone number doesn't look right.");
    if (tooMany("login:" + clientIp(req), 12, 36e5) || tooMany("login:" + raw.toLowerCase(), 4, 36e5))
      throw new Fail("That's a lot of tries. Wait a bit and try again.", 429);
    const person = isEmail ? await db.getPersonByEmail(raw) : await db.getPersonByPhone(phone);
    if (person && !isGuest(person)) {
      const g = await browserGuest();
      const url = loginUrl(person, { guestId: g && g.id, keys: cleanKeys(body.keys), next: body.next,
        confirms: isEmail && notifier.channelFor(person) !== "sms" });
      await notifyAll(notifier, [person], () => ({
        subject: "Your Squad Up log-in link",
        body: "Tap to log in to Squad Up on this device. The link works for a week.",
        sms: "Your Squad Up log-in link:", url
      }), { kind: "link" });
    }
    return json(res, 200, { ok: true, textingOff: !isEmail && !smsOn() });
  }

  if (p === "/squadup/api/signup") {
    const name = tidyName60(body.name);
    const { email, phone } = contactFields(body);
    if (!name) throw new Fail("Add your name.");
    if (body.agree !== true) throw new Fail("Please agree to the Terms and Privacy Policy.");
    // a number only goes on file with the text box checked: that's the consent
    if (phone && body.sms_consent !== true)
      throw new Fail("Check the \"Text me\" box to get texts, or take the phone number out.");

    // Never hand back an existing person's link just because someone typed
    // their address or number -- send it to them instead.
    const existing = (email && await db.getPersonByEmail(email)) || (phone && await db.getPersonByPhone(phone));
    if (existing && !isGuest(existing)) {
      // already on Squad Up: no error, just their log-in link (carrying
      // anything they did here as a guest)
      const g = await browserGuest();
      const byEmail = notifier.channelFor(existing) !== "sms";
      await notifyAll(notifier, [existing], () => ({
        subject: "Your Squad Up log-in link",
        body: "Looks like you're already on Squad Up. Tap to log in on this device. The link works for a week.",
        sms: "You're already on Squad Up. Your log-in link:",
        url: loginUrl(existing, { guestId: g && g.id, keys: cleanKeys(body.keys), next: body.next, confirms: byEmail })
      }), { kind: "link" });
      return json(res, 200, { emailed: true, via: byEmail ? "email" : "text" });
    }

    // The name: this browser's own guest, or a guest they say is them, is
    // fine (that row becomes the account). Anyone else's name isn't.
    const mine = await browserGuest();
    let claimed = null;
    if (body.claim_guest) {
      claimed = await db.getPerson(String(body.claim_guest));
      if (!isGuest(claimed)) throw new Fail("We couldn't find that guest. Try again.", 404);
    }
    const { exact, similar } = await nameMatches(name, [mine && mine.id, claimed && claimed.id]);
    if (exact && !isGuest(exact)) throw new Fail(TAKEN_MEMBER(exact.name) +
      " If that's you, use \"I already have an account\".", 409);
    const guestsLike = [exact, ...similar].filter(x => x && isGuest(x));
    if (exact && body.skipSimilar) throw new Fail(`Someone already answered as ${exact.name}. Add a last initial.`, 409);
    if (!claimed && guestsLike.length && !body.skipSimilar)
      return askWho(res, "Did you already answer some plans as a guest?", guestsLike, { exact: !!exact });

    if (phone && (tooMany("ip:" + clientIp(req), PHONE_SIGNUPS_PER_IP_HOUR, 36e5) || tooMany("phones", PHONE_SIGNUPS_PER_DAY, 864e5)))
      throw new Fail("Lots of sign-ups right now. Try again a bit later, or use email.", 429);

    // email-only accounts confirm their address before anything else is sent
    const confirmEmail = !!email && !phone;
    const now = new Date().toISOString();
    const base = claimed || mine;
    let person;
    if (base) {
      person = await upgradeGuest(base, { name, email, phone, confirmed_at: now, invited_by: null,
        email_confirmed_at: confirmEmail ? null : now });
      // both: this browser's guest and the one they picked
      if (claimed && mine && mine.id !== claimed.id) await mergeGuest(mine, person);
    } else {
      person = await db.createPerson({ name, email, phone, email_confirmed: !confirmEmail });
    }
    await claimKeys(person, body.keys);
    setSignedIn(res, person.personal_token);
    let tagIds = Array.isArray(body.tags) ? body.tags.slice() : [];

    if (body.activity_id) {
      const a = await db.getActivity(body.activity_id);
      // signing up through an activity link subscribes to that one category
      // only -- everything at once would be a rough first impression
      if (a && !tagIds.includes(a.tag_id)) tagIds.push(a.tag_id);
    }
    for (const t of tagIds) await db.setSubscription(person.id, t, true);

    if (body.activity_id) {
      const had = (await db.listResponses(body.activity_id)).some(r => r.person_id === person.id);
      if (!had) await db.upsertResponse({
        activity_id: body.activity_id, person_id: person.id,
        option_ids: [], can_make_it: true
      });
    }

    if (confirmEmail) await sendConfirm(person, body.next);
    // with a number on file, this first text is the opt-in confirmation: it
    // names the program and says how often, how to get help, and how to stop
    else await notifyAll(notifier, [person], () => ({
      subject: "Your Squad Up link",
      body: "This link is you. Bookmark it — there's no password to remember.",
      sms: phone ? `${L.WELCOME_SMS} Your link, no password:` : undefined,
      url: `${BASE}/p/${person.personal_token}`
    }), { kind: "link" });

    return json(res, 200, {
      token: person.personal_token, url: `${BASE}/p/${person.personal_token}`, confirmEmail
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
    if (body.consent !== true) throw new Fail("Check the box to turn messages on.");
    const wasWaiting = !me.confirmed_at;
    await confirmPerson(me);
    // the opt-in confirmation text (program name, frequency, HELP, STOP)
    if (wasWaiting && notifier.channelFor(me) === "sms") {
      await notifyAll(notifier, [me], () => ({
        subject: "Welcome to Squad Up", body: "You're set to hear about plans.",
        sms: L.WELCOME_SMS, url: link(me)
      }), { kind: "welcome" });
    }
    return json(res, 200, { ok: true });
  }

  // "Edit your info" on the home page: fix a name, number or email
  if (p === "/squadup/api/me") {
    const me = await requireViewer(body.token);
    const name = tidyName60(body.name);
    if (!name) throw new Fail("Add your name.");
    const { email, phone } = contactFields(body);
    // a new number needs the same "Text me" consent as signing up
    if (phone && phone !== me.phone && body.sms_consent !== true)
      throw new Fail("Check the \"Text me\" box to add this number, or take it out.");
    const byEmail = email ? await db.getPersonByEmail(email) : null;
    if (byEmail && byEmail.id !== me.id) throw new Fail("That email is already on Squad Up for someone else.");
    const byPhone = phone ? await db.getPersonByPhone(phone) : null;
    if (byPhone && byPhone.id !== me.id) throw new Fail("That number is already on Squad Up for someone else.");
    // a new name follows the one-name rule; a guest with it may be them
    let claimed = null;
    if (nameKey(name) !== nameKey(me.name)) {
      if (body.claim_guest) {
        claimed = await db.getPerson(String(body.claim_guest));
        if (!isGuest(claimed) || nameKey(claimed.name) !== nameKey(name)) throw new Fail("We couldn't find that guest.", 404);
      }
      const { exact } = await nameMatches(name, [me.id, claimed && claimed.id]);
      if (exact && !isGuest(exact)) throw new Fail(TAKEN_MEMBER(exact.name), 409);
      if (exact) return askWho(res, `${exact.name} answered some plans as a guest. Is that you?`, [exact], { exact: true });
    }
    if (claimed) await mergeGuest(claimed, me);
    const patch = { name, email, phone };
    // a new email address hasn't been confirmed (it matters once there's no phone)
    const emailChanged = nameKey(email) !== nameKey(me.email);
    if (emailChanged) patch.email_confirmed_at = null;
    const updated = await db.updatePerson(me.id, patch);
    if (needsEmailConfirm(updated) && (emailChanged || !needsEmailConfirm(me))) await sendConfirm(updated);
    return json(res, 200, { ok: true, confirmEmail: needsEmailConfirm(updated) });
  }

  // "Send it again" on the confirm-your-email banner
  if (p === "/squadup/api/confirm-resend") {
    const me = await requireViewer(body.token);
    if (!needsEmailConfirm(me)) return json(res, 200, { ok: true, already: true });
    if (tooMany("confirm:" + me.id, 3, 36e5)) throw new Fail("We just sent one. Check your inbox (and spam), or try again in an hour.", 429);
    await sendConfirm(me);
    return json(res, 200, { ok: true });
  }

  // "Log out of all other devices": a new key; this browser keeps working
  if (p === "/squadup/api/reset-link") {
    const me = await requireViewer(body.token);
    const updated = await db.resetToken(me.id);
    setSignedIn(res, updated.personal_token);
    return json(res, 200, { url: `${BASE}/p/${updated.personal_token}` });
  }

  // "Delete my account". Plans and polls they're organizing that haven't
  // happened yet are called off (everyone's told), their ideas come off the
  // list, and their answers go. Past plans stay, with no organizer.
  if (p === "/squadup/api/delete-account") {
    const me = await requireViewer(body.token);
    if (body.confirm !== true) throw new Fail("Tap Delete my account to confirm.");
    const now = new Date();
    for (const a of await db.listActivities()) {
      if (a.creator_id !== me.id || a.canceled_at) continue;
      const b = await activityBundle(a.id);
      if (planIsOver(b)) continue;
      await db.updateActivity(a.id, { canceled_at: now.toISOString(), canceled_reason: `${me.name} left Squad Up.` });
      const people = await audienceFor(a);
      await notifyAll(notifier, people, per => ({
        subject: `${C.fullTitle(a)} is off`,
        body: `${me.name} left Squad Up, so the plan they were organizing is off.`,
        url: activityUrl(a.id, per)
      }), { skipPersonId: me.id });
    }
    for (const poll of await db.listPolls()) {
      if (poll.creator_id !== me.id || poll.finalized_at) continue;
      const b = await pollBundle(poll.id);
      await db.updatePoll(poll.id, { canceled_at: now.toISOString() });
      if (!b || C.pollIsStale(b.options, now)) continue;
      const ids = new Set([...b.votes.map(v => v.person_id), ...(await db.listPollInvites(poll.id)).map(i => i.person_id)]);
      const people = [];
      for (const id of ids) { const per = id && id !== me.id ? await db.getPerson(id) : null; if (per && !isGuest(per)) people.push(per); }
      await notifyAll(notifier, people, per => ({
        subject: `Finding a time for ${C.fullTitle(poll)} is off`,
        body: `${me.name} left Squad Up, so the vote they started is closed.`,
        url: link(per)
      }));
    }
    for (const v of await db.listPollVotesForPerson(me.id)) await db.deletePollVote(v.id);
    // the last word goes to them, so they know it happened
    await notifyAll(notifier, [me], () => ({
      subject: "Your Squad Up account is deleted",
      body: "Your account and your answers are gone. You're welcome back any time.",
      sms: "Your Squad Up account is deleted. You won't get any more texts.",
      url: `${BASE}`
    }), { kind: "link" });
    await db.deletePerson(me.id);
    setSignedOut(res);
    return json(res, 200, { ok: true });
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
      note: String(body.note || "").trim() || null,
      timezone: C.zoneOf(body.timezone)
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
        if (!per || per.id === me.id) continue;
        // guests can't be messaged: they go on the plan with no times yet, so
        // the organizer sees them under "Fill in for others" and can ask
        if (isGuest(per)) { await db.upsertResponse({ activity_id: a.id, person_id: per.id, option_ids: [], can_make_it: true }); continue; }
        people.push(per); have.add(per.id);
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
      // everyone asked to vote hears it's set too, answered or not
      const pollAsked = (await db.listPollInvites(fromPoll.poll.id))
        .filter(i => !fromPoll.votes.some(v => v.person_id === i.person_id))
        .map(i => ({ person_id: i.person_id, option_ids: [] }));
      // "works" and "if need be" both count: anyone who said they could make
      // the chosen date is on the plan
      const said = (v, o) => !!o && ((v.option_ids || []).includes(o.id) || (v.maybe_ids || []).includes(o.id));
      for (const v of [...fromPoll.votes, ...pollAsked]) {
        if (v.person_id === me.id) continue;
        const ids = [];
        if (sameDay(pickOpt, body.primary) && said(v, pickOpt)) ids.push(primary.id);
        if (created[1] && sameDay(backOpt, body.backup) && said(v, backOpt)) ids.push(created[1].id);
        let per = v.person_id ? await db.getPerson(v.person_id) : null;
        // a name with no person behind it (filled in by the organizer, or from
        // before guests had their own row): make them a guest on the plan
        if (!per) {
          const name = tidyName(v.name);
          if (!ids.length || !name) continue;
          per = await db.createPerson({ name, confirmed: false });
          if (v.id) await db.updatePollVote(v.id, { person_id: per.id });
        }
        if (ids.length) await db.upsertResponse({ activity_id: a.id, person_id: per.id, option_ids: ids, can_make_it: true });
        await db.addInvite({ activity_id: a.id, person_id: per.id, invited_by: me.id });
        voted.set(per.id, ids.length > 0);
        if (!have.has(per.id) && !isGuest(per)) { people.push(per); have.add(per.id); }
      }
      await db.updatePoll(fromPoll.poll.id, { finalized_at: new Date().toISOString(), activity_id: a.id });
    }

    const named = C.fullTitle({ title, location });
    const when = created.length > 1
      ? `${C.formatWhen(body.primary, a.timezone)} (backup ${C.formatWhen(body.backup, a.timezone)})`
      : C.formatWhen(body.primary, a.timezone);
    await notifyAll(notifier, people, per => ({
      subject: `${named} — ${C.formatWhen(body.primary, a.timezone)}`,
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
    if (body.timezone && C.zoneOk(body.timezone)) patch.timezone = body.timezone;
    const zoneMoved = !!patch.timezone && C.zoneOf(patch.timezone) !== C.zoneOf(a.timezone);
    const zoneNow = patch.timezone || a.timezone;

    const locked = options.find(o => o.id === a.locked_option_id);
    // Same day, new time: a tweak. Everyone's answers stay and nobody is
    // messaged. A different day is a new plan for people: answers for the old
    // day are cleared and everyone hears about it.
    const sameDay = (x, y) => C.dateOf(x) === C.dateOf(y);
    if (locked && body.primary !== locked.starts_at) {
      const moved = await db.updateOption(locked.id, { starts_at: body.primary });
      if (!sameDay(body.primary, locked.starts_at)) {
        await clearAnswersFor(a, locked.id, true);
        patch.finalize_nudge_sent_at = null;      // a new day deserves a new reminder
        changed.push(`Now ${C.formatWhen(body.primary, zoneNow)}.`);
        timesToAsk.push(moved);
      }
    }

    const other = otherCreatorTime(a, options);
    if (body.backup && other && body.backup !== other.starts_at) {
      const moved = await db.updateOption(other.id, { starts_at: body.backup });
      if (!sameDay(body.backup, other.starts_at)) {
        await clearAnswersFor(a, other.id, true);
        changed.push(`Backup is now ${C.formatWhen(body.backup, zoneNow)}.`);
        timesToAsk.push(moved);
      }
    } else if (body.backup && !other) {
      const added = await db.createOption({ activity_id: a.id, starts_at: body.backup,
        kind: "backup", status: "approved", proposed_by: me.id, label: null });
      changed.push(`Added a backup: ${C.formatWhen(body.backup, zoneNow)}.`);
      timesToAsk.push(added);
    } else if (!body.backup && other) {
      await clearAnswersFor(a, other.id, false);
      await db.deleteOption(other.id);
      changed.push(`The backup time (${C.formatWhen(other.starts_at, a.timezone)}) is off.`);
    }
    if ((a.location || null) !== location) {
      changed.push(location ? `Now at ${location}.` : "The location changed.");
    }
    if (zoneMoved && !changed.some(x => x.startsWith("Now "))) changed.push(`Now ${C.formatWhen(body.primary, zoneNow)}.`);

    const updated = await db.updateActivity(a.id, patch);
    if (timesToAsk.length) await markCreatorIn(a, timesToAsk.map(o => o.id));

    // Renames, notes and categories never go out. Changes to the day or place
    // go out only if the organizer chose "Save and tell everyone".
    if (changed.length && body.notify === true) {
      const people = await audienceFor(updated);
      await notifyAll(notifier, people, per => ({
        subject: `${C.fullTitle(updated)} changed`,
        body: `${me.name} made a change. ${changed.join(" ")}`,
        url: activityUrl(a.id, per),
        ...askMsg(updated, per, timesToAsk)
      }), { skipPersonId: me.id });
    }
    return json(res, 200, { ok: true, notified: changed.length > 0 && body.notify === true, changed: changed.length > 0 });
  }

  /* ---- Find a time ---- */
  if (p === "/squadup/api/poll") {
    const me = await requireViewer(body.token);
    const title = String(body.title || "").trim().slice(0, 120);
    if (!title) throw new Fail("Give it a name.");
    const parsed = C.parsePollOptions(body.options, new Date());
    if (parsed.error) throw new Fail(parsed.error);
    const idea = body.idea_id ? await liveIdea(body.idea_id) : null;
    const { tag, fresh: freshTag } = await resolveTag(me, body);
    await db.setSubscription(me.id, tag.id, true);
    const poll = await db.createPoll({ creator_id: me.id, title, tag_id: tag.id,
      location: String(body.location || "").trim().slice(0, C.LOCATION_MAX) || null,
      note: String(body.note || "").trim().slice(0, 280) || null, idea_id: idea ? idea.id : null });
    const options = await db.addPollOptions(poll.id, parsed.options);
    // people who follow the category hear about it, like a new plan
    const followers = await db.subscribersOfTag(tag.id);
    const named = C.fullTitle(poll);
    const dates = C.sortPollOptions(options);
    const list = dates.slice(0, 3).map(C.pollWhen).join(", ") + (dates.length > 3 ? ` and ${dates.length - 3} more` : "");
    await notifyAll(notifier, followers, per => ({
      subject: `Finding a time: ${named}`,
      body: `${me.name} is picking a date for ${named}${freshTag ? ` under a new category, ${tag.name}` : ""}. ` +
        `Tap every date that works for you: ${list}.`,
      sms: `${me.name} is picking a date for ${named} (${list}). Tap the ones that work for you:`,
      url: pollUrl(poll.id, per)
    }), { skipPersonId: me.id });
    return json(res, 200, { id: poll.id, url: `${BASE}/f/${poll.id}` });
  }

  if (p === "/squadup/api/poll-vote") {
    const b = await pollBundle(body.poll_id);
    if (!b) throw new Fail("This one's gone.", 404);
    if (b.poll.finalized_at) throw new Fail("It's already been made a plan.");
    const now = new Date();
    const open = new Set(b.options.filter(o => !C.pollOptionPast(o, now)).map(o => o.id));
    const clean = list => [...new Set((Array.isArray(list) ? list : []).map(String))].filter(id => open.has(id));
    const ids = clean(body.option_ids);
    const maybes = clean(body.maybe_ids).filter(id => !ids.includes(id));   // a yes beats an "if need be"
    const me = await viewerFrom(body.token);
    if (me) {
      const mine = b.votes.find(v => v.person_id === me.id);
      const v = mine ? await db.updatePollVote(mine.id, { option_ids: ids, maybe_ids: maybes, name: me.name })
        : await db.createPollVote({ poll_id: b.poll.id, name: me.name, person_id: me.id,
            voter_key: C.newToken(), option_ids: ids, maybe_ids: maybes });
      // picking dates counts as saying you're in, like answering a plan
      if ((ids.length || maybes.length) && !isGuest(me)) await confirmPerson(me, me.confirmed_at ? null : b.poll.tag_id);
      return json(res, 200, { vote_id: v.id, name: v.name });
    }
    // a guest: their phone keeps a key that lets them change their own answers
    const key = String(body.key || "");
    const theirs = key && b.votes.find(v => v.voter_key === key);
    if (theirs) {
      const v = await db.updatePollVote(theirs.id, { option_ids: ids, maybe_ids: maybes });
      return json(res, 200, { vote_id: v.id, name: v.name });
    }
    const name = tidyName(body.name);
    if (!name) throw new Fail("Add your name first.");
    if ((await nameMatches(name)).exact)
      throw new Fail(`Someone already goes by "${name}". If that's you, pick your name. If not, add a last initial.`, 409);
    if (b.votes.length >= C.POLL_MAX_VOTERS) throw new Fail("This one's full.", 429);
    const fresh = C.newToken();
    const g = await db.createPerson({ name, confirmed: false });
    const v = await db.createPollVote({ poll_id: b.poll.id, name, person_id: g.id, voter_key: fresh,
      option_ids: ids, maybe_ids: maybes });
    return json(res, 200, { vote_id: v.id, name: v.name, key: fresh });
  }

  // "Are you Sebastian?" -- a guest coming back on a new phone or tab picks
  // their name and gets their answers back to change. Anyone with the link
  // can do this; it's a friends' poll, not a vault.
  if (p === "/squadup/api/poll-claim") {
    const b = await pollBundle(body.poll_id);
    if (!b) throw new Fail("This one's gone.", 404);
    if (b.poll.finalized_at) throw new Fail("It's already been made a plan.");
    const v = b.votes.find(x => x.id === String(body.vote_id || "") && !x.person_id);
    if (!v) throw new Fail("We couldn't find that answer. Try typing your name again.", 404);
    return json(res, 200, { vote_id: v.id, name: v.name, key: v.voter_key });
  }

  // The organizer fills in answers for people who replied by text or in person:
  // add someone new by name, or change any guest's dates.
  if (p === "/squadup/api/poll-guest") {
    const me = await requireViewer(body.token);
    const b = await pollBundle(body.poll_id);
    if (!b) throw new Fail("This one's gone.", 404);
    if (b.poll.creator_id !== me.id) throw new Fail("Only whoever started it can fill in answers for others.", 403);
    if (b.poll.finalized_at) throw new Fail("It's already been made a plan.");
    const now = new Date();
    const open = new Set(b.options.filter(o => !C.pollOptionPast(o, now)).map(o => o.id));
    const clean = list => [...new Set((Array.isArray(list) ? list : []).map(String))].filter(id => open.has(id));
    const ids = clean(body.option_ids);
    const maybes = clean(body.maybe_ids).filter(id => !ids.includes(id));
    if (body.vote_id) {
      const theirs = b.votes.find(v => v.id === String(body.vote_id));
      const per = theirs && theirs.person_id ? await db.getPerson(theirs.person_id) : null;
      if (!theirs || (per && !isGuest(per)))
        throw new Fail("That answer is gone, or it belongs to someone with a Squad Up account.", 404);
      // take a guest off this poll
      if (body.remove) {
        await db.deletePollVote(theirs.id);
        if (per) await dropIfUnused(per);
        return json(res, 200, { ok: true, removed: true });
      }
      const v = await db.updatePollVote(theirs.id, { option_ids: ids, maybe_ids: maybes });
      return json(res, 200, { vote_id: v.id, name: v.name });
    }
    let who;
    if (body.person_id) {
      who = await db.getPerson(String(body.person_id));
      if (!isGuest(who)) throw new Fail("People with a Squad Up account change their own answers.", 404);
    } else {
      const found = await guestForName(res, body);
      if (!found) return;
      who = found.person;
    }
    const already = who && b.votes.find(v => v.person_id === who.id);
    const out = v => ({ vote_id: v.id, name: v.name, person_id: v.person_id, option_ids: v.option_ids || [], maybe_ids: v.maybe_ids || [] });
    if (already && body.peek) return json(res, 200, out(already));
    if (already) return json(res, 200, out(await db.updatePollVote(already.id, { option_ids: ids, maybe_ids: maybes })));
    if (b.votes.length >= C.POLL_MAX_VOTERS) throw new Fail("This one's full.", 429);
    if (!who) who = await db.createPerson({ name: tidyName(body.name), confirmed: false, invited_by: me.id });
    return json(res, 200, out(await db.createPollVote({ poll_id: b.poll.id, name: who.name, person_id: who.id, voter_key: C.newToken(),
      option_ids: ids, maybe_ids: maybes })));
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

  // Edit everything. Answers stay with a date even when its time or day
  // moves, so a half-hour tweak doesn't wipe anyone's votes. Removing a date
  // removes the answers for it.
  if (p === "/squadup/api/poll-edit") {
    const me = await requireViewer(body.token);
    const b = await pollBundle(body.poll_id);
    if (!b) throw new Fail("This one's gone.", 404);
    if (b.poll.creator_id !== me.id) throw new Fail("Only whoever started it can edit it.", 403);
    if (b.poll.finalized_at) throw new Fail("It's already been made a plan.");
    const title = String(body.title || "").trim().slice(0, 120);
    if (!title) throw new Fail("Give it a name.");
    const now = new Date();
    const today = C.dateOf(C.toLocalStamp(now));
    const byId = new Map(b.options.map(o => [o.id, o]));
    const keep = [];
    for (const k of Array.isArray(body.keep) ? body.keep : []) {
      const o = byId.get(String(k && k.id));
      if (!o) continue;
      const day = String(k.day || "").trim(), time = String(k.time || "").trim() || null;
      const one = C.parsePollOptions([{ day, time }], new Date(0));   // format check only
      if (one.error) throw new Fail(one.error);
      const changed = day !== o.day || time !== (o.time || null);
      if (changed && day < today) throw new Fail("One of those dates has already passed.");
      keep.push({ id: o.id, day, time, changed });
    }
    const added = (Array.isArray(body.add) && body.add.length) ? C.parsePollOptions(body.add, now) : { options: [] };
    if (added.error) throw new Fail(added.error);
    const all = [...keep, ...added.options];
    if (!all.length) throw new Fail("Keep at least one date.");
    if (all.length > C.POLL_MAX_DATES) throw new Fail(`That's a lot of dates. Keep it to ${C.POLL_MAX_DATES}.`);
    const seen = new Set();
    for (const o of all) {
      const k = o.day + " " + (o.time || "");
      if (seen.has(k)) throw new Fail(`${C.pollWhen(o)} is on the list twice.`);
      seen.add(k);
    }
    const { tag } = await resolveTag(me, body);
    await db.setSubscription(me.id, tag.id, true);
    const gone = b.options.filter(o => !keep.some(k => k.id === o.id)).map(o => o.id);
    for (const id of gone) await db.deletePollOption(id);
    if (gone.length) {
      for (const v of b.votes) {
        const y = (v.option_ids || []).filter(id => !gone.includes(id));
        const m = (v.maybe_ids || []).filter(id => !gone.includes(id));
        if (y.length !== (v.option_ids || []).length || m.length !== (v.maybe_ids || []).length)
          await db.updatePollVote(v.id, { option_ids: y, maybe_ids: m });
      }
    }
    for (const k of keep) if (k.changed) await db.updatePollOption(k.id, { day: k.day, time: k.time });
    if (added.options.length) await db.addPollOptions(b.poll.id, added.options);
    await db.updatePoll(b.poll.id, { title, tag_id: tag.id,
      location: String(body.location || "").trim().slice(0, C.LOCATION_MAX) || null,
      note: String(body.note || "").trim().slice(0, 280) || null });
    return json(res, 200, { ok: true, removed: gone.length });
  }

  // Ask Squad Up people to vote, or someone new by email/phone.
  if (p === "/squadup/api/poll-invite-new" || p === "/squadup/api/invite-new")
    throw new Fail("Send them the link instead. They join with their own number or email.", 410);

  if (p === "/squadup/api/poll-invite") {
    const me = await requireViewer(body.token);
    const b = await pollBundle(body.poll_id);
    if (!b) throw new Fail("This one's gone.", 404);
    if (b.poll.creator_id !== me.id) throw new Fail("Only whoever started it can invite people.", 403);
    if (b.poll.finalized_at) throw new Fail("It's already been made a plan.");
    if (C.pollIsStale(b.options, new Date())) throw new Fail("All of its dates have passed. Add some first.");
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const already = await invitesSentBy(me.id, since);
    const ids = [...new Set((Array.isArray(body.person_ids) ? body.person_ids : []).map(String))].filter(id => id !== me.id);
    if (!ids.length) throw new Fail("Pick at least one person.");
    if (already + ids.length > INVITES_PER_DAY)
      throw new Fail(`That's more than ${INVITES_PER_DAY} invites in a day. ` +
        `You have ${Math.max(0, INVITES_PER_DAY - already)} left today.`, 429);
    const targets = [];
    for (const id of ids) { const per = await db.getPerson(id); if (per && !isGuest(per)) targets.push(per); }
    const fresh = [];
    for (const per of targets) {
      if (await db.addPollInvite({ poll_id: b.poll.id, person_id: per.id, invited_by: me.id })) fresh.push(per);
    }
    const sent = await notifyAll(notifier, fresh, per => pollInviteMsg(me, b.poll, b.options, per, !per.confirmed_at),
      { kind: "invite" });
    return json(res, 200, { ok: true, invited: fresh.length, emailed: sent.length, held: sent.held || 0,
      unreachable: sent.unreachable || 0, waiting: sent.waiting || 0 });
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
    const already = await invitesSentBy(me.id, since);
    if (already + ids.length > INVITES_PER_DAY)
      throw new Fail(`That's more than ${INVITES_PER_DAY} invites in a day. ` +
        `You have ${Math.max(0, INVITES_PER_DAY - already)} left today.`, 429);

    const fresh = [];
    for (const id of ids) {
      const per = await db.getPerson(id);
      if (!per || isGuest(per)) continue;
      if (await db.addInvite({ activity_id: a.id, person_id: per.id, invited_by: me.id })) fresh.push(per);
    }
    const approved = options.filter(o => o.status === "approved").sort(byTime);
    const sent = await notifyAll(notifier, fresh, per => inviteMsg(me, a, approved, per, !per.confirmed_at),
      { kind: "invite" });
    return json(res, 200, { ok: true, invited: fresh.length, emailed: sent.length, held: sent.held,
      unreachable: sent.unreachable || 0, waiting: sent.waiting || 0 });
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
    // OptOutType is set when Twilio itself handled STOP / START / HELP
    const reply = await handleText(body.From, body.Body, !!body.OptOutType);
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
     None of these notify anyone: ideas just sit on the home page. */
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

  // the person who posted an idea can change its title, category and note,
  // or take it off the list
  if (p === "/squadup/api/idea-edit") {
    const me = await requireViewer(body.token);
    const idea = await liveIdea(body.idea_id);
    if (idea.creator_id !== me.id) throw new Fail("Only the person who added this idea can change it.", 403);
    if (body.delete) {
      await db.updateIdea(idea.id, { archived_at: new Date().toISOString() });
      return json(res, 200, { ok: true, removed: true });
    }
    const title = String(body.title || "").trim();
    if (!title) throw new Fail("What do you want to do?");
    if (title.length > 120) throw new Fail("Keep it shorter than that.");
    const { tag } = await resolveTag(me, body);
    await db.updateIdea(idea.id, { title, tag_id: tag.id,
      note: String(body.note || "").trim().slice(0, 280) || null });
    return json(res, 200, { ok: true, id: idea.id });
  }

  // guests can put their name on an idea too; the organizer reaches them
  if (p === "/squadup/api/idea-join") {
    const me = await requireAnyone(body.token);
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

  if (p === "/squadup/api/rsvp") {
    const me = await requireAnyone(body.token);
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
    } else if (Array.isArray(body.option_ids)) {
      // the whole set at once, so quick taps can't race each other
      const ok = new Set(bundle.options.filter(o => o.status === "approved").map(o => o.id));
      ids = [...new Set(body.option_ids.map(String))].filter(id => ok.has(id));
      await db.upsertResponse({ activity_id: bundle.a.id, person_id: me.id,
        option_ids: ids, can_make_it: true });
      // tapping a time is an opt-in, as the Terms say (guests get no messages)
      if (ids.length && !isGuest(me)) await confirmPerson(me, me.confirmed_at ? null : bundle.a.tag_id);
    } else {
      const opt = bundle.options.find(o => o.id === body.option_id);
      if (!opt || opt.status !== "approved") throw new Fail("That time isn't on the board.");
      ids = ids.includes(opt.id) ? ids.filter(x => x !== opt.id) : ids.concat(opt.id);
      await db.upsertResponse({ activity_id: bundle.a.id, person_id: me.id,
        option_ids: ids, can_make_it: true });
    }
    return json(res, 200, { ok: true, option_ids: ids });
  }

  // The organizer fills in a plan for people who answered by text or in
  // person: add someone by name, or change a guest's times.
  if (p === "/squadup/api/plan-guest") {
    const me = await requireViewer(body.token);
    const bundle = await activityBundle(body.activity_id);
    if (!bundle) throw new Fail("That plan is gone.", 404);
    if (!C.isCreator(me, bundle.a)) throw new Fail("Only whoever posted it can fill in for others.", 403);
    if (bundle.a.canceled_at) throw new Fail("That plan was deleted.");
    if (planIsOver(bundle)) throw new Fail("That one already happened.");
    let who;
    if (body.person_id) {
      who = await db.getPerson(String(body.person_id));
      if (!isGuest(who)) throw new Fail("People with a Squad Up account change their own answers.", 404);
      // take a guest off this plan
      if (body.remove) {
        await db.deleteResponse(bundle.a.id, who.id);
        await dropIfUnused(who);
        return json(res, 200, { ok: true, removed: true });
      }
    } else {
      const found = await guestForName(res, body);
      if (!found) return;          // asked "did you mean"; the page answers
      who = found.person || await db.createPerson({ name: found.name, confirmed: false, invited_by: me.id });
    }
    // "+ Add": put them on the plan without touching any answer they have
    const had = bundle.responses.find(r => r.person_id === who.id);
    if (body.peek && had) return json(res, 200, { ok: true, person_id: who.id, name: who.name, option_ids: had.option_ids || [] });
    const ok = new Set(bundle.options.filter(o => o.status === "approved").map(o => o.id));
    const ids = body.cant ? [] : [...new Set((Array.isArray(body.option_ids) ? body.option_ids : []).map(String))].filter(id => ok.has(id));
    await db.upsertResponse({ activity_id: bundle.a.id, person_id: who.id, option_ids: ids, can_make_it: !body.cant });
    return json(res, 200, { ok: true, person_id: who.id, name: who.name, option_ids: ids });
  }

  // The organizer fixing a guest they added: a typo in the name, or "Tom"
  // turning out to be the same person as "Thomas" (merge into them).
  if (p === "/squadup/api/guest-rename") {
    const me = await requireViewer(body.token);
    const g = await db.getPerson(String(body.person_id || ""));
    if (!(await canManageGuest(me, g))) throw new Fail("Only whoever added this guest can change their name.", 403);
    const name = tidyName(body.name);
    if (!name) throw new Fail("Type their name.");
    const { exact } = await nameMatches(name, [g.id]);
    if (exact) throw new Fail(isGuest(exact)
      ? `${exact.name} is already on Squad Up as a guest. If they're the same person, use Merge instead.`
      : TAKEN_MEMBER(exact.name), 409);
    await db.updatePerson(g.id, { name });
    for (const v of await db.listPollVotesForPerson(g.id)) await db.updatePollVote(v.id, { name });
    return json(res, 200, { ok: true, name });
  }

  if (p === "/squadup/api/guest-merge") {
    const me = await requireViewer(body.token);
    const g = await db.getPerson(String(body.person_id || ""));
    if (!(await canManageGuest(me, g))) throw new Fail("Only whoever added this guest can merge them.", 403);
    const into = await db.getPerson(String(body.into_id || ""));
    if (!into || into.id === g.id) throw new Fail("Pick who they really are.");
    await mergeGuest(g, into);
    return json(res, 200, { ok: true, into: { id: into.id, name: into.name } });
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
        body: `${C.formatWhen(body.starts_at, bundle.a.timezone)}${sugg.label ? ` (“${sugg.label}”)` : ""}. ` +
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
    await approveOption(me, bundle, opt, body.notify === true);
    return json(res, 200, { ok: true, notified: body.notify === true });
  }

  if (p === "/squadup/api/lock") {
    const me = await requireViewer(body.token);
    const bundle = await activityBundle(body.activity_id);
    if (!bundle) throw new Fail("That activity is gone.", 404);
    if (!C.isCreator(me, bundle.a)) throw new Fail("Only whoever posted it can set the time.", 403);
    const opt = bundle.options.find(o => o.id === body.option_id);
    if (!opt || opt.status !== "approved") throw new Fail("That time isn't on the board.");

    await db.updateActivity(bundle.a.id, { locked_option_id: opt.id, finalize_nudge_sent_at: null });
    // only when the organizer says to tell everyone
    if (body.notify !== true) return json(res, 200, { ok: true, notified: false });
    const people = await audienceFor(bundle.a);
    await notifyAll(notifier, people, per => ({
      subject: `${C.fullTitle(bundle.a)} — ${C.formatWhen(opt.starts_at, bundle.a.timezone)}`,
      body: `That's the plan now: ${C.formatWhen(opt.starts_at, bundle.a.timezone)}.`,
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
    if (body.notify !== true) return json(res, 200, { ok: true, notified: false });

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

/* ---------- the day-before reminder ----------
   The only time-based piece. Runs on three triggers, because a free Render
   instance sleeps when idle and a sleeping process fires no timers:
     1. an hourly interval, while the process happens to be awake
     2. GET/POST /squadup/cron/nudge, for a real scheduler (guarded by
        CRON_SECRET when one is set)
     3. opportunistically on any incoming request, throttled
   needsReminder is a window (the 24 hours before the plan) rather than
   "exactly now", so a late run still catches it. Besides new plans in the
   categories people follow, this is the only message that goes out without
   someone pressing a button. */
async function runNudges(now) {
  const when = now || new Date();
  const all = await db.listActivities();
  let sent = 0;
  for (const a of all) {
    const options = await db.listOptions(a.id);
    if (!C.needsReminder(a, options, when)) continue;
    // mark it first, so two sweeps at once can't both send
    await db.updateActivity(a.id, { finalize_nudge_sent_at: new Date().toISOString() });

    const responses = await db.listResponses(a.id);
    const locked = options.find(o => o.id === a.locked_option_id);
    const approved = options.filter(o => o.status === "approved");
    const counts = C.tally(approved, responses);
    const at = C.formatWhen(locked.starts_at, a.timezone);
    const named = C.fullTitle(a);
    // everyone who's in for the plan's time, and the organizer
    const ids = new Set(responses.filter(r => r.can_make_it !== false && (r.option_ids || []).includes(locked.id)).map(r => r.person_id));
    if (a.creator_id) ids.add(a.creator_id);
    const people = [];
    for (const id of ids) { const per = await db.getPerson(id); if (per && !isGuest(per)) people.push(per); }
    const n = (counts[locked.id] || []).length;
    await notifyAll(notifier, people, per => per.id === a.creator_id ? {
      subject: `Tomorrow: ${named}`,
      body: `${named} is tomorrow, ${at}. ${n} in.` + (approved.length > 1
        ? ` Where everyone landed: ${approved.map(o => `${C.formatWhen(o.starts_at, a.timezone)} — ${(counts[o.id] || []).length} in`).join("; ")}.` : ""),
      sms: `Reminder: ${named} is tomorrow, ${at}. ${n} in.`,
      url: activityUrl(a.id, per)
    } : {
      subject: `Tomorrow: ${named}`,
      body: `A reminder: ${named} is tomorrow, ${at}. You said you're in.`,
      sms: `Reminder: ${named} is tomorrow, ${at}. You said you're in.`,
      url: activityUrl(a.id, per)
    }, { kind: "reminder" });
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
    // the database's own one-name (or one-email) rule caught something
    if (e && e.code === "23505") return json(res, 409, { error: /name/.test(e.message || "")
      ? "Someone on Squad Up already goes by that name. Add a last initial." : "That's already on Squad Up for someone else." });
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
  // older data under the one-name rule (does nothing once it's tidy)
  tidyNames().catch(e => console.error("name tidy failed:", e.message));
  setInterval(() => {
    runNudges().catch(e => console.error("nudge failed:", e.message));
    sweepIdeas().catch(e => console.error("idea sweep failed:", e.message));
  }, 60 * 60 * 1000);
}

module.exports = { server, handle, runNudges, sweepIdeas, tidyNames, db, notifier };
