/* Drives the real server over real HTTP through the whole lifecycle:
   signup, post, RSVP, suggest, approve, switch, cancel, nudge, and the
   "Let's do this sometime" list. */
process.env.SQUAD_DB_FILE = "/tmp/squadup-test-" + Date.now() + ".json";
process.env.SQUAD_BASE_URL = "http://127.0.0.1:3777/squadup";
// the whole run sends far more mail than a real day would; the limits get
// their own isolated checks below
process.env.SQUAD_EMAIL_PER_PERSON_DAY = "1000";
process.env.SQUAD_EMAIL_PER_DAY = "100000";

const { server, runNudges, db, notifier } = require("./server/index.js");
const C = require("./lib/core.js");
const fail = [];
const PORT = 3777;
const B = `http://127.0.0.1:${PORT}`;

const check = (cond, msg) => { console.log(`  ${cond ? "ok" : "FAIL"}: ${msg}`); if (!cond) fail.push(msg); };

async function api(path, body) {
  const r = await fetch(B + path, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const getPage = async path => {
  const r = await fetch(B + path);
  return { status: r.status, text: await r.text() };
};

(async () => {
  await new Promise(r => server.listen(PORT, r));

  console.log("=== signup ===");
  const gin = (await api("/squadup/api/signup", { name: "Gin", email: "gin@x.test", tags: [] })).body;
  check(!!gin.token, "signup returns a personal link");

  const dupe = await api("/squadup/api/signup", { name: "Someone Else", email: "GIN@x.test" });
  check(dupe.body.emailed === true && !dupe.body.token,
    "a repeat email is mailed the existing link, never shown on screen");

  const bad = await api("/squadup/api/signup", { name: "X", email: "nope" });
  check(bad.status === 400, "a malformed email is rejected");

  console.log("\n=== posting an activity ===");
  const made = await api("/squadup/api/activity", {
    token: gin.token, title: "Rock climbing", tag_name: "Climbing",
    primary: "2030-04-18T18:00", backup: "2030-04-17T18:00", note: "Bring shoes"
  });
  check(made.status === 200 && !!made.body.id, "activity posts with a primary and a backup");
  const A = made.body.id;

  let bundle = await db.getActivity(A);
  let opts = await db.listOptions(A);
  const primary = opts.find(o => o.kind === "primary");
  check(bundle.locked_option_id === primary.id, "the first choice is locked immediately");
  check(opts.length === 2 && opts.every(o => o.status === "approved"),
    "both creator-set times start approved");

  const noTime = await api("/squadup/api/activity", { token: gin.token, title: "X", tag_name: "Y" });
  check(noTime.status === 400, "an activity with no time is rejected");

  console.log("\n=== new tags reach everyone ===");
  const emily = (await api("/squadup/api/signup", { name: "Emily", email: "em@x.test" })).body;
  const will = (await api("/squadup/api/signup", { name: "Will", email: "will@x.test" })).body;
  const raif = (await api("/squadup/api/signup", { name: "Raif", email: "raif@x.test" })).body;
  const paint = await api("/squadup/api/activity", {
    token: gin.token, title: "Paintball", tag_name: "Paintball", primary: "2030-05-02T10:00"
  });
  const paintTag = (await db.getActivity(paint.body.id)).tag_id;
  const subs = await db.subscribersOfTag(paintTag);
  check(subs.length === 4, "a brand-new category subscribes everyone registered (got " + subs.length + ")");

  console.log("\n=== rsvp ===");
  const backup = opts.find(o => o.kind === "backup");
  await api("/squadup/api/rsvp", { token: emily.token, activity_id: A, option_id: primary.id });
  await api("/squadup/api/rsvp", { token: emily.token, activity_id: A, option_id: backup.id });
  let mine = (await db.listResponses(A)).find(r => r.person_id !== null && r.option_ids.length === 2);
  check(!!mine, "one person can say both times work");

  const off = await api("/squadup/api/rsvp", { token: emily.token, activity_id: A, option_id: primary.id });
  check(off.body.option_ids.length === 1, "tapping a time again takes it back off");

  await api("/squadup/api/rsvp", { token: will.token, activity_id: A, cant: true });
  const outRow = (await db.listResponses(A)).find(r => r.can_make_it === false);
  check(!!outRow, "\"can't make any\" records a soft out");
  check((await db.getActivity(A)).locked_option_id === primary.id,
    "a soft out does NOT reopen the plan");

  console.log("\n=== suggesting a third time ===");
  const sug = await api("/squadup/api/suggest", {
    token: will.token, activity_id: A, starts_at: "2030-04-19T19:00", label: "after work"
  });
  check(sug.status === 200, "anyone can suggest another time");
  opts = await db.listOptions(A);
  const pending = opts.find(o => o.status === "pending");
  check(!!pending, "a suggestion lands as pending, not live");

  const asStranger = await getPage(`/squadup/a/${A}`);
  check(!asStranger.text.includes("Apr 19"),
    "a pending suggestion is invisible to everyone but the creator");
  const asCreator = await getPage(`/squadup/a/${A}?t=${gin.token}`);
  check(asCreator.text.includes("Apr 19"), "the creator does see it, with approve/dismiss");

  const notMine = await api("/squadup/api/option-decide", {
    token: emily.token, option_id: pending.id, approve: true
  });
  check(notMine.status === 403, "only the creator can approve a suggestion");

  await api("/squadup/api/option-decide", { token: gin.token, option_id: pending.id, approve: true });
  check((await db.getOption(pending.id)).status === "approved", "approving makes it votable");

  const sug2 = await api("/squadup/api/suggest", {
    token: emily.token, activity_id: A, starts_at: "2030-04-20T12:00"
  });
  const p2 = (await db.listOptions(A)).find(o => o.status === "pending");
  await api("/squadup/api/option-decide", { token: gin.token, option_id: p2.id, approve: false });
  check(!(await db.getOption(p2.id)), "a dismissed suggestion is removed outright");

  console.log("\n=== the switch suggestion ===");
  // three people back the approved suggestion, only Emily backs the primary
  for (const t of [will.token, raif.token, emily.token]) {
    await api("/squadup/api/rsvp", { token: t, activity_id: A, option_id: pending.id });
  }
  let a2 = await db.getActivity(A);
  let o2 = await db.listOptions(A), r2 = await db.listResponses(A);
  const sw = C.switchSuggestion(a2, o2, r2);
  check(!!sw && sw.to.id === pending.id, "a better-attended time surfaces as a suggestion");
  check(a2.locked_option_id === primary.id, "but nothing switches on its own");

  const belowQuorum = C.switchSuggestion(a2, o2, r2.slice(0, 2));
  check(belowQuorum === null, "no suggestion until enough people have answered");

  const lockByOther = await api("/squadup/api/lock", {
    token: emily.token, activity_id: A, option_id: pending.id
  });
  check(lockByOther.status === 403, "only the creator can move the plan");

  await api("/squadup/api/lock", { token: gin.token, activity_id: A, option_id: pending.id });
  check((await db.getActivity(A)).locked_option_id === pending.id,
    "the creator confirming is what actually moves it");

  console.log("\n=== joining through an activity link ===");
  const lainee = await api("/squadup/api/signup", {
    name: "Lainee", email: "lainee@x.test", activity_id: A
  });
  check(!!lainee.body.token, "a newcomer signs up straight from an activity");
  const laineePerson = await db.getPersonByEmail("lainee@x.test");
  const lSubs = await db.listSubscriptions(laineePerson.id);
  check(lSubs.length === 1, "they get that one category, not everything (got " + lSubs.length + ")");
  const lResp = (await db.listResponses(A)).find(r => r.person_id === laineePerson.id);
  check(!!lResp, "and their RSVP is recorded in the same step");

  console.log("\n=== the day-before nudge ===");
  const tomorrow = new Date(2030, 3, 18, 10, 0);   // Apr 19 event, checked Apr 18 10am
  await db.updateActivity(A, { locked_option_id: opts.find(o => o.kind === "primary").id });
  await db.updateActivity(A, { finalize_nudge_sent_at: null });
  const lockedNow = await db.listOptions(A);
  await db.updateActivity(A, { locked_option_id: lockedNow.find(o => o.starts_at === "2030-04-19T19:00").id });
  const n1 = await runNudges(tomorrow);
  check(n1 === 1, "the creator is nudged the day before");
  const n2 = await runNudges(tomorrow);
  check(n2 === 0, "and only once");

  const early = C.needsFinalizeNudge(await db.getActivity(A),
    await db.listOptions(A), new Date(2030, 3, 18, 8, 0));
  check(early === false, "nothing goes out before 10am");

  console.log("\n=== canceling ===");
  const cancelByOther = await api("/squadup/api/cancel", { token: emily.token, activity_id: A });
  check(cancelByOther.status === 403, "only the creator can call it off");

  await api("/squadup/api/cancel", { token: gin.token, activity_id: A, reason: "Quarry's flooded" });
  const dead = await db.getActivity(A);
  check(!!dead.canceled_at, "canceling marks the activity off");

  const rsvpAfter = await api("/squadup/api/rsvp", {
    token: emily.token, activity_id: A, option_id: primary.id
  });
  check(rsvpAfter.status === 400, "you can't RSVP to something that's off");
  const cancelPage = await getPage(`/squadup/a/${A}`);
  check(cancelPage.text.includes("Quarry&#39;s flooded"),
    "the reason shows on the page, with the apostrophe escaped");

  console.log("\n=== user text can't inject markup ===");
  const xss = await api("/squadup/api/activity", {
    token: emily.token, title: "<script>alert(1)</script>", tag_name: "Beach",
    primary: "2030-06-01T10:00"
  });
  const xssPage = await getPage(`/squadup/a/${xss.body.id}`);
  check(!xssPage.text.includes("<script>alert(1)</script>"),
    "a script tag in a title is escaped, not rendered");
  check(xssPage.text.includes("&lt;script&gt;"), "and shows as literal text instead");

  console.log("\n=== let's do this sometime ===");
  // record every notification from here on
  const outbox = [];
  const realSend = notifier.send.bind(notifier);
  notifier.send = async (person, msg) => { outbox.push({ to: person.name, ...msg }); return realSend(person, msg); };
  const idea = await api("/squadup/api/idea", {
    token: emily.token, title: "Beach day", tag_name: "Outdoors", note: "Somewhere new"
  });
  check(idea.status === 200 && !!idea.body.id, "anyone can put an idea on the list");
  const I = idea.body.id;
  check(outbox.length === 0, "posting an idea notifies nobody");
  let members = await db.listIdeaMembers(I);
  check(members.length === 1, "whoever posts it is automatically in");

  const emptyIdea = await api("/squadup/api/idea", { token: emily.token, title: "  ", tag_name: "Outdoors" });
  check(emptyIdea.status === 400, "an idea needs a name");

  // Raif and Will stop following Outdoors -- ideas should still reach their page
  const outdoors = await db.getTagByName("Outdoors");
  const raifP = await db.getPersonByEmail("raif@x.test");
  const willP = await db.getPersonByEmail("will@x.test");
  await api("/squadup/api/subscribe", { token: raif.token, tag_id: outdoors.id, on: false });
  await api("/squadup/api/subscribe", { token: will.token, tag_id: outdoors.id, on: false });
  let raifPage = await getPage(`/squadup/p/${raif.token}`);
  check(raifPage.text.includes("Beach day"),
    "ideas show for everyone, even people who don't follow that category");
  const posIdeas = raifPage.text.indexOf('id="ideas"');
  check(posIdeas > 0 && posIdeas > raifPage.text.indexOf("Paintball"),
    "the list sits after the scheduled activities");

  await api("/squadup/api/idea-join", { token: will.token, idea_id: I, on: true });
  await api("/squadup/api/idea-join", { token: will.token, idea_id: I, on: true });
  members = await db.listIdeaMembers(I);
  check(members.length === 2, "joining adds your name once, however many taps");
  check(outbox.length === 0, "joining notifies nobody");

  console.log("\n=== the weekly nudge ===");
  const soloIdea = (await api("/squadup/api/idea", { token: raif.token, title: "Bowling", tag_name: "Outdoors" })).body.id;
  const soloNudge = await api("/squadup/api/idea-nudge", { token: raif.token, idea_id: soloIdea });
  check(soloNudge.status === 400, "a nudge needs someone else on the list to go to");

  const outsider = await api("/squadup/api/idea-nudge", { token: raif.token, idea_id: I });
  check(outsider.status === 403, "only people on the list can nudge it");

  const nudge = await api("/squadup/api/idea-nudge", { token: will.token, idea_id: I });
  check(nudge.status === 200 && nudge.body.sent === 1, "a member can nudge the others");
  check(outbox.length === 1 && outbox[0].to === "Emily",
    "it reaches the other people on the list, not the nudger or anyone else");
  check(/schedule Beach day/.test(outbox[0].subject) && /#idea-/.test(outbox[0].url),
    "and links them straight to the idea on their own page");

  const again = await api("/squadup/api/idea-nudge", { token: emily.token, idea_id: I });
  check(again.status === 429, "a second nudge the same week is refused, whoever sends it");
  const emilyPage = await getPage(`/squadup/p/${emily.token}`);
  check(emilyPage.text.includes("Next nudge"), "the page shows when it can go again");

  await db.updateIdea(I, { last_nudge_at: new Date(Date.now() - 8 * 864e5).toISOString() });
  const week = await api("/squadup/api/idea-nudge", { token: emily.token, idea_id: I });
  check(week.status === 200, "a week later it's allowed again");
  outbox.length = 0;

  console.log("\n=== fading out ===");
  const now = new Date();
  const old = { created_at: new Date(now - 121 * 864e5).toISOString() };
  check(!C.isIdeaLive(old, now), "an idea nobody's joined in four months is off the list");
  check(C.isIdeaLive({ ...old, last_joined_at: new Date(now - 5 * 864e5).toISOString() }, now),
    "but a new name restarts the clock");

  const stale = (await api("/squadup/api/idea", { token: gin.token, title: "Mini golf", tag_name: "Outdoors" })).body.id;
  await db.updateIdea(stale, { created_at: new Date(now - 130 * 864e5).toISOString(),
                               last_joined_at: new Date(now - 130 * 864e5).toISOString() });
  check(!(await getPage(`/squadup/p/${emily.token}`)).text.includes("Mini golf"),
    "an expired idea disappears from everyone's page right away");
  const lateJoin = await api("/squadup/api/idea-join", { token: emily.token, idea_id: stale, on: true });
  check(lateJoin.status === 404, "and can't be joined");
  check((await runNudges()) >= 0 && (await require("./server/index.js").sweepIdeas()) === 1,
    "the sweep archives it quietly");
  check(outbox.length === 0, "nobody is told an idea faded");

  console.log("\n=== leaving ===");
  const lb = (await api("/squadup/api/idea", { token: gin.token, title: "Laser tag", tag_name: "Outdoors" })).body.id;
  await api("/squadup/api/idea-join", { token: emily.token, idea_id: lb, on: true });
  await api("/squadup/api/idea-join", { token: gin.token, idea_id: lb, on: false });
  check(!(await db.getIdea(lb)).archived_at, "leaving takes your name off; the idea stays for the rest");
  const lastOut = await api("/squadup/api/idea-join", { token: emily.token, idea_id: lb, on: false });
  check(lastOut.body.removed === true && !!(await db.getIdea(lb)).archived_at,
    "when the last person leaves, it comes off the list");

  console.log("\n=== turning an idea into a plan ===");
  const prefill = await getPage(`/squadup/new?t=${raif.token}&idea=${I}`);
  check(prefill.text.includes('value="Beach day"') && prefill.text.includes("Put a time on it"),
    "anyone can open it pre-filled with the title and category");
  check(prefill.text.includes(`value="${outdoors.id}" selected`), "the category comes pre-selected");

  const sched = await api("/squadup/api/activity", {
    token: raif.token, title: "Beach day", tag_id: outdoors.id,
    primary: "2030-07-11T10:00", idea_id: I
  });
  check(sched.status === 200, "a non-member can schedule it");
  const done = await db.getIdea(I);
  check(!!done.archived_at && done.converted_activity_id === sched.body.id,
    "the idea comes off the list and points at the real activity");
  const willMail = outbox.find(m => m.to === "Will");
  const emMail = outbox.find(m => m.to === "Emily");
  check(!!willMail && /You said you were in/.test(willMail.body),
    "people on the list hear about it even if they don't follow that category");
  check(!!emMail && /You said you were in/.test(emMail.body), "everyone on the list hears");
  check(!outbox.some(m => m.to === "Raif"), "the person scheduling it isn't emailed about their own post");
  check(!(await getPage(`/squadup/p/${emily.token}`)).text.includes('id="idea-' + I + '"'),
    "the idea card is gone from the page");

  const twice = await api("/squadup/api/activity", {
    token: gin.token, title: "Beach day", tag_id: outdoors.id,
    primary: "2030-07-12T10:00", idea_id: I
  });
  check(twice.status === 404, "the same idea can't be scheduled twice");

  const xssIdea = await api("/squadup/api/idea", {
    token: emily.token, title: "<img src=x onerror=alert(1)>", tag_name: "Outdoors"
  });
  const xssDash = await getPage(`/squadup/p/${emily.token}`);
  check(xssIdea.status === 200 && !xssDash.text.includes("<img src=x") &&
        xssDash.text.includes("&lt;img src=x"), "idea titles are escaped on the page");
  notifier.send = realSend;

  console.log("\n=== links and identity ===");
  const feed = await getPage(`/squadup/p/${gin.token}`);
  check(feed.status === 200 && feed.text.includes("Paintball"),
    "the personal page lists what you're subscribed to");

  const junk = await getPage("/squadup/p/not-a-real-token");
  check(junk.status === 404, "an unknown link is refused");

  const reset = await api("/squadup/api/reset-link", { token: gin.token });
  check(reset.status === 200, "you can replace your own link");
  const oldLink = await getPage(`/squadup/p/${gin.token}`);
  check(oldLink.status === 404, "and the old one stops working immediately");

  const forged = await api("/squadup/api/activity", {
    token: "made-up", title: "Nope", tag_name: "Nope", primary: "2030-01-01T10:00"
  });
  check(forged.status === 403, "a made-up token can't post");

  console.log("\n=== location, creator auto-in, signed-in email links ===");
  const sent = [];
  const realSend2 = notifier.send;
  notifier.send = async (p, m) => { sent.push({ to: p, ...m }); return { ok: true }; };
  // links may have been replaced above -- pick up the current ones
  gin.token = (await db.getPersonByEmail("gin@x.test")).personal_token;
  emily.token = (await db.getPersonByEmail("em@x.test")).personal_token;
  const emilyId = (await db.getPersonByToken(emily.token)).id;
  const ginId = (await db.getPersonByToken(gin.token)).id;

  const pk = await api("/squadup/api/activity", {
    token: gin.token, title: "Pickleball", location: "  Josh's place ", tag_name: "Pickleball",
    primary: "2030-06-06T18:00", backup: "2030-06-07T18:00"
  });
  const PK = pk.body.id;
  let pkA = await db.getActivity(PK);
  check(pkA.location === "Josh's place", "location is saved (trimmed)");
  check(C.fullTitle(pkA) === "Pickleball at Josh's place", "it reads as 'Pickleball at Josh's place'");
  check(C.fullTitle({ title: "Pickleball", location: null }) === "Pickleball", "no location, no 'at'");
  let pkOpts = (await db.listOptions(PK)).sort((x, y) => x.starts_at.localeCompare(y.starts_at));
  let ginR = (await db.listResponses(PK)).find(r => r.person_id === ginId);
  check(ginR && ginR.option_ids.length === 2 && ginR.can_make_it,
    "whoever posts it is marked available for both of their times");

  const toEm = sent.find(m => m.to.id === emilyId);
  check(toEm && toEm.subject.startsWith("Pickleball at Josh's place"), "the email title includes the place");
  check(toEm && toEm.url.includes(`?t=${encodeURIComponent(emily.token)}`),
    "the email's link signs Emily in");
  check(toEm && toEm.actions.length === 4 && toEm.actions.every(a => a.url.includes("/r/") &&
    a.url.includes(encodeURIComponent(emily.token))), "it has one-tap buttons: each time, both, can't make it");
  check(!sent.some(m => m.to.id === ginId), "the poster doesn't get their own announcement");

  console.log("\n=== one-tap answers ===");
  const firstBtn = new URL(toEm.actions[0].url);
  const landing = await fetch(B + firstBtn.pathname + firstBtn.search).then(r => r.text());
  check(landing.includes("Saving") && !(await db.listResponses(PK)).some(r => r.person_id === emilyId),
    "just opening the link changes nothing (mail scanners can't answer for you)");
  const doIt = (who, what) => api("/squadup/api/reply", { token: who.token, activity_id: PK, do: what });
  let rr = await doIt(emily, firstBtn.searchParams.get("do"));
  let emR = () => db.listResponses(PK).then(rs => rs.find(r => r.person_id === emilyId));
  check(rr.body.saved === "in" && (await emR()).option_ids.join() === pkOpts[0].id,
    "tapping a time saves it");
  await doIt(emily, firstBtn.searchParams.get("do"));
  check((await emR()).option_ids.length === 1, "tapping the same button twice doesn't undo it");
  await doIt(emily, "no");
  check((await emR()).can_make_it === false && !(await emR()).option_ids.length, "Can't make it saves");
  await doIt(emily, "all");
  check((await emR()).option_ids.length === 2 && (await emR()).can_make_it, "Both work saves both");
  const savedPage = await getPage(`/squadup/a/${PK}?t=${emily.token}&saved=in`);
  check(savedPage.text.includes("Saved. You&#39;re in."), "the plan page confirms it");
  check(savedPage.text.includes('Pickleball <span class="at">at Josh&#39;s place</span>'),
    "the plan page shows the place in the title");
  check((await doIt(emily, "opt:nonsense")).status === 400, "a stale button explains itself");

  console.log("\n=== suggest and approve from email ===");
  sent.length = 0;
  await api("/squadup/api/suggest", { token: emily.token, activity_id: PK, starts_at: "2030-06-08T10:00" });
  const toGin = sent.find(m => m.to.id === ginId);
  const approveDo = toGin && new URL(toGin.actions[0].url).searchParams.get("do");
  check(approveDo && approveDo.startsWith("approve:"), "the organizer's email has an Add it button");
  check((await doIt(emily, approveDo)).status === 403, "nobody else can use it");
  sent.length = 0;
  check((await doIt(gin, approveDo)).body.saved === "added", "the organizer adds it in one tap");
  const added = await db.getOption(approveDo.slice(8));
  check(added.status === "approved", "the time is now on the board");
  const newTimeMail = sent.find(m => m.to.id === emilyId);
  check(newTimeMail && newTimeMail.actions[0].url.includes("opt%3A" + added.id),
    "everyone else gets a one-tap 'works for me' for the new time");

  console.log("\n=== editing ===");
  check((await getPage(`/squadup/edit/${PK}?t=${emily.token}`)).status === 403, "only the creator can open edit");
  const editPage = await getPage(`/squadup/edit/${PK}?t=${gin.token}`);
  check(editPage.status === 200 && editPage.text.includes('value="Josh&#39;s place"') &&
    editPage.text.includes('value="2030-06-06T18:00"'), "the edit form comes pre-filled");
  const planPage = await getPage(`/squadup/a/${PK}?t=${gin.token}`);
  check(planPage.text.includes(`/squadup/edit/${PK}?t=`), "the creator sees an Edit button");
  check(!(await getPage(`/squadup/a/${PK}?t=${emily.token}`)).text.includes("/squadup/edit/"),
    "nobody else does");

  const base = { token: gin.token, activity_id: PK, title: "Pickleball", location: "Josh's place",
    tag_id: pkA.tag_id, primary: "2030-06-06T18:00", backup: "2030-06-07T18:00", note: "" };
  check((await api("/squadup/api/activity-edit", { ...base, token: emily.token })).status === 403,
    "nobody else can save edits");
  sent.length = 0;
  let ed = await api("/squadup/api/activity-edit", { ...base, title: "Pickleball doubles", note: "Bring water" });
  check(ed.status === 200 && ed.body.notified === false && sent.length === 0,
    "renaming and notes save quietly");
  check((await db.getActivity(PK)).title === "Pickleball doubles", "the new name sticks");

  await db.updateActivity(PK, { finalize_nudge_sent_at: new Date().toISOString() });
  sent.length = 0;
  ed = await api("/squadup/api/activity-edit", { ...base, title: "Pickleball doubles", primary: "2030-06-13T18:00" });
  const moved = sent.find(m => m.to.id === emilyId);
  check(ed.body.notified && moved && moved.body.includes("Now Thu Jun 13, 6pm"),
    "moving the time emails everyone who's in");
  check(moved && moved.actions.some(a => a.label === "I'm in"), "with a one-tap answer for the new time");
  pkOpts = await db.listOptions(PK);
  const lockedId = (await db.getActivity(PK)).locked_option_id;
  const plan = pkOpts.find(o => o.id === lockedId);
  check(plan.starts_at === "2030-06-13T18:00", "the plan time moved");
  check(!(await emR()).option_ids.includes(plan.id), "old answers for that time are cleared");
  ginR = (await db.listResponses(PK)).find(r => r.person_id === ginId);
  check(ginR.option_ids.includes(plan.id), "the creator stays in for it");
  check(!(await db.getActivity(PK)).finalize_nudge_sent_at, "the day-before reminder is re-armed");

  const backupOpt = pkOpts.find(o => o.kind === "backup");
  sent.length = 0;
  ed = await api("/squadup/api/activity-edit", { ...base, title: "Pickleball doubles",
    primary: "2030-06-13T18:00", backup: "", location: "the Y" });
  check(!(await db.getOption(backupOpt.id)), "clearing the backup removes that time");
  check(!(await emR()).option_ids.includes(backupOpt.id), "and the answers for it");
  const where = sent.find(m => m.to.id === emilyId);
  check(where && where.body.includes("Now at the Y") && where.body.includes("backup"),
    "a new place and a dropped backup are both in the email");
  check((await api("/squadup/api/activity-edit", { ...base, backup: base.primary })).status === 400,
    "a backup can't equal the main time");

  console.log("\n=== past plans ===");
  const today = C.toLocalStamp(new Date()).slice(0, 10);
  const oldP = (await api("/squadup/api/activity", { token: gin.token, title: "Beach day",
    location: "Lovers Key", tag_name: "Beach", primary: "2020-07-04T10:00" })).body.id;
  const tonight = (await api("/squadup/api/activity", { token: gin.token, title: "Trivia",
    tag_name: "Trivia", primary: today + "T00:01" })).body.id;
  let home = await getPage(`/squadup/p/${gin.token}`);
  check(!home.text.includes(`/squadup/a/${oldP}?`), "plans whose day has passed leave the home page");
  check(home.text.includes(`/squadup/a/${tonight}?`), "a plan stays up through the day it happens");
  check(home.text.includes(`/squadup/past?t=${gin.token}`), "the home page links to Past Plans");
  check(home.text.includes("No date yet"), "'Let's do this sometime' explains it has no date yet");

  sent.length = 0;
  await api("/squadup/api/cancel", { token: gin.token, activity_id: PK, reason: "Rain" });
  const offMail = sent.find(m => m.to.id === emilyId);
  check(offMail && offMail.body.includes("deleted") && offMail.url.includes("?t="),
    "deleting tells everyone who's in, with a signed-in link");
  home = await getPage(`/squadup/p/${emily.token}`);
  check(!home.text.includes(`/squadup/a/${PK}?`), "deleted plans leave the home page");

  check((await getPage("/squadup/past")).status === 403, "Past Plans needs your link");
  const past = await getPage(`/squadup/past?t=${emily.token}`);
  check(past.text.includes(`/squadup/a/${oldP}?`) && past.text.includes(`/squadup/a/${PK}?`),
    "Past Plans has both the finished and the deleted plan");
  check(past.text.includes("Deleted") && past.text.includes("Jul 4, 2020"), "marked and dated");
  check(past.text.indexOf(`/squadup/a/${PK}?`) < past.text.indexOf(`/squadup/a/${oldP}?`),
    "newest first");
  check(!past.text.includes(`/squadup/a/${tonight}?`), "today's plan isn't past yet");
  check((await doIt(emily, "all")).status === 400, "a deleted plan can't be answered");
  check((await api("/squadup/api/rsvp", { token: emily.token, activity_id: oldP,
    option_id: (await db.listOptions(oldP))[0].id })).status === 400, "neither can one that's over");
  const oldPage = await getPage(`/squadup/a/${oldP}?t=${emily.token}`);
  check(oldPage.text.includes("This happened Jul 4, 2020") && !oldPage.text.includes("data-vote=\""),
    "a finished plan's page says so and has no answer buttons");

  const againPg = await getPage(`/squadup/new?t=${emily.token}&again=${oldP}`);
  check(againPg.text.includes("Do it again") && againPg.text.includes('value="Beach day"') &&
    againPg.text.includes('value="Lovers Key"') && !againPg.text.includes('value="2020-07-04'),
    "Do it again copies everything but the time");
  notifier.send = realSend2;

  console.log("\n=== email rendering ===");
  const N = require("./lib/notify.js");
  const msg = { subject: "Pickleball at Josh's <place>", body: "Gin put it up.", url: "https://x/a/1?t=k",
    actions: [{ label: "I'm in", url: "https://x/r/1?t=k&do=opt%3A1" },
              { label: "Can't make it", url: "https://x/r/1?t=k&do=no", quiet: true }] };
  const h = N.renderHtml(msg, "https://x/p/k");
  check(h.includes("&lt;place&gt;") && !h.includes("<place>"), "email HTML is escaped");
  check(h.includes('href="https://x/r/1?t=k&amp;do=opt%3A1"'), "email buttons link to the one-tap page");
  check(N.renderText(msg, "").includes("Can't make it: https://x/r/1?t=k&do=no"),
    "the plain-text version lists the buttons too");

  console.log("\n=== invites ===");
  const inbox = [];
  const realSend3 = notifier.send;
  notifier.send = async (p, m) => { inbox.push({ to: p, ...m }); return { ok: true }; };
  will.token = (await db.getPersonByEmail("will@x.test")).personal_token;
  raif.token = (await db.getPersonByEmail("raif@x.test")).personal_token;
  const willId = (await db.getPersonByToken(will.token)).id;
  const raifId = (await db.getPersonByToken(raif.token)).id;
  const cat = (await api("/squadup/api/activity", { token: emily.token, title: "Catan", location: "Gin's",
    tag_name: "Board games", primary: "2030-08-01T19:00", backup: "2030-08-02T19:00" })).body.id;
  const catA = await db.getActivity(cat);
  await db.setSubscription(raifId, catA.tag_id, false);
  check(!(await getPage(`/squadup/p/${raif.token}`)).text.includes(`/squadup/a/${cat}?`),
    "before an invite, Raif (not into board games) doesn't see it");

  let cp = await getPage(`/squadup/a/${cat}?t=${emily.token}`);
  check(cp.text.includes("Into Board games") && cp.text.includes("Everyone else"),
    "the picker splits people into the category's fans and everyone else");
  check(cp.text.indexOf(`data-invitee="${willId}"`) < cp.text.indexOf("Everyone else") &&
    cp.text.indexOf(`data-invitee="${raifId}"`) > cp.text.indexOf("Everyone else"),
    "people into the category come first");
  check(!cp.text.includes(`data-invitee="${emilyId}"`), "you can't invite yourself (or the creator)");
  check(!(await getPage(`/squadup/a/${cat}`)).text.includes('id="invited"'),
    "signed-out visitors don't see the invite list");

  inbox.length = 0;
  let iv = await api("/squadup/api/invite", { token: emily.token, activity_id: cat, person_ids: [raifId, willId, raifId] });
  check(iv.status === 200 && iv.body.invited === 2 && iv.body.emailed === 2, "inviting two people emails both once");
  const rInv = inbox.find(m => m.to.id === raifId);
  check(rInv && rInv.subject === "Emily invited you: Catan at Gin's", "the invite says who and what");
  check(rInv && rInv.url.includes(encodeURIComponent(raif.token)) && rInv.actions.length === 4,
    "it signs them in and has one-tap answers");
  inbox.length = 0;
  iv = await api("/squadup/api/invite", { token: will.token, activity_id: cat, person_ids: [raifId] });
  check(iv.body.invited === 0 && inbox.length === 0, "inviting someone already invited sends nothing");
  check((await api("/squadup/api/invite", { token: emily.token, activity_id: cat, person_ids: [emilyId] })).status === 400,
    "inviting only yourself is refused");
  check((await getPage(`/squadup/p/${raif.token}`)).text.includes(`/squadup/a/${cat}?`),
    "once invited, it's on their home page");

  await api("/squadup/api/reply", { token: raif.token, activity_id: cat, do: "no" });
  await api("/squadup/api/reply", { token: will.token, activity_id: cat, do: "all" });
  cp = await getPage(`/squadup/a/${cat}?t=${emily.token}`);
  check(/class="person out"[^>]*>Raif ✗/.test(cp.text) && /class="person in"[^>]*>Will ✓/.test(cp.text),
    "the bottom of the plan lists who's invited and how they answered");
  check(!cp.text.includes(`data-invitee="${raifId}"`), "invited people drop out of the picker");

  inbox.length = 0;
  await api("/squadup/api/activity-edit", { token: emily.token, activity_id: cat, title: "Catan",
    location: "Gin's", tag_id: catA.tag_id, primary: "2030-08-08T19:00", backup: "2030-08-02T19:00" });
  check(inbox.some(m => m.to.id === raifId), "invited people hear about changes, whatever they follow");

  const tooMany = Array.from({ length: 41 }, (_, i) => "nobody-" + i);
  check((await api("/squadup/api/invite", { token: emily.token, activity_id: cat, person_ids: tooMany })).status === 429,
    "one person can't send more than 40 invites a day");
  await api("/squadup/api/cancel", { token: emily.token, activity_id: cat });
  check((await api("/squadup/api/invite", { token: emily.token, activity_id: cat, person_ids: [ginId] })).status === 400,
    "no inviting to a deleted plan");
  notifier.send = realSend3;

  console.log("\n=== send limits ===");
  const L_NT = require("./lib/notify.js");
  const L_fake = { kind: "email", got: [], async send(p) { this.got.push(p.id); } };
  const freshDb = () => require("./lib/db.js").fileAdapter(null);
  const L_g = L_NT.makeGuard(freshDb(), { email: { perPerson: 2, links: 1, total: 3 } });
  const L_pA = { id: "limit-a", email: "a@x" }, L_pB = { id: "limit-b", email: "b@x" };
  const L_msgFn = () => ({ subject: "s", body: "b" });
  for (let i = 0; i < 3; i++) await L_NT.notifyAll(L_fake, [L_pA], L_msgFn, { guard: L_g });
  check(L_fake.got.filter(x => x === "limit-a").length === 2, "no one person gets more than their daily cap");
  const L_r2 = await L_NT.notifyAll(L_fake, [L_pB, L_pB], L_msgFn, { guard: L_g });
  check(L_r2.length === 1 && L_r2.held === 1, "the overall daily cap stops everything past it, and says how many were held");
  const L_g2 = L_NT.makeGuard(freshDb(), { email: { perPerson: 50, links: 1, total: 500 } });
  const L_pC = { id: "limit-c", email: "c@x" };
  await L_NT.notifyAll(L_fake, [L_pC], L_msgFn, { guard: L_g2, kind: "link" });
  const L_r3 = await L_NT.notifyAll(L_fake, [L_pC], L_msgFn, { guard: L_g2, kind: "link" });
  const L_r4 = await L_NT.notifyAll(L_fake, [L_pC], L_msgFn, { guard: L_g2 });
  check(L_r3.held === 1 && L_r4.length === 1, "\"here's your link\" has its own small cap; other mail still goes");
  const L_broken = { countSends: async () => { throw new Error("db down"); }, logSend: async () => { throw new Error("db down"); } };
  const L_g3 = L_NT.makeGuard(L_broken, { email: { perPerson: 1, links: 1, total: 10 } });
  await L_NT.notifyAll(L_fake, [L_pA, L_pA], L_msgFn, { guard: L_g3 });
  check(L_fake.got.filter(x => x === "limit-a").length === 3, "if the database is down, an in-memory count still enforces the caps");

  for (let i = 0; i < 5; i++) await api("/squadup/api/signup", { name: "Spammed", email: "L_victim@x.test" });
  const L_victim = await db.getPersonByEmail("L_victim@x.test");
  const L_linkSends = await db.countSends({ channel: "email", sinceIso: new Date(Date.now() - 864e5).toISOString(),
    person_id: L_victim.id, kind: "link" });
  check(L_linkSends === 3, `typing someone's email into the join form over and over sends at most 3 a day (sent ${L_linkSends})`);
  const dflt = JSON.parse(require("child_process").execFileSync(process.execPath,
    ["-e", "console.log(JSON.stringify(require('./lib/notify.js').LIMITS))"],
    { cwd: __dirname, env: { PATH: process.env.PATH } }).toString());
  check(dflt.email.total <= 100 && dflt.email.perPerson === 15 && dflt.email.links === 3,
    "out of the box: 15 emails per person and 95 total a day (Resend's free tier is 100)");

  console.log("\n=== look and feel ===");
  const K = require("./lib/colors.js");
  check(K.tagHue("Beach") === K.tagHue("Kayaking") && K.tagHue("Kayaking") === K.tagHue("Pool day"),
    "water categories share a color");
  check(K.tagHue("Hiking") === K.tagHue("Camping") && K.tagHue("Hiking") !== K.tagHue("Beach"),
    "outdoor categories share a different one");
  check(K.tagHue("Brunch") !== K.tagHue("Running"), "'run' doesn't match inside 'brunch'");
  check(K.tagHue("Knitting") === K.tagHue("knitting"), "an unrecognized category still gets a steady color");
  const dash = await getPage(`/squadup/p/${emily.token}`);
  check(/href="\/squadup\/a\/[^"?]+\?t=/.test(dash.text),
    "plans on the home page open with your link, so you can vote");
  check(dash.text.includes("--h:"), "cards carry their category color");
  check(!/no app, no password|Nobody gets notified when you join/.test(dash.text),
    "explanatory paragraphs are gone");

  console.log("\n=== token quality ===");
  const t1 = C.newToken(), t2 = C.newToken();
  check(t1 !== t2 && t1.length >= 30, "tokens are long and unique");

  console.log("\n" + (fail.length
    ? "FAILURES:\n - " + fail.join("\n - ") : "ALL SQUAD UP CHECKS PASSED"));
  server.close();
  process.exit(fail.length ? 1 : 0);
})().catch(e => { console.error("harness crashed:", e); server.close(); process.exit(1); });
