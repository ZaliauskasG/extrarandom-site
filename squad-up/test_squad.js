/* Drives the real server over real HTTP through the whole lifecycle:
   signup, post, RSVP, suggest, approve, switch, cancel, nudge, and the
   "Let's do this sometime" list. */
process.env.SQUAD_DB_FILE = "/tmp/squadup-test-" + Date.now() + ".json";
process.env.SQUAD_BASE_URL = "http://127.0.0.1:3777/squadup";

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
