/* Drives the real server over real HTTP through the whole lifecycle:
   signup, post, RSVP, suggest, approve, switch, cancel, nudge, and the
   "Let's do this sometime" list. */
process.env.SQUAD_DB_FILE = "/tmp/squadup-test-" + Date.now() + ".json";
process.env.SQUAD_BASE_URL = "http://127.0.0.1:3777/squadup";
// the whole run sends far more mail than a real day would; the limits get
// their own isolated checks below
process.env.SQUAD_EMAIL_PER_PERSON_DAY = "1000";
process.env.SQUAD_EMAIL_PER_DAY = "100000";
process.env.SQUAD_SMS_PER_PERSON_DAY = "1000";
process.env.SQUAD_SMS_PER_DAY = "100000";
process.env.TWILIO_AUTH_TOKEN = "test-twilio-token";   // lets the text-reply webhook check signatures
process.env.SQUAD_PHONE_SIGNUPS_PER_IP_HOUR = "1000";   // the sign-up brake gets its own check below
process.env.SQUAD_PHONE_SIGNUPS_PER_DAY = "1000";

const { server, runNudges, db, notifier } = require("./server/index.js");
const C = require("./lib/core.js");
const fail = [];
const PORT = 3777;
const B = `http://127.0.0.1:${PORT}`;

const check = (cond, msg) => { console.log(`  ${cond ? "ok" : "FAIL"}: ${msg}`); if (!cond) fail.push(msg); };

async function api(path, body) {
  // sign-ups need the two boxes ticked; individual checks below untick them
  if (path === "/squadup/api/signup") body = { agree: true, sms_consent: true, ...body };
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
  const danielle = (await api("/squadup/api/signup", { name: "Danielle", email: "em@x.test" })).body;
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
  await api("/squadup/api/rsvp", { token: danielle.token, activity_id: A, option_id: primary.id });
  await api("/squadup/api/rsvp", { token: danielle.token, activity_id: A, option_id: backup.id });
  let mine = (await db.listResponses(A)).find(r => r.person_id !== null && r.option_ids.length === 2);
  check(!!mine, "one person can say both times work");

  const off = await api("/squadup/api/rsvp", { token: danielle.token, activity_id: A, option_id: primary.id });
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
    token: danielle.token, option_id: pending.id, approve: true
  });
  check(notMine.status === 403, "only the creator can approve a suggestion");

  await api("/squadup/api/option-decide", { token: gin.token, option_id: pending.id, approve: true });
  check((await db.getOption(pending.id)).status === "approved", "approving makes it votable");

  const sug2 = await api("/squadup/api/suggest", {
    token: danielle.token, activity_id: A, starts_at: "2030-04-20T12:00"
  });
  const p2 = (await db.listOptions(A)).find(o => o.status === "pending");
  await api("/squadup/api/option-decide", { token: gin.token, option_id: p2.id, approve: false });
  check(!(await db.getOption(p2.id)), "a dismissed suggestion is removed outright");

  console.log("\n=== the switch suggestion ===");
  // three people back the approved suggestion, only Danielle backs the primary
  for (const t of [will.token, raif.token, danielle.token]) {
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
    token: danielle.token, activity_id: A, option_id: pending.id
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
  const cancelByOther = await api("/squadup/api/cancel", { token: danielle.token, activity_id: A });
  check(cancelByOther.status === 403, "only the creator can call it off");

  await api("/squadup/api/cancel", { token: gin.token, activity_id: A, reason: "Quarry's flooded" });
  const dead = await db.getActivity(A);
  check(!!dead.canceled_at, "canceling marks the activity off");

  const rsvpAfter = await api("/squadup/api/rsvp", {
    token: danielle.token, activity_id: A, option_id: primary.id
  });
  check(rsvpAfter.status === 400, "you can't RSVP to something that's off");
  const cancelPage = await getPage(`/squadup/a/${A}`);
  check(cancelPage.text.includes("Quarry&#39;s flooded"),
    "the reason shows on the page, with the apostrophe escaped");

  console.log("\n=== user text can't inject markup ===");
  const xss = await api("/squadup/api/activity", {
    token: danielle.token, title: "<script>alert(1)</script>", tag_name: "Beach",
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
    token: danielle.token, title: "Beach day", tag_name: "Outdoors", note: "Somewhere new"
  });
  check(idea.status === 200 && !!idea.body.id, "anyone can put an idea on the list");
  const I = idea.body.id;
  check(outbox.length === 0, "posting an idea notifies nobody");
  let members = await db.listIdeaMembers(I);
  check(members.length === 1, "whoever posts it is automatically in");

  const emptyIdea = await api("/squadup/api/idea", { token: danielle.token, title: "  ", tag_name: "Outdoors" });
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
  check(outbox.length === 1 && outbox[0].to === "Danielle",
    "it reaches the other people on the list, not the nudger or anyone else");
  check(/schedule Beach day/.test(outbox[0].subject) && /#idea-/.test(outbox[0].url),
    "and links them straight to the idea on their own page");

  const again = await api("/squadup/api/idea-nudge", { token: danielle.token, idea_id: I });
  check(again.status === 429, "a second nudge the same week is refused, whoever sends it");
  const daniellePage = await getPage(`/squadup/p/${danielle.token}`);
  check(daniellePage.text.includes("Next nudge"), "the page shows when it can go again");

  await db.updateIdea(I, { last_nudge_at: new Date(Date.now() - 8 * 864e5).toISOString() });
  const week = await api("/squadup/api/idea-nudge", { token: danielle.token, idea_id: I });
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
  check(!(await getPage(`/squadup/p/${danielle.token}`)).text.includes("Mini golf"),
    "an expired idea disappears from everyone's page right away");
  const lateJoin = await api("/squadup/api/idea-join", { token: danielle.token, idea_id: stale, on: true });
  check(lateJoin.status === 404, "and can't be joined");
  check((await runNudges()) >= 0 && (await require("./server/index.js").sweepIdeas()) === 1,
    "the sweep archives it quietly");
  check(outbox.length === 0, "nobody is told an idea faded");

  console.log("\n=== leaving ===");
  const lb = (await api("/squadup/api/idea", { token: gin.token, title: "Laser tag", tag_name: "Outdoors" })).body.id;
  await api("/squadup/api/idea-join", { token: danielle.token, idea_id: lb, on: true });
  await api("/squadup/api/idea-join", { token: gin.token, idea_id: lb, on: false });
  check(!(await db.getIdea(lb)).archived_at, "leaving takes your name off; the idea stays for the rest");
  const lastOut = await api("/squadup/api/idea-join", { token: danielle.token, idea_id: lb, on: false });
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
  const emMail = outbox.find(m => m.to === "Danielle");
  check(!!willMail && /You said you were in/.test(willMail.body),
    "people on the list hear about it even if they don't follow that category");
  check(!!emMail && /You said you were in/.test(emMail.body), "everyone on the list hears");
  check(!outbox.some(m => m.to === "Raif"), "the person scheduling it isn't emailed about their own post");
  check(!(await getPage(`/squadup/p/${danielle.token}`)).text.includes('id="idea-' + I + '"'),
    "the idea card is gone from the page");

  const twice = await api("/squadup/api/activity", {
    token: gin.token, title: "Beach day", tag_id: outdoors.id,
    primary: "2030-07-12T10:00", idea_id: I
  });
  check(twice.status === 404, "the same idea can't be scheduled twice");

  const xssIdea = await api("/squadup/api/idea", {
    token: danielle.token, title: "<img src=x onerror=alert(1)>", tag_name: "Outdoors"
  });
  const xssDash = await getPage(`/squadup/p/${danielle.token}`);
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
  danielle.token = (await db.getPersonByEmail("em@x.test")).personal_token;
  const danielleId = (await db.getPersonByToken(danielle.token)).id;
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

  const toEm = sent.find(m => m.to.id === danielleId);
  check(toEm && toEm.subject.startsWith("Pickleball at Josh's place"), "the email title includes the place");
  check(toEm && toEm.url.includes(`?t=${encodeURIComponent(danielle.token)}`),
    "the email's link signs Danielle in");
  check(toEm && toEm.actions.length === 4 && toEm.actions.every(a => a.url.includes("/r/") &&
    a.url.includes(encodeURIComponent(danielle.token))), "it has one-tap buttons: each time, both, can't make it");
  check(!sent.some(m => m.to.id === ginId), "the poster doesn't get their own announcement");

  console.log("\n=== one-tap answers ===");
  const firstBtn = new URL(toEm.actions[0].url);
  const landing = await fetch(B + firstBtn.pathname + firstBtn.search).then(r => r.text());
  check(landing.includes("Saving") && !(await db.listResponses(PK)).some(r => r.person_id === danielleId),
    "just opening the link changes nothing (mail scanners can't answer for you)");
  const doIt = (who, what) => api("/squadup/api/reply", { token: who.token, activity_id: PK, do: what });
  let rr = await doIt(danielle, firstBtn.searchParams.get("do"));
  let emR = () => db.listResponses(PK).then(rs => rs.find(r => r.person_id === danielleId));
  check(rr.body.saved === "in" && (await emR()).option_ids.join() === pkOpts[0].id,
    "tapping a time saves it");
  await doIt(danielle, firstBtn.searchParams.get("do"));
  check((await emR()).option_ids.length === 1, "tapping the same button twice doesn't undo it");
  await doIt(danielle, "no");
  check((await emR()).can_make_it === false && !(await emR()).option_ids.length, "Can't make it saves");
  await doIt(danielle, "all");
  check((await emR()).option_ids.length === 2 && (await emR()).can_make_it, "Both work saves both");
  const savedPage = await getPage(`/squadup/a/${PK}?t=${danielle.token}&saved=in`);
  check(savedPage.text.includes("Saved. You&#39;re in."), "the plan page confirms it");
  check(savedPage.text.includes('Pickleball <span class="at">at Josh&#39;s place</span>'),
    "the plan page shows the place in the title");
  check((await doIt(danielle, "opt:nonsense")).status === 400, "a stale button explains itself");

  console.log("\n=== suggest and approve from email ===");
  sent.length = 0;
  await api("/squadup/api/suggest", { token: danielle.token, activity_id: PK, starts_at: "2030-06-08T10:00" });
  const toGin = sent.find(m => m.to.id === ginId);
  const approveDo = toGin && new URL(toGin.actions[0].url).searchParams.get("do");
  check(approveDo && approveDo.startsWith("approve:"), "the organizer's email has an Add it button");
  check((await doIt(danielle, approveDo)).status === 403, "nobody else can use it");
  sent.length = 0;
  check((await doIt(gin, approveDo)).body.saved === "added", "the organizer adds it in one tap");
  const added = await db.getOption(approveDo.slice(8));
  check(added.status === "approved", "the time is now on the board");
  const newTimeMail = sent.find(m => m.to.id === danielleId);
  check(newTimeMail && newTimeMail.actions[0].url.includes("opt%3A" + added.id),
    "everyone else gets a one-tap 'works for me' for the new time");

  console.log("\n=== editing ===");
  check((await getPage(`/squadup/edit/${PK}?t=${danielle.token}`)).status === 403, "only the creator can open edit");
  const editPage = await getPage(`/squadup/edit/${PK}?t=${gin.token}`);
  check(editPage.status === 200 && editPage.text.includes('value="Josh&#39;s place"') &&
    editPage.text.includes('value="2030-06-06T18:00"'), "the edit form comes pre-filled");
  const planPage = await getPage(`/squadup/a/${PK}?t=${gin.token}`);
  check(planPage.text.includes(`/squadup/edit/${PK}?t=`), "the creator sees an Edit button");
  check(!(await getPage(`/squadup/a/${PK}?t=${danielle.token}`)).text.includes("/squadup/edit/"),
    "nobody else does");

  const base = { token: gin.token, activity_id: PK, title: "Pickleball", location: "Josh's place",
    tag_id: pkA.tag_id, primary: "2030-06-06T18:00", backup: "2030-06-07T18:00", note: "" };
  check((await api("/squadup/api/activity-edit", { ...base, token: danielle.token })).status === 403,
    "nobody else can save edits");
  sent.length = 0;
  let ed = await api("/squadup/api/activity-edit", { ...base, title: "Pickleball doubles", note: "Bring water" });
  check(ed.status === 200 && ed.body.notified === false && sent.length === 0,
    "renaming and notes save quietly");
  check((await db.getActivity(PK)).title === "Pickleball doubles", "the new name sticks");

  await db.updateActivity(PK, { finalize_nudge_sent_at: new Date().toISOString() });
  sent.length = 0;
  ed = await api("/squadup/api/activity-edit", { ...base, title: "Pickleball doubles", primary: "2030-06-13T18:00" });
  const moved = sent.find(m => m.to.id === danielleId);
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
  const where = sent.find(m => m.to.id === danielleId);
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
  const offMail = sent.find(m => m.to.id === danielleId);
  check(offMail && offMail.body.includes("deleted") && offMail.url.includes("?t="),
    "deleting tells everyone who's in, with a signed-in link");
  home = await getPage(`/squadup/p/${danielle.token}`);
  check(!home.text.includes(`/squadup/a/${PK}?`), "deleted plans leave the home page");

  check((await getPage("/squadup/past")).status === 403, "Past Plans needs your link");
  const past = await getPage(`/squadup/past?t=${danielle.token}`);
  check(past.text.includes(`/squadup/a/${oldP}?`) && past.text.includes(`/squadup/a/${PK}?`),
    "Past Plans has both the finished and the deleted plan");
  check(past.text.includes("Deleted") && past.text.includes("Jul 4, 2020"), "marked and dated");
  check(past.text.indexOf(`/squadup/a/${PK}?`) < past.text.indexOf(`/squadup/a/${oldP}?`),
    "newest first");
  check(!past.text.includes(`/squadup/a/${tonight}?`), "today's plan isn't past yet");
  check((await doIt(danielle, "all")).status === 400, "a deleted plan can't be answered");
  check((await api("/squadup/api/rsvp", { token: danielle.token, activity_id: oldP,
    option_id: (await db.listOptions(oldP))[0].id })).status === 400, "neither can one that's over");
  const oldPage = await getPage(`/squadup/a/${oldP}?t=${danielle.token}`);
  check(oldPage.text.includes("This happened Jul 4, 2020") && !oldPage.text.includes("data-vote=\""),
    "a finished plan's page says so and has no answer buttons");

  const againPg = await getPage(`/squadup/new?t=${danielle.token}&again=${oldP}`);
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
  const cat = (await api("/squadup/api/activity", { token: danielle.token, title: "Catan", location: "Gin's",
    tag_name: "Board games", primary: "2030-08-01T19:00", backup: "2030-08-02T19:00" })).body.id;
  const catA = await db.getActivity(cat);
  await db.setSubscription(raifId, catA.tag_id, false);
  check(!(await getPage(`/squadup/p/${raif.token}`)).text.includes(`/squadup/a/${cat}?`),
    "before an invite, Raif (not into board games) doesn't see it");

  let cp = await getPage(`/squadup/a/${cat}?t=${danielle.token}`);
  check(cp.text.includes("Into Board games") && cp.text.includes("Everyone else"),
    "the picker splits people into the category's fans and everyone else");
  check(cp.text.indexOf(`data-invitee="${willId}"`) < cp.text.indexOf("Everyone else") &&
    cp.text.indexOf(`data-invitee="${raifId}"`) > cp.text.indexOf("Everyone else"),
    "people into the category come first");
  check(!cp.text.includes(`data-invitee="${danielleId}"`), "you can't invite yourself (or the creator)");
  check(!(await getPage(`/squadup/a/${cat}`)).text.includes('id="invited"'),
    "signed-out visitors don't see the invite list");

  inbox.length = 0;
  let iv = await api("/squadup/api/invite", { token: danielle.token, activity_id: cat, person_ids: [raifId, willId, raifId] });
  check(iv.status === 200 && iv.body.invited === 2 && iv.body.emailed === 2, "inviting two people emails both once");
  const rInv = inbox.find(m => m.to.id === raifId);
  check(rInv && rInv.subject === "Danielle invited you: Catan at Gin's", "the invite says who and what");
  check(rInv && rInv.url.includes(encodeURIComponent(raif.token)) && rInv.actions.length === 4,
    "it signs them in and has one-tap answers");
  inbox.length = 0;
  iv = await api("/squadup/api/invite", { token: will.token, activity_id: cat, person_ids: [raifId] });
  check(iv.body.invited === 0 && inbox.length === 0, "inviting someone already invited sends nothing");
  check((await api("/squadup/api/invite", { token: danielle.token, activity_id: cat, person_ids: [danielleId] })).status === 400,
    "inviting only yourself is refused");
  check((await getPage(`/squadup/p/${raif.token}`)).text.includes(`/squadup/a/${cat}?`),
    "once invited, it's on their home page");

  await api("/squadup/api/reply", { token: raif.token, activity_id: cat, do: "no" });
  await api("/squadup/api/reply", { token: will.token, activity_id: cat, do: "all" });
  cp = await getPage(`/squadup/a/${cat}?t=${danielle.token}`);
  check(/class="person out"[^>]*>Raif ✗/.test(cp.text) && /class="person in"[^>]*>Will ✓/.test(cp.text),
    "the bottom of the plan lists who's invited and how they answered");
  check(!cp.text.includes(`data-invitee="${raifId}"`), "invited people drop out of the picker");

  inbox.length = 0;
  await api("/squadup/api/activity-edit", { token: danielle.token, activity_id: cat, title: "Catan",
    location: "Gin's", tag_id: catA.tag_id, primary: "2030-08-08T19:00", backup: "2030-08-02T19:00" });
  check(inbox.some(m => m.to.id === raifId), "invited people hear about changes, whatever they follow");

  const tooMany = Array.from({ length: 41 }, (_, i) => "nobody-" + i);
  check((await api("/squadup/api/invite", { token: danielle.token, activity_id: cat, person_ids: tooMany })).status === 429,
    "one person can't send more than 40 invites a day");
  await api("/squadup/api/cancel", { token: danielle.token, activity_id: cat });
  check((await api("/squadup/api/invite", { token: danielle.token, activity_id: cat, person_ids: [ginId] })).status === 400,
    "no inviting to a deleted plan");
  notifier.send = realSend3;

  console.log("\n=== send limits ===");
  const L_NT = require("./lib/notify.js");
  const L_fake = { kind: "email", got: [], async send(p) { this.got.push(p.id); } };
  const freshDb = () => require("./lib/db.js").fileAdapter(null);
  const L_g = L_NT.makeGuard(freshDb(), { email: { perPerson: 2, links: 1, total: 3 } });
  const L_pA = { id: "limit-a", email: "a@x", confirmed_at: "2030-01-01" }, L_pB = { id: "limit-b", email: "b@x", confirmed_at: "2030-01-01" };
  const L_msgFn = () => ({ subject: "s", body: "b" });
  for (let i = 0; i < 3; i++) await L_NT.notifyAll(L_fake, [L_pA], L_msgFn, { guard: L_g });
  check(L_fake.got.filter(x => x === "limit-a").length === 2, "no one person gets more than their daily cap");
  const L_r2 = await L_NT.notifyAll(L_fake, [L_pB, L_pB], L_msgFn, { guard: L_g });
  check(L_r2.length === 1 && L_r2.held === 1, "the overall daily cap stops everything past it, and says how many were held");
  const L_g2 = L_NT.makeGuard(freshDb(), { email: { perPerson: 50, links: 1, total: 500 } });
  const L_pC = { id: "limit-c", email: "c@x", confirmed_at: "2030-01-01" };
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

  console.log("\n=== inviting someone new (email only, texting off) ===");
  const NN = require("./lib/notify.js");
  const box = [];
  const realSend4 = notifier.send;
  notifier.send = async (p, m) => { box.push({ to: p, ...m }); return { ok: true }; };
  const bbq = (await api("/squadup/api/activity", { token: gin.token, title: "BBQ", location: "the lake house",
    tag_name: "BBQ", primary: "2030-09-12T17:00", backup: "2030-09-13T17:00" })).body.id;
  const bbqTag = (await db.getActivity(bbq)).tag_id;
  const inviteNew = (who, fields) => api("/squadup/api/invite-new", { token: who.token, activity_id: bbq, ...fields });

  box.length = 0;
  let nv = await inviteNew(gin, { name: "Tresa", email: "tresa@x.test", phone: "" });
  const tresa = await db.getPersonByEmail("tresa@x.test");
  check(nv.status === 200 && nv.body.isNew && tresa && tresa.invited_by === ginId && !tresa.confirmed_at,
    "a new person is added, marked as invited by Gin and not yet confirmed");
  const tMail = box.find(m => m.to.id === tresa.id);
  check(tMail && tMail.subject === "Gin invited you: BBQ at the lake house" && /Squad Up is how Gin's friends/.test(tMail.body),
    "they get an invite that explains what Squad Up is");
  check(tMail && tMail.actions.length === 4 && tMail.url.includes(encodeURIComponent(tresa.personal_token)),
    "with one-tap answers and a link that signs them in");
  check((await db.subscribersOfTag(bbqTag)).every(x => x.id !== tresa.id), "they don't follow any categories yet");
  check(/only message you'll get from us unless you say you're in/.test(tMail.body),
    "the invite tells them it's the only message unless they say they're in");
  check(!!(await db.getPerson(tresa.id)).invite_sent_at, "their one invite is recorded");
  check((await inviteNew(gin, { name: "No Contact" })).status === 400, "a new person needs a phone or email");
  check((await inviteNew(gin, { name: "Phone Only", phone: "239-555-0199" })).body.error === "Add an email too. Texting isn't switched on yet.",
    "while texting is off, a phone number alone isn't enough");
  check((await inviteNew(gin, { name: "Bad", email: "x@y.test", phone: "12" })).status === 400, "a bad phone number is caught");
  const before = (await db.listPeople()).length;
  nv = await inviteNew(gin, { name: "Danielle Again", email: "EM@x.test" });
  check(nv.body.isNew === false && (await db.listPeople()).length === before, "an existing email just invites that person");
  check((await inviteNew(gin, { name: "Me", email: "gin@x.test" })).status === 400, "you can't invite yourself");
  check(!(await db.listResponses(bbq)).some(r => r.person_id === tresa.id), "nothing is answered for them");
  const bowl = (await api("/squadup/api/activity", { token: danielle.token, title: "Bowling", tag_name: "Bowling night", primary: "2030-09-20T19:00" })).body.id;
  const bowlTag = (await db.getTagByName("Bowling night")).id;
  check(!(await db.subscribersOfTag(bowlTag)).some(x => x.id === tresa.id),
    "a brand-new category doesn't sweep in people who haven't answered");

  console.log("\n=== one message until they opt in ===");
  box.length = 0;
  const reInv = await api("/squadup/api/invite", { token: danielle.token, activity_id: bowl, person_ids: [tresa.id] });
  check(reInv.status === 200 && reInv.body.invited === 1 && reInv.body.waiting === 1 && !box.some(m => m.to.id === tresa.id),
    "a second invite before they've said yes is added to the plan but not sent");
  check((await getPage(`/squadup/a/${bowl}?t=${danielle.token}&invited=1&waiting=1`)).text.includes("haven't said they're in yet"),
    "and the inviter is told why");
  box.length = 0;
  await api("/squadup/api/activity-edit", { token: gin.token, activity_id: bbq, title: "BBQ", location: "the lake house",
    tag_id: bbqTag, primary: "2030-09-12T18:00", backup: "2030-09-13T17:00" });
  check(box.length > 0 && !box.some(m => m.to.id === tresa.id), "plan updates skip them too");
  const tPage = await getPage(`/squadup/p/${tresa.personal_token}`);
  check(tPage.text.includes("Want Squad Up messages?") && !(await db.getPerson(tresa.id)).confirmed_at,
    "opening their page doesn't opt them in; it offers a button instead");

  const tDo = new URL(tMail.actions[0].url).searchParams.get("do");
  await api("/squadup/api/reply", { token: tresa.personal_token, activity_id: bbq, do: tDo });
  const tresa2 = await db.getPerson(tresa.id);
  check(!!tresa2.confirmed_at, "answering the invite makes them a full member");
  check((await db.subscribersOfTag(bbqTag)).some(x => x.id === tresa.id), "and saying yes follows that category");
  const tLater = await NN.notifyAll(notifier, [tresa2], () => ({ subject: "s", body: "b" }));
  check(tLater.length === 1, "and from then on they get messages");
  check(!(await getPage(`/squadup/p/${tresa.personal_token}`)).text.includes("Want Squad Up messages?"),
    "and the opt-in button goes away");

  for (let i = 0; i < 9; i++) await inviteNew(gin, { name: "Friend " + i, email: `friend${i}@x.test` });
  const eleventh = await inviteNew(gin, { name: "One too many", email: "toomany@x.test" });
  check(eleventh.status === 429 && /10 new people/.test(eleventh.body.error), "one person can add at most 10 new people a day");
  const fr = await db.getPersonByEmail("friend0@x.test");
  await api("/squadup/api/reply", { token: fr.personal_token, activity_id: bbq, do: "no" });
  check(!(await db.getPerson(fr.id)).confirmed_at, "saying no doesn't opt them in");
  const frQuiet = await NN.notifyAll(notifier, [await db.getPerson(fr.id)], () => ({ subject: "s", body: "b" }));
  check(frQuiet.length === 0 && frQuiet.waiting === 1, "so nothing more reaches them");
  const frLink = await NN.notifyAll(notifier, [await db.getPerson(fr.id)], () => ({ subject: "s", body: "b" }), { kind: "link" });
  check(frLink.length === 1, "except a link they ask for themselves on the site");
  check((await api("/squadup/api/optin", { token: fr.personal_token })).status === 400 && !(await db.getPerson(fr.id)).confirmed_at,
    "the button does nothing unless the consent box is checked");
  await api("/squadup/api/optin", { token: fr.personal_token, consent: true });
  check(!!(await db.getPerson(fr.id)).confirmed_at, "the \"Get Squad Up messages\" button opts them in");
  const fr1 = await db.getPersonByEmail("friend1@x.test");
  await api("/squadup/api/subscribe", { token: fr1.personal_token, tag_id: bowlTag, on: true });
  check(!!(await db.getPerson(fr1.id)).confirmed_at, "so does following a category");
  check((await api("/squadup/api/signup", { name: "Pho Ne", phone: "2395550142" })).status === 400,
    "signing up needs an email while texting is off");

  console.log("\n=== stop all messages ===");
  check((await getPage(`/squadup/stop?t=${tresa.personal_token}`)).text.includes("Stop all messages"), "the stop page asks first");
  await api("/squadup/api/stop", { token: tresa.personal_token });
  check(!!(await db.getPerson(tresa.id)).opted_out_at, "stopping is saved");
  const quiet = await NN.notifyAll(notifier, [await db.getPerson(tresa.id)], () => ({ subject: "s", body: "b" }));
  check(quiet.length === 0 && quiet.unreachable === 1, "they get nothing after that");
  check((await getPage(`/squadup/p/${tresa.personal_token}`)).text.includes("Your messages are off"),
    "their page says so, with a way back");
  check(!(await getPage(`/squadup/a/${bbq}?t=${gin.token}`)).text.includes(`data-invitee="${tresa.id}"`),
    "people who stopped messages drop out of the invite picker");
  await api("/squadup/api/stop", { token: tresa.personal_token, off: false });
  check(!(await db.getPerson(tresa.id)).opted_out_at, "and they can turn messages back on");
  const footer = NN.renderHtml({ subject: "s", body: "b" }, "https://x/p/k", "https://x/stop?t=k");
  check(footer.includes("Stop all Squad Up messages") && footer.includes("https://x/stop?t=k"),
    "every email has a stop link at the bottom");

  console.log("\n=== texting on: invites, replies, STOP ===");
  const texts = [];
  notifier.send = realSend4;
  const realEmail = notifier.backends.email;
  notifier.backends.email = { kind: "email", async send(p, m) { box.push({ to: p, ...m }); } };
  notifier.backends.sms = { kind: "sms", async send(p, m) { texts.push({ to: p, text: NN.renderSms(m, NN.link(p)), m }); } };
  const smsIn = async (from, text, sign = true, extra = {}) => {
    const params = { From: from, Body: text, To: "+12395550000", MessageSid: "SM" + Math.random(), ...extra };
    const r = await fetch(B + "/squadup/sms/inbound", { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": sign ? NN.twilioSignature("test-twilio-token", process.env.SQUAD_BASE_URL + "/sms/inbound", params) : "nope" },
      body: new URLSearchParams(params).toString() });
    return { status: r.status, text: await r.text() };
  };

  texts.length = 0;
  nv = await inviteNew(danielle, { name: "Todd", phone: "(239) 555-0177" });
  const todd = await db.getPersonByPhone("+12395550177");
  check(nv.status === 200 && todd && !todd.email, "with texting on, a phone number alone works (stored as +12395550177)");
  const tText = texts.find(x => x.to.id === todd.id);
  check(tText && /^Danielle invited you to BBQ at the lake house/.test(tText.text), "the invite goes out as a text");
  check(tText && tText.text.includes("Reply 1 for") && tText.text.includes("BOTH or NO") && tText.text.includes("Reply STOP to opt out."),
    "it says how to answer by text, and how to opt out");
  check(tText && tText.text.includes(encodeURIComponent(todd.personal_token)), "and has their signed-in link");

  check((await smsIn("+12395550177", "2", false)).status === 403, "a reply without Twilio's signature is refused");
  let back = await smsIn("+1 (239) 555-0177", "2");
  let toddR = (await db.listResponses(bbq)).find(r => r.person_id === todd.id);
  const bbqOpts = (await db.listOptions(bbq)).sort((x, y) => x.starts_at.localeCompare(y.starts_at));
  check(toddR && toddR.option_ids.join() === bbqOpts[1].id, "texting \"2\" picks the second time");
  check(/<Message>Welcome to Squad Up by Extrarandom! Texts about your plans\. Msg frequency varies\. Msg&amp;data rates may apply\. Reply HELP for help, STOP to cancel\. Got it, you(&apos;|')re in/.test(back.text),
    "and the reply text opens with the program name and disclosures, then confirms it");
  check(tText && tText.text.includes("Reply STOP to opt out. Msg&data rates may apply."),
    "the one-time invite text also says how to stop and that rates may apply");
  check(tText && tText.text.includes("No more texts unless you say you're in."),
    "the first text says it's the only one unless they say they're in");
  check(!!(await db.getPerson(todd.id)).confirmed_at, "a texted answer makes them a member too");
  await smsIn("+12395550177", "Both!");
  toddR = (await db.listResponses(bbq)).find(r => r.person_id === todd.id);
  check(toddR.option_ids.length === 2, "\"Both!\" takes both times");
  await smsIn("+12395550177", "nope");
  toddR = (await db.listResponses(bbq)).find(r => r.person_id === todd.id);
  check(toddR.can_make_it === false, "\"nope\" means can't make it");
  back = await smsIn("+12395550177", "what time is it");
  check(back.text.includes("reply YES or NO"), "anything else gets a short how-to");
  back = await smsIn("+19995550000", "yes");
  check(back.text.includes("<Response></Response>"), "texts from unknown numbers get no reply");

  await db.updatePerson(ginId, { phone: "+12395550001" });
  texts.length = 0;
  await api("/squadup/api/suggest", { token: todd.personal_token, activity_id: bbq, starts_at: "2030-09-14T17:00" });
  const toGinText = texts.find(x => x.to.id === ginId);
  check(toGinText && toGinText.text.includes("Reply ADD"), "the organizer can add a suggested time by text");
  await smsIn("+12395550001", "add");
  const addedOpt = (await db.listOptions(bbq)).find(o => o.starts_at === "2030-09-14T17:00");
  check(addedOpt && addedOpt.status === "approved", "texting ADD puts it on the board");
  const toddNew = texts.find(x => x.to.id === todd.id && x.text.includes("Reply YES or NO"));
  check(!!toddNew, "and everyone gets a yes/no text for the new time");
  await smsIn("+12395550177", "yes");
  toddR = (await db.listResponses(bbq)).find(r => r.person_id === todd.id);
  check(toddR.option_ids.includes(addedOpt.id) && toddR.option_ids.length === 1,
    "a plain YES answers the last thing they were asked (the new time)");

  nv = await inviteNew(danielle, { name: "Uma", phone: "239-555-0166" });
  const uma = await db.getPersonByPhone("+12395550166");
  back = await smsIn("+12395550166", "no");
  check(!(await db.getPerson(uma.id)).confirmed_at && /We won(&apos;|')t text you again/.test(back.text),
    "a texted NO from someone new isn't an opt-in, and the reply says we won't text again");
  texts.length = 0;
  await api("/squadup/api/activity-edit", { token: gin.token, activity_id: bbq, title: "BBQ", location: "the lake house",
    tag_id: bbqTag, primary: "2030-09-12T19:00", backup: "2030-09-13T17:00" });
  check(!texts.some(x => x.to.id === uma.id), "and they get nothing after that");
  back = await smsIn("+12395550166", "yes");
  check(!!(await db.getPerson(uma.id)).confirmed_at, "until they text YES");

  await smsIn("+12395550177", "STOP");
  check(!!(await db.getPerson(todd.id)).opted_out_at, "texting STOP turns everything off");
  texts.length = 0;
  await api("/squadup/api/activity-edit", { token: gin.token, activity_id: bbq, title: "BBQ", location: "the lake house",
    tag_id: bbqTag, primary: "2030-09-19T17:00", backup: "2030-09-13T17:00" });
  check(!texts.some(x => x.to.id === todd.id), "so changes don't reach them");
  back = await smsIn("+12395550177", "START");
  check(!(await db.getPerson(todd.id)).opted_out_at && /you(&apos;|')re back on/.test(back.text) && back.text.includes("Msg&amp;data rates may apply"),
    "START turns it back on, with the disclosures");

  console.log("\n=== consent wording and the public pages ===");
  back = await smsIn("+12395550177", "HELP");
  check(/Squad Up by Extrarandom/.test(back.text) && back.text.includes("GinZ@Extrarandom.com") &&
        back.text.includes("Msg&amp;data rates may apply") && back.text.includes("Reply STOP to opt out"),
    "HELP names the program, gives a support email, and says how to stop");
  back = await smsIn("+12395550177", "HELP", true, { OptOutType: "HELP" });
  check(back.text.includes("<Response></Response>"), "when Twilio already answered HELP, we stay quiet (no double reply)");
  back = await smsIn("+12395550177", "START", true, { OptOutType: "START" });
  check(back.text.includes("<Response></Response>") && !(await db.getPerson(todd.id)).opted_out_at,
    "same for START, and it still turns them back on");

  let c1 = await api("/squadup/api/signup", { name: "Nora", email: "nora@x.test", agree: false });
  check(c1.status === 400 && /Terms/.test(c1.body.error), "signing up needs the Terms box ticked");
  c1 = await api("/squadup/api/signup", { name: "Nora", phone: "239-555-0188", sms_consent: false });
  check(c1.status === 400 && /Text me/.test(c1.body.error) && !(await db.getPersonByPhone("+12395550188")),
    "a phone number needs the text box ticked, and nothing is saved without it");
  c1 = await api("/squadup/api/signup", { name: "Nora", email: "nora@x.test", phone: "239-555-0188", sms_consent: false });
  check(c1.status === 400, "even with an email, a phone number needs the box");
  c1 = await api("/squadup/api/signup", { name: "Nora", email: "nora@x.test", sms_consent: false });
  check(c1.status === 200, "email-only sign-up works without agreeing to texts");

  texts.length = 0;
  c1 = await api("/squadup/api/signup", { name: "Nan", phone: "239-555-0189" });
  const nanT = texts.find(x => x.to.phone === "+12395550189");
  check(c1.status === 200 && nanT && nanT.text.startsWith("Welcome to Squad Up by Extrarandom!") &&
        /Msg&data rates may apply/.test(nanT.text) && /Reply HELP for help, STOP to cancel/.test(nanT.text) &&
        /Msg frequency varies/.test(nanT.text),
    "signing up with a phone sends the opt-in text, disclosures first");
  check(nanT && nanT.text.indexOf("Welcome") < nanT.text.indexOf("http"), "and the link comes after the disclosures");

  nv = await inviteNew(danielle, { name: "Vera", phone: "239-555-0133" });
  const vera = await db.getPersonByPhone("+12395550133");
  texts.length = 0;
  await api("/squadup/api/optin", { token: vera.personal_token, consent: true });
  const veraT = texts.find(x => x.to.id === vera.id);
  check(veraT && veraT.text.startsWith("Welcome to Squad Up by Extrarandom!") && !!(await db.getPerson(vera.id)).confirmed_at,
    "turning messages on from the home page sends the opt-in text");

  process.env.SQUAD_FIRST_TEXT = "off";
  texts.length = 0; box.length = 0;
  nv = await inviteNew(danielle, { name: "Wes", email: "wes@x.test", phone: "239-555-0144" });
  const wes = await db.getPersonByEmail("wes@x.test");
  check(!texts.some(x => x.to.id === wes.id) && box.some(x => x.to.id === wes.id),
    "with the first-text switch off, a brand-new person is emailed, not texted");
  nv = await inviteNew(danielle, { name: "Xena", phone: "239-555-0145" });
  const xena = await db.getPersonByPhone("+12395550145");
  check(!texts.some(x => x.to.id === xena.id) && nv.body.unreachable === 1,
    "and a new person with only a phone is left alone");
  delete process.env.SQUAD_FIRST_TEXT;

  const joinHtml = (await getPage("/squadup/join")).text;
  check(/id="agree"/.test(joinHtml) && /id="sms"/.test(joinHtml) && !/<input type="checkbox"[^>]*checked/.test(joinHtml),
    "the join page has both checkboxes, and neither is pre-checked");
  check(/Msg &amp; data rates may apply/.test(joinHtml) && /<b>HELP<\/b>/.test(joinHtml) && /<b>STOP<\/b>/.test(joinHtml) &&
        /Msg frequency varies/.test(joinHtml) && /href="\/squadup\/terms"/.test(joinHtml) && /href="\/squadup\/privacy"/.test(joinHtml),
    "it states frequency, rates, HELP and STOP, and links the Terms and Privacy Policy");
  const termsHtml = await getPage("/squadup/terms"), privHtml = await getPage("/squadup/privacy");
  check(termsHtml.status === 200 && /Squad Up/.test(termsHtml.text) && /Message and data rates may apply/.test(termsHtml.text) &&
        /<b>STOP<\/b>/.test(termsHtml.text) && /<b>HELP<\/b>/.test(termsHtml.text) && /GinZ@Extrarandom\.com/.test(termsHtml.text) &&
        /not liable for delayed or undelivered/.test(termsHtml.text) && /href="\/squadup\/privacy"/.test(termsHtml.text) &&
        /Limited to \d+ messages a day, and usually far fewer/.test(termsHtml.text),
    "the Terms page has the program, frequency, rates, bold HELP and STOP, support contact, carrier line and Privacy link");
  check(privHtml.status === 200 && /We do not sell or share your SMS opt-in data or personal information with third parties for marketing purposes/.test(privHtml.text) &&
        /Twilio/.test(privHtml.text) && /GinZ@Extrarandom\.com/.test(privHtml.text),
    "the Privacy page has the CTIA no-sharing line, names the providers, and gives a contact");
  check(/href="\/squadup\/terms"/.test((await getPage("/squadup/p/" + gin.token.replace(/^.*\//, ""))).text),
    "every page carries Terms and Privacy links");
  texts.length = 0;
  await api("/squadup/api/invite", { token: gin.token, activity_id: bbq, person_ids: [willId] });
  await db.updatePerson(willId, { phone: "+12395550155" });
  await api("/squadup/api/activity-edit", { token: gin.token, activity_id: bbq, title: "BBQ", location: "the lake house",
    tag_id: bbqTag, primary: "2030-09-26T17:00", backup: "2030-09-13T17:00" });
  check(texts.some(x => x.to.id === willId), "once texting is on, anyone with a phone number gets texts instead of email");

  console.log("\n=== texting test mode ===");
  const envKeep = { ...process.env };
  Object.assign(process.env, { TWILIO_ACCOUNT_SID: "ACtest", TWILIO_FROM: "+15555550000",
    SQUAD_SMS_TEST_NUMBERS: "(239) 555-0101, +1 239 555 0102" });
  const tn = NN.makeNotifier();
  check(tn.channelFor({ id: "a", phone: "+12395550101", email: "a@x.test" }) === "sms" &&
        tn.channelFor({ id: "b", phone: "+12395550102" }) === "sms", "listed test numbers get texts");
  check(tn.channelFor({ id: "c", phone: "+12395550199", email: "c@x.test" }) === "email",
    "everyone else stays on email while texting is in test mode");
  check(tn.channelFor({ id: "d", phone: "+12395550199" }) === null, "and a phone-only person off the list can't be reached");
  check(/test numbers only: 2/.test(tn.kind), "the startup log says it's in test mode");
  delete process.env.SQUAD_SMS_TEST_NUMBERS;
  check(NN.makeNotifier().channelFor({ id: "c", phone: "+12395550199", email: "c@x.test" }) === "sms",
    "with no test list, everyone with a phone gets texts");
  for (const k of ["TWILIO_ACCOUNT_SID", "TWILIO_FROM", "SQUAD_SMS_TEST_NUMBERS"]) {
    if (envKeep[k] === undefined) delete process.env[k]; else process.env[k] = envKeep[k];
  }

  notifier.backends.sms = null;
  notifier.backends.email = realEmail;
  await db.updatePerson(ginId, { phone: null });
  notifier.send = realSend4;


  console.log("\n=== find a time ===");
  const pbox = [];
  const realSendP = notifier.send;
  notifier.send = async (p, m) => { pbox.push({ to: p, ...m }); return { ok: true }; };
  check((await getPage(`/squadup/p/${danielle.token}`)).text.includes(`/squadup/start?t=`), "+ New plan opens the chooser");
  const startPg = await getPage(`/squadup/start?t=${danielle.token}`);
  check(startPg.text.includes("I know when") && startPg.text.includes("Find a time"), "the chooser offers both kinds");
  check((await getPage(`/squadup/find?t=${danielle.token}`)).text.includes("Make the link"), "the Find a time page loads");
  check((await getPage(`/squadup/find`)).status === 403, "starting one needs your own link");
  check((await api("/squadup/api/poll", { token: gin.token, title: "Game night", tag_name: "Game night", options: [] })).status === 400, "it needs at least one date");
  check((await api("/squadup/api/poll", { token: gin.token, title: "Game night", tag_name: "Game night", options: [{ day: "2020-01-01" }] })).status === 400,
    "dates in the past are refused");
  check((await api("/squadup/api/poll", { token: gin.token, title: "Game night", options: [{ day: "2030-11-06" }] })).status === 400,
    "it needs a category, like a plan");
  pbox.length = 0;
  const pmade = await api("/squadup/api/poll", { token: gin.token, title: "Game night", location: "Gin's", tag_name: "Game night",
    options: [{ day: "2030-11-06", time: "19:00" }, { day: "2030-11-07" }, { day: "2030-11-08", time: "18:00" }, { day: "2030-11-07" }] });
  const PID = pmade.body.id;
  check(pmade.status === 200 && PID && pmade.body.url.endsWith("/f/" + PID), "a poll gets its own link");
  const gameTag = (await db.getTagByName("Game night")).id;
  check((await db.getPoll(PID)).tag_id === gameTag, "it has a category");
  const pollNote = pbox.find(m => m.to.id === danielleId);
  check(pollNote && /Gin is picking a date for Game night at Gin's/.test(pollNote.body) && pollNote.url.includes(`/f/${PID}?t=`),
    "people who follow the category hear about it, with their own link");
  check(!pbox.some(m => m.to.id === ginId), "the organizer isn't messaged about their own poll");
  const popts = (await db.listPollOptions(PID)).sort((x, y) => x.day.localeCompare(y.day));
  check(popts.length === 3, "duplicate dates are dropped");
  const [oA, oB, oC] = popts;
  const anon = await getPage(`/squadup/f/${PID}`);
  check(anon.status === 200 && anon.text.includes("Game night") && anon.text.includes("Your name") && anon.text.includes("Fri Nov 8, 6pm"),
    "anyone with the link sees the dates and a name box");

  const vote = (b) => api("/squadup/api/poll-vote", { poll_id: PID, ...b });
  let gv = await vote({ name: "Raif  K", option_ids: [oA.id, oB.id, "not-a-real-id"] });
  check(gv.status === 200 && gv.body.key && gv.body.name === "Raif K", "a guest answers with just a name, and gets a key to change it later");
  const raifKey = gv.body.key;
  check((await db.listPollVotes(PID)).find(v => v.name === "Raif K").option_ids.length === 2, "only real dates are saved");
  check((await vote({ name: "raif k", option_ids: [oC.id] })).status === 409, "someone else can't answer under the same name");
  await vote({ key: raifKey, option_ids: [oC.id] });
  check((await db.listPollVotes(PID)).find(v => v.name === "Raif K").option_ids.join() === oC.id, "the key lets them change their answer");
  check(!(await getPage(`/squadup/f/${PID}`)).text.includes(raifKey), "keys never appear on the page");
  check((await vote({ option_ids: [oA.id] })).status === 400, "a guest without a name is asked for one");
  await vote({ token: danielle.token, option_ids: [oA.id] });
  await vote({ token: danielle.token, option_ids: [oA.id] });
  await vote({ token: will.token, option_ids: [oA.id, oB.id] });
  const pv = await db.listPollVotes(PID);
  check(pv.filter(v => v.person_id === danielleId).length === 1 && pv.find(v => v.person_id === danielleId).name === "Danielle",
    "Squad Up members are recognized by their link, one answer each");
  await vote({ name: "</script><b>x", option_ids: [] });
  const ppage = await getPage(`/squadup/f/${PID}?t=${gin.token}`);
  check(!ppage.text.includes("</script><b>x") && ppage.text.includes("\\u003c/script"), "names can't break the page");
  check(/Most people[\s\S]*?2 of 4/.test(ppage.text.slice(ppage.text.indexOf("Wed Nov 6"))) && ppage.text.indexOf("Most people") > ppage.text.indexOf("Wed Nov 6"),
    "the date most people can make is marked");
  check(ppage.text.includes("None of these work: </script>") === false && ppage.text.includes("None of these work:"),
    "people who can't make any date are listed");
  check(ppage.text.includes("Copy link") && ppage.text.includes("Make it the plan"), "the organizer gets a share box and Make it the plan");
  check(!(await getPage(`/squadup/f/${PID}?t=${danielle.token}`)).text.includes("Make it the plan"), "others don't");

  const homeE = await getPage(`/squadup/p/${danielle.token}`);
  check(homeE.text.includes("Finding a time") && homeE.text.includes(`/squadup/f/${PID}`), "it's on the home page of people who answered");
  check((await getPage(`/squadup/p/${gin.token}`)).text.includes(`/squadup/f/${PID}`), "and whoever started it");
  const pollOutsider = (await api("/squadup/api/signup", { name: "Ollie", email: "ollie@x.test" })).body;
  check(!(await getPage(`/squadup/p/${pollOutsider.token}`)).text.includes(`/squadup/f/${PID}`), "but not everyone's");

  // "if need be"
  await vote({ token: will.token, option_ids: [oA.id], maybe_ids: [oB.id, oA.id] });
  const willV = (await db.listPollVotes(PID)).find(v => v.person_id === willId);
  check(willV.option_ids.join() === oA.id && willV.maybe_ids.join() === oB.id, "\"If need be\" is saved, and a yes beats it on the same date");
  const mbPage = await getPage(`/squadup/f/${PID}?t=${gin.token}`);
  check(mbPage.text.includes("+1 if need be") && mbPage.text.includes("If need be: Will"), "the page shows who could make it if need be");
  const rk = C.pollRanking([{ id: "x", day: "2030-01-01" }, { id: "y", day: "2030-01-02" }],
    [{ name: "a", option_ids: ["y"], maybe_ids: [] }, { name: "b", option_ids: [], maybe_ids: ["x"] }, { name: "c", option_ids: [], maybe_ids: ["x"] }]);
  check(rk[0].score === 1 && rk[1].score === 1 && rk[0].option.id === "y",
    "if need be counts half, and on a tie the outright yes wins");
  const rk2 = C.pollRanking([{ id: "x", day: "2030-01-01" }, { id: "y", day: "2030-01-02" }],
    [{ name: "a", option_ids: ["y"], maybe_ids: [] }, { name: "b", option_ids: [], maybe_ids: ["x"] }]);
  check(rk2[0].option.id === "y", "so one outright yes beats one if need be");

  // editing
  check((await getPage(`/squadup/fedit/${PID}?t=${danielle.token}`)).status === 403, "only the organizer can open the edit page");
  const pollEd = await getPage(`/squadup/fedit/${PID}?t=${gin.token}`);
  check(pollEd.status === 200 && pollEd.text.includes("Save changes") && pollEd.text.includes('value="19:00"'), "the organizer can edit everything");
  const keepAll = (await db.listPollOptions(PID)).map(o => ({ id: o.id, day: o.day, time: o.time }));
  const editBody = (keep, extra) => ({ token: gin.token, poll_id: PID, title: "Game night", location: "Gin's", tag_id: gameTag, keep, ...extra });
  check((await api("/squadup/api/poll-edit", { ...editBody(keepAll), token: danielle.token })).status === 403, "nobody else can save edits");
  const nudged = keepAll.map(o => o.id === oA.id ? { ...o, time: "19:30" } : o);
  pbox.length = 0;
  let pe = await api("/squadup/api/poll-edit", editBody(nudged, { title: "Board game night", note: "Bring a game" }));
  check(pe.status === 200 && (await db.getPoll(PID)).title === "Board game night", "renaming saves");
  check((await db.listPollOptions(PID)).find(o => o.id === oA.id).time === "19:30", "moving a time saves");
  check((await db.listPollVotes(PID)).filter(v => v.option_ids.includes(oA.id)).length === 2, "and everyone's answers stay on it");
  check(pbox.length === 0, "edits go out quietly");
  check((await api("/squadup/api/poll-edit", editBody(nudged.map(o => o.id === oB.id ? { ...o, day: "2030-11-06", time: "19:30" } : o)))).status === 400,
    "two dates can't end up the same");
  check((await api("/squadup/api/poll-edit", editBody(nudged.map(o => o.id === oB.id ? { ...o, day: "2020-01-01" } : o)))).status === 400,
    "a date can't be moved into the past");
  pe = await api("/squadup/api/poll-edit", editBody(nudged.filter(o => o.id !== oC.id), { add: [{ day: "2030-11-10", time: "20:00" }] }));
  const afterOpts = await db.listPollOptions(PID);
  check(pe.body.removed === 1 && !afterOpts.some(o => o.id === oC.id) && afterOpts.some(o => o.day === "2030-11-10"),
    "dates can be removed and added in the same save");
  check(!(await db.listPollVotes(PID)).some(v => v.option_ids.includes(oC.id)), "answers for a removed date go with it");
  check((await api("/squadup/api/poll-edit", editBody([]))).status === 400, "at least one date has to stay");
  const nowOpts = (await db.listPollOptions(PID)).map(o => ({ id: o.id, day: o.day, time: o.id === oA.id ? "19:00" : o.time }));
  await api("/squadup/api/poll-edit", editBody(nowOpts, { title: "Game night", note: "" }));

  // inviting people to vote
  const invPg = await getPage(`/squadup/f/${PID}?t=${gin.token}`);
  check(invPg.text.includes("+ Invite people") && invPg.text.includes("Ask people to vote"), "the organizer has the invite picker");
  check(!(await getPage(`/squadup/f/${PID}?t=${danielle.token}`)).text.includes("+ Invite people"), "others don't");
  const ollieId = (await db.getPersonByToken(pollOutsider.token)).id;
  check(invPg.text.includes(`data-invitee="${ollieId}"`) && !invPg.text.includes(`data-invitee="${danielleId}"`),
    "the picker lists people who haven't answered or been asked");
  check((await api("/squadup/api/poll-invite", { token: danielle.token, poll_id: PID, person_ids: [ollieId] })).status === 403,
    "only the organizer can invite");
  pbox.length = 0;
  let pin = await api("/squadup/api/poll-invite", { token: gin.token, poll_id: PID, person_ids: [ollieId] });
  const toOllie = pbox.find(m => m.to.id === ollieId);
  check(pin.body.invited === 1 && toOllie && /Gin wants to find a time: Game night/.test(toOllie.subject) &&
    toOllie.url.includes(`/f/${PID}?t=`), "invited people get a message with their own link to vote");
  const ollieHome = await getPage(`/squadup/p/${pollOutsider.token}`);
  check(ollieHome.text.includes(`/squadup/f/${PID}`) && ollieHome.text.includes("Your turn"), "and it's on their home page, marked as their turn");
  check((await getPage(`/squadup/f/${PID}?t=${gin.token}`)).text.includes(">Ollie</span>"), "they show under Invited");
  pbox.length = 0;
  const PZ = (await api("/squadup/api/poll", { token: will.token, title: "Tennis", tag_name: "Tennis", options: [{ day: "2030-12-02" }] })).body.id;
  const pzOpt = (await db.listPollOptions(PZ))[0];
  pbox.length = 0;
  pin = await api("/squadup/api/poll-invite-new", { token: will.token, poll_id: PZ, name: "Zed", email: "zed@x.test" });
  const zed = await db.getPersonByEmail("zed@x.test");
  const toZed = pbox.find(m => m.to.id === zed.id);
  check(pin.body.isNew && !zed.confirmed_at && toZed && /only message you'll get from us unless you answer/.test(toZed.body),
    "someone new can be invited by email, and is told it's the only message unless they answer");
  pbox.length = 0;
  const p3 = (await api("/squadup/api/poll", { token: will.token, title: "Brunch", tag_name: "Brunch", options: [{ day: "2030-12-05" }] })).body.id;
  const pin3 = await api("/squadup/api/poll-invite", { token: will.token, poll_id: p3, person_ids: [zed.id] });
  check(pin3.body.waiting === 1 && !pbox.some(m => m.to.id === zed.id), "a second invite waits until they've answered the first");
  await api("/squadup/api/poll-vote", { poll_id: PZ, token: zed.personal_token, option_ids: [], maybe_ids: [pzOpt.id] });
  check(!!(await db.getPerson(zed.id)).confirmed_at, "answering a vote counts as opting in");
  await api("/squadup/api/poll-cancel", { token: will.token, poll_id: p3 });
  await api("/squadup/api/poll-cancel", { token: will.token, poll_id: PZ });

  check((await api("/squadup/api/poll-add", { token: danielle.token, poll_id: PID, options: [{ day: "2030-11-09" }] })).status === 403,
    "only the organizer can add dates");
  await api("/squadup/api/poll-add", { token: gin.token, poll_id: PID, options: [{ day: "2030-11-09" }, { day: "2030-11-07" }] });
  check((await db.listPollOptions(PID)).length === 4, "the organizer can add more (repeats are skipped)");

  const mk = await getPage(`/squadup/new?t=${gin.token}&poll=${PID}&opt=${oA.id}`);
  check(mk.text.includes("Make it a plan") && mk.text.includes('value="2030-11-06T19:00"') && mk.text.includes('value="2030-11-07T18:00"'),
    "Make it the plan fills in that date, with the runner-up as the backup");
  check(mk.text.includes('value="Game night"') && mk.text.includes("value=\"Gin&#39;s\""), "and the name and place");
  check(new RegExp(`<option value="${gameTag}" selected>`).test(mk.text), "and the poll's category");
  check((await getPage(`/squadup/new?t=${danielle.token}&poll=${PID}`)).status === 403, "only the organizer can make it a plan");

  await vote({ token: danielle.token, option_ids: [oA.id, oB.id] });
  pbox.length = 0;
  const fin = await api("/squadup/api/activity", { token: gin.token, title: "Game night", location: "Gin's", tag_id: gameTag,
    primary: "2030-11-06T19:00", backup: "2030-11-07T18:00", poll_id: PID, poll_option_id: oA.id, poll_backup_option_id: oB.id });
  check(fin.status === 200, "posting it makes a real plan");
  const finA = { options: await db.listOptions(fin.body.id), responses: await db.listResponses(fin.body.id) };
  const finPrim = finA.options.find(o => o.kind === "primary"), finBack = finA.options.find(o => o.kind === "backup");
  const rEm = finA.responses.find(r => r.person_id === danielleId), rWill = finA.responses.find(r => r.person_id === willId);
  check(rWill && rWill.option_ids.join() === finPrim.id, "people who said that date works are already in for it");
  check(rEm && rEm.option_ids.includes(finPrim.id) && rEm.option_ids.includes(finBack.id), "and for the backup, if they picked it too");
  check(!rWill.option_ids.includes(finBack.id), "\"if need be\" doesn't sign anyone up; they confirm on the plan");
  const invs = await db.listInvites(fin.body.id);
  check(invs.some(i => i.person_id === danielleId) && invs.some(i => i.person_id === willId), "everyone on Squad Up who answered gets it on their page");
  check(invs.some(i => i.person_id === ollieId) && pbox.some(m => m.to.id === ollieId && /It's set/.test(m.body)),
    "so does anyone invited to vote, even if they didn't");
  const pollToEm = pbox.find(m => m.to.id === danielleId);
  check(pollToEm && /It's set: Game night at Gin's/.test(pollToEm.body) && /you're down as in/.test(pollToEm.body), "and a message saying it's set");
  const pdone = await db.getPoll(PID);
  check(!!pdone.finalized_at && pdone.activity_id === fin.body.id, "the poll is marked done");
  check((await vote({ key: raifKey, option_ids: [oA.id] })).status === 400, "no more answers after that");
  const donePg = await getPage(`/squadup/f/${PID}`);
  check(donePg.text.includes("It's set") && donePg.text.includes(`/squadup/a/${fin.body.id}`), "the poll link now points to the plan");
  check((await api("/squadup/api/activity", { token: gin.token, title: "Again", tag_name: "Game night", primary: "2030-11-06T19:00",
    poll_id: PID })).status === 400, "it can't be made a plan twice");
  check(!(await getPage(`/squadup/p/${danielle.token}`)).text.includes(`/squadup/f/${PID}`), "and it leaves the home page");

  const hikePoll = (await api("/squadup/api/poll", { token: gin.token, title: "Hike", tag_name: "Hiking", options: [{ day: "2030-12-01" }] })).body.id;
  check((await api("/squadup/api/poll-cancel", { token: danielle.token, poll_id: hikePoll })).status === 403, "only the organizer can delete one");
  await api("/squadup/api/poll-cancel", { token: gin.token, poll_id: hikePoll });
  check((await getPage(`/squadup/f/${hikePoll}`)).status === 404, "a deleted one's link stops working");
  notifier.send = realSendP;

  console.log("\n=== look and feel ===");
  const K = require("./lib/colors.js");
  check(K.tagHue("Beach") === K.tagHue("Kayaking") && K.tagHue("Kayaking") === K.tagHue("Pool day"),
    "water categories share a color");
  check(K.tagHue("Hiking") === K.tagHue("Camping") && K.tagHue("Hiking") !== K.tagHue("Beach"),
    "outdoor categories share a different one");
  check(K.tagHue("Brunch") !== K.tagHue("Running"), "'run' doesn't match inside 'brunch'");
  check(K.tagHue("Knitting") === K.tagHue("knitting"), "an unrecognized category still gets a steady color");
  const dash = await getPage(`/squadup/p/${danielle.token}`);
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
