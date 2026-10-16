/* ============================================================================
   SQUAD UP — views
   Server-rendered HTML. Each page ships its own small script; there is no
   client framework and no build step, matching the rest of extrarandom.
   Words are kept to headlines, one short line under each section, and button
   labels -- the layout and color do the rest.
   ========================================================================== */
const theme = require("./theme");
const C = require("./core");
const { tagStyle } = require("./colors");

const esc = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// JSON for inside a <script> tag: "</script>" in a name can't break out
const js = v => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

const LOGO = `<span class="logo" aria-hidden="true">${
  [4, 46, 128, 192, 296].map(h => `<i style="--h:${h}"></i>`).join("")}</span>`;

function page(title, body, script, opts) {
  const home = opts && opts.token ? `/squadup/p/${esc(opts.token)}` : "/squadup";
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#ffffff">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=M+PLUS+Rounded+1c:wght@500;700;800&display=swap" rel="stylesheet">
<style>${theme}</style></head>
<body>
<header class="top"><div class="wrap">
  <a class="brand" href="${home}">${LOGO}Squad Up</a>
  ${opts && opts.token && !opts.isHome ? `<a class="pill sm homebtn" href="${home}" aria-label="Back to home">‹ Home</a>` : ""}
</div></header>
<main class="wrap">${body}</main>
${script ? `<script>${script}</script>` : ""}
</body></html>`;
}

/* helper JS shared by pages that post JSON */
const POST = `
async function post(url, body){
  const r = await fetch(url, {method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify(body||{})});
  const j = await r.json().catch(()=>({error:"Something went wrong."}));
  if(!r.ok) throw new Error(j.error || "Something went wrong.");
  return j;
}
function show(id,msg,cls){var e=document.getElementById(id);if(e){e.textContent=msg;e.className=cls||"err";}}
`;

/* "2030-04-18T18:00" -> pieces for the date badge */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function whenParts(s) {
  const [d, t] = String(s).split("T");
  const [y, mo, da] = d.split("-").map(Number);
  let [h, mi] = (t || "00:00").split(":").map(Number);
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return {
    day: da, weekday: WEEKDAYS[new Date(y, mo - 1, da).getDay()], month: MONTHS[mo - 1],
    time: mi ? `${h}:${String(mi).padStart(2, "0")}${ampm}` : `${h}${ampm}`
  };
}

const firstName = n => String(n || "").split(" ")[0];

// "Pickleball <at Josh's place>" -- the place in a lighter weight
const titleHtml = a => esc(a.title) +
  (a.location ? ` <span class="at">at ${esc(a.location)}</span>` : "");

const sub = text => `<p class="sub">${text}</p>`;
const longDate = s => { const w = whenParts(s); return `${w.month} ${w.day}, ${String(s).slice(0, 4)}`; };

// "Gin, Emily and Will" / "Gin, Emily, Will and 3 more"
// full names for poll answers, where two Emilys need telling apart
function fullList(names) {
  if (names.length <= 6) return names.length > 1 ? names.slice(0, -1).join(", ") + " and " + names[names.length - 1] : names.join("");
  return names.slice(0, 5).join(", ") + ` and ${names.length - 5} more`;
}
function nameList(names) {
  const f = names.map(firstName);
  if (f.length <= 1) return f.join("");
  if (f.length <= 4) return f.slice(0, -1).join(", ") + " and " + f[f.length - 1];
  return f.slice(0, 3).join(", ") + ` and ${f.length - 3} more`;
}

function tagPicker(tags, selectedId) {
  return `<select id="tag">
    ${tags.map(t => `<option value="${esc(t.id)}"${t.id === selectedId ? " selected" : ""}>${esc(t.name)}</option>`).join("")}
    <option value="__new"${tags.length ? "" : " selected"}>New category…</option>
  </select>
  <div id="newtag" class="${tags.length ? "hidden" : ""}">
    <label for="tagname">Category name</label>
    <input id="tagname" placeholder="Kayaking">
  </div>`;
}
const TAGPICKER_JS = `
var sel=document.getElementById("tag");
sel.onchange=function(){ document.getElementById("newtag").classList.toggle("hidden", sel.value!=="__new"); };
function tagFields(){ return { tag_id: sel.value==="__new" ? null : sel.value,
  tag_name: sel.value==="__new" ? document.getElementById("tagname").value : null }; }`;

/* ------------------------------------------------------------------ join -- */
function joinPage(tags, opts) {
  const o = opts || {};
  return page("Join Squad Up", `
<h1>Join the squad</h1>
<div class="bubble plain" style="margin-top:18px">
  <label for="name">Name</label>
  <input id="name" autocomplete="name" placeholder="Gin">
  <label for="email">Email${o.smsOn ? ` <span class="muted">(or phone)</span>` : ""}</label>
  <input id="email" type="email" autocomplete="email" placeholder="you@example.com">
  <label for="phone">Phone <span class="muted">(${o.smsOn ? "for texts" : "optional"})</span></label>
  <input id="phone" type="tel" autocomplete="tel" placeholder="(239) 555-0123">
  ${tags.length ? `<label>I'm into</label>
  <div class="chips" id="chips">
    ${tags.map(t => `<button type="button" class="chip" style="${tagStyle(t)}" data-id="${esc(t.id)}">${esc(t.name)}</button>`).join("")}
  </div>` : ""}
  <div class="row"><button class="go" id="go">Get my link</button></div>
  <div class="err" id="msg"></div>
</div>`, POST + `
var picked = new Set();
document.querySelectorAll(".chip").forEach(function(c){
  c.onclick=function(){ var id=c.dataset.id;
    if(picked.has(id)){picked.delete(id);c.classList.remove("on");}
    else{picked.add(id);c.classList.add("on");} };
});
document.getElementById("go").onclick=async function(){
  var b=this; b.disabled=true; show("msg","");
  try{
    var r = await post("/squadup/api/signup",{
      name:document.getElementById("name").value,
      email:document.getElementById("email").value,
      phone:document.getElementById("phone").value,
      tags:[...picked]${o.activityId ? `, activity_id:${JSON.stringify(o.activityId)}` : ""}
    });
    if(r.emailed){ show("msg","You're already in. We "+(r.via==="text"?"texted":"emailed")+" your link.","ok"); b.disabled=false; }
    else location.href = r.url;
  }catch(e){ show("msg", e.message); b.disabled=false; }
};`);
}

/* ---------------------------------------------------------------- person -- */
function planCard(a, tagById, token) {
  const locked = a.options.find(o => o.id === a.locked_option_id);
  const tag = tagById[a.tag_id];
  const w = locked ? whenParts(locked.starts_at) : null;
  return `<a class="bubble row-card" style="${tagStyle(tag)}"
      href="/squadup/a/${esc(a.id)}?t=${esc(token)}">
    <div class="orb${w ? "" : " hollow"}">${w ? `<b>${w.day}</b><span>${w.weekday}</span>` : `<b>?</b>`}</div>
    <div class="body">
      <h3>${titleHtml(a)}</h3>
      <div class="meta">
        ${w ? `<span>${esc(w.month)} ${w.day}, ${esc(w.time)}</span>` : ""}
        ${tag ? `<span class="tag">${esc(tag.name)}</span>` : ""}
        ${a.inCount ? `<span class="who"><span class="n">${a.inCount} in</span></span>` : ""}
        ${a.pendingCount ? `<span class="tag flag">${a.pendingCount} new time${a.pendingCount > 1 ? "s" : ""}</span>` : ""}
      </div>
    </div>
  </a>`;
}

// Past Plans: the card plus a way to bring it back
function pastCard(a, tagById, token) {
  const tag = tagById[a.tag_id];
  const w = a.locked ? whenParts(a.locked.starts_at) : null;
  const T = esc(token);
  return `<div class="bubble past" style="${tagStyle(tag)}">
    <a class="row-card${a.canceled_at ? " off" : ""}" href="/squadup/a/${esc(a.id)}?t=${T}">
      <div class="orb">${w ? `<b>${w.day}</b><span>${w.month}</span>` : "<b>?</b>"}</div>
      <div class="body">
        <h3>${titleHtml(a)}</h3>
        <div class="meta">
          ${a.locked ? `<span>${esc(longDate(a.locked.starts_at))}</span>` : ""}
          ${tag ? `<span class="tag">${esc(tag.name)}</span>` : ""}
          ${a.canceled_at ? `<span class="tag flag">Deleted</span>`
            : a.inCount ? `<span class="who"><span class="n">${a.inCount} went</span></span>` : ""}
        </div>
      </div>
    </a>
    <div class="row tight"><a class="pill sm" href="/squadup/new?t=${T}&amp;again=${esc(a.id)}">Do it again</a></div>
  </div>`;
}

function pastPage(person, data) {
  const T = person.personal_token;
  const { plans, tagById } = data;
  return page("Past plans · Squad Up", `
<h1>Past plans</h1>
${sub("Everything the squad has done, plus deleted plans. Tap <b>Do it again</b> to bring one back with new times.")}
${plans.length ? plans.map(a => pastCard(a, tagById, T)).join("")
  : `<div class="bubble plain"><p class="empty">Nothing yet. Plans land here the day after they happen.</p></div>`}`,
  "", { token: T });
}

function ideaCard(i, tagById, token) {
  const tag = tagById[i.tag_id];
  const n = i.members.length;
  const soon = new Date(i.expiresAt).getTime() - Date.now() < 30 * 24 * 60 * 60 * 1000;
  const nudge = !i.iAmIn ? "" : i.nudgeAgainAt
    ? `<span class="small muted">Nudged. Next nudge ${esc(C.formatDay(i.nudgeAgainAt))}</span>`
    : n < 2 ? ""
    : `<button class="sm quiet" data-nudge="${esc(i.id)}" data-n="${n - 1}"
         title="Email everyone who's in that someone should schedule this">Nudge</button>`;
  return `<div class="bubble idea" id="idea-${esc(i.id)}" style="${tagStyle(tag)}">
    <div class="row-card">
      <div class="orb hollow"><b>${n}</b><span>in</span></div>
      <div class="body">
        <h3>${esc(i.title)}</h3>
        <div class="meta">
          ${tag ? `<span class="tag">${esc(tag.name)}</span>` : ""}
          ${i.note ? `<span>${esc(i.note)}</span>` : ""}
        </div>
        <div class="who">${esc(nameList(i.members.map(m => m.name)))}</div>
      </div>
    </div>
    <div class="row tight">
      <button class="sm${i.iAmIn ? " on" : ""}" data-join="${esc(i.id)}" data-on="${i.iAmIn ? "0" : "1"}">${
        i.iAmIn ? "You're in ✓" : "I'm in"}</button>
      <a class="pill sm" href="/squadup/start?t=${esc(token)}&amp;idea=${esc(i.id)}">Pick a time</a>
      ${nudge}
    </div>
    ${soon ? `<div class="small muted" style="margin-top:8px">Fades ${esc(C.formatDay(i.expiresAt))}</div>` : ""}
  </div>`;
}

function pollCard(x, token) {
  return `<a class="bubble row-card poll" href="/squadup/f/${esc(x.id)}?t=${esc(token)}">
    <div class="orb hollow"><b>${x.dateCount}</b><span>date${x.dateCount === 1 ? "" : "s"}</span></div>
    <div class="body">
      <h3>${titleHtml(x)}</h3>
      <div class="meta">
        <span>${x.voterCount ? `${x.voterCount} answered` : "No answers yet"}</span>
        ${x.best ? `<span class="tag">Leading: ${esc(x.best.when)} (${x.best.n}${x.best.maybe ? ` +${x.best.maybe}` : ""})</span>` : ""}
        ${x.mine ? `<span class="tag">Yours</span>` : x.waitingOnMe ? `<span class="tag flag">Your turn</span>` : ""}
      </div>
    </div>
  </a>`;
}

function personPage(person, data) {
  const { tags, subs, activities, tagById } = data;
  const ideas = data.ideas || [];
  const mine = new Set(subs);
  const T = person.personal_token;

  return page("Squad Up", `
${data.awaitingOptIn ? `<div class="bubble welcome" id="optinbox"><h3>Want Squad Up messages?</h3>
  <p class="muted" style="margin:4px 0 10px">A friend added you. You won't get texts or emails about plans until you say you're in on one, or turn them on here.</p>
  <button class="sm go" id="optin">Get Squad Up messages</button></div>
<script>document.getElementById("optin").onclick=async()=>{
  const r=await fetch("/squadup/api/optin",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({token:${JSON.stringify(person.personal_token)}})});
  if(r.ok){const b=document.getElementById("optinbox");b.querySelector("h3").textContent="You're in";
    b.querySelector("p").textContent="You'll hear about plans you're invited to and categories you follow.";
    document.getElementById("optin").remove();}
};</script>` : ""}
${person.opted_out_at ? `<div class="bubble notice"><h3>Your messages are off</h3>
  <p class="muted" style="margin:4px 0 10px">You won't get emails or texts about new plans or invites.</p>
  <a class="pill sm" href="/squadup/stop?t=${esc(T)}">Turn them back on</a></div>` : ""}
<div class="head">
  <h1>Hey, ${esc(firstName(person.name))}</h1>
  <a class="pill go" href="/squadup/start?t=${esc(T)}">+ New plan</a>
</div>

<h2>Plans</h2>
${sub("On the calendar. Tap one to say which times work for you.")}
${activities.length ? activities.map(a => planCard(a, tagById, T)).join("")
  : `<div class="bubble plain"><p class="empty">Nothing planned yet.</p></div>`}
<div class="row"><a class="pill sm" href="/squadup/past?t=${esc(T)}">Past plans</a></div>
${(data.polls || []).length ? `
<h2 id="polls">Finding a time</h2>
${sub("Dates up for a vote. Tap one to say which work for you.")}
${data.polls.map(x => pollCard(x, T)).join("")}` : ""}

<h2 id="ideas">Let's do this sometime</h2>
${sub("No date yet. Things people want to do. Add your name if you're in, and anyone can pick a time when it's ready.")}
${ideas.map(i => ideaCard(i, tagById, T)).join("")}
${ideas.length ? "" : `<div class="bubble plain"><p class="empty">No ideas yet.</p></div>`}
<div class="row"><button class="sm" id="ideaopen">+ Add an idea</button></div>
<div id="ideabox" class="bubble plain hidden" style="margin-top:14px">
  <label for="ititle">What do you want to do?</label>
  <input id="ititle" maxlength="120" placeholder="Beach day">
  <label for="tag">Category</label>
  ${tagPicker(tags, null)}
  <label for="inote">Note <span class="muted">(optional)</span></label>
  <input id="inote" maxlength="280" placeholder="Somewhere we haven't been">
  <div class="row"><button class="go" id="ideago">Add idea</button></div>
</div>
<div class="err" id="imsg"></div>

${tags.length ? `<h2>Your categories</h2>
${sub("You get emails about new plans in the lit-up ones. Tap to switch.")}
<div class="chips" id="chips">
  ${tags.map(t => `<button type="button" class="chip${mine.has(t.id) ? " on" : ""}" style="${tagStyle(t)}"
     data-id="${esc(t.id)}" aria-pressed="${mine.has(t.id)}">${esc(t.name)}</button>`).join("")}
</div>
<div class="err" id="msg"></div>` : ""}

<h2>Your private link</h2>
${sub("This is your login. No password, so keep it to yourself.")}
<code class="link">${esc(data.baseUrl)}/p/${esc(T)}</code>
<div class="row"><button class="sm quiet" id="reset">Replace link</button></div>
<div class="err" id="rmsg"></div>`, POST + TAGPICKER_JS + `
var TOKEN=${JSON.stringify(T)};
document.querySelectorAll(".chip").forEach(function(c){
  c.onclick=async function(){
    var on=!c.classList.contains("on");
    c.classList.toggle("on",on); c.setAttribute("aria-pressed",on); show("msg","");
    try{ await post("/squadup/api/subscribe",{token:TOKEN,tag_id:c.dataset.id,on:on}); }
    catch(e){ c.classList.toggle("on",!on); c.setAttribute("aria-pressed",!on); show("msg",e.message); }
  };
});
function backTo(id){ location.hash = id ? "idea-"+id : "ideas"; location.reload(); }
document.querySelectorAll("[data-join]").forEach(function(b){
  b.onclick=async function(){ b.disabled=true; show("imsg","");
    try{ var r=await post("/squadup/api/idea-join",{token:TOKEN,idea_id:b.dataset.join,on:b.dataset.on==="1"});
      backTo(r.removed ? null : b.dataset.join); }
    catch(e){ show("imsg",e.message); b.disabled=false; } };
});
document.querySelectorAll("[data-nudge]").forEach(function(b){
  b.onclick=async function(){
    var n=+b.dataset.n;
    if(!confirm("Email the "+n+" other "+(n===1?"person":"people")+" who are in that someone should schedule this? You get one nudge a week.")) return;
    b.disabled=true; show("imsg","");
    try{ await post("/squadup/api/idea-nudge",{token:TOKEN,idea_id:b.dataset.nudge}); backTo(b.dataset.nudge); }
    catch(e){ show("imsg",e.message); b.disabled=false; } };
});
document.getElementById("ideaopen").onclick=function(){
  var x=document.getElementById("ideabox"); x.classList.toggle("hidden");
  if(!x.classList.contains("hidden")) document.getElementById("ititle").focus(); };
document.getElementById("ideago").onclick=async function(){
  var b=this; b.disabled=true; show("imsg","");
  try{ var r=await post("/squadup/api/idea",Object.assign({token:TOKEN,
      title:document.getElementById("ititle").value,
      note:document.getElementById("inote").value}, tagFields()));
    backTo(r.id); }
  catch(e){ show("imsg",e.message); b.disabled=false; }
};
document.getElementById("reset").onclick=async function(){
  if(!confirm("Get a new private link? Your current one stops working right away.")) return;
  try{ var r=await post("/squadup/api/reset-link",{token:TOKEN}); location.href=r.url; }
  catch(e){ show("rmsg",e.message); }
};`, { token: T, isHome: true });
}

/* -------------------------------------------------------------- activity -- */
function activityPage(a, ctx) {
  const { viewer, isCreator, options, responses, counts, tag, creator,
          suggestion, myResponse, peopleById, over, saved, invites, invitedNote, smsOn } = ctx;
  const style = tagStyle(tag);
  const closed = !!a.canceled_at || !!over;     // nothing left to answer

  const total = responses.length || 1;
  const optHtml = options.map(o => {
    const who = (counts[o.id] || []).map(id => (peopleById[id] || {}).name || "").filter(Boolean);
    const pct = Math.round((who.length / total) * 100);
    const isPlan = o.id === a.locked_option_id;
    const pending = o.status === "pending";
    const mineOn = myResponse && (myResponse.option_ids || []).includes(o.id);
    const label = isPlan ? "The plan" : pending ? "Needs your OK" : o.kind === "backup" ? "Backup" : "Suggested";
    return `<div class="bubble opt${isPlan ? " plan" : ""}${pending ? " pending" : ""}" data-id="${esc(o.id)}" style="${style}">
      <div class="top">
        <div>
          <div class="when">${esc(C.formatWhen(o.starts_at))}</div>
          <div class="meta"><span class="tag${isPlan ? " solid" : ""}">${label}</span>
            ${o.label ? `<span>${esc(o.label)}</span>` : ""}</div>
        </div>
        ${pending ? "" : `<span class="count">${who.length} in</span>`}
      </div>
      ${who.length ? `<div class="who">${esc(nameList(who))}</div>` : ""}
      ${pending ? "" : `<div class="track"><div class="bar" style="width:${pct}%"></div></div>`}
      ${closed ? "" : pending
        ? `<div class="row tight">
             <button class="go sm" data-approve="${esc(o.id)}">Add it</button>
             <button class="quiet sm" data-dismiss="${esc(o.id)}">Dismiss</button>
           </div>`
        : `<div class="row tight">
             <button class="sm${mineOn ? " on" : ""}" data-vote="${esc(o.id)}">${mineOn ? "Works for me ✓" : "This works"}</button>
             ${isCreator && !isPlan ? `<button class="quiet sm" data-lock="${esc(o.id)}">Make it the plan</button>` : ""}
           </div>`}
    </div>`;
  }).join("");

  const out = responses.filter(r => r.can_make_it === false)
    .map(r => (peopleById[r.person_id] || {}).name).filter(Boolean);
  const iAmOut = myResponse && myResponse.can_make_it === false;
  const lockedOpt = options.find(o => o.id === a.locked_option_id);
  const w = lockedOpt ? whenParts(lockedOpt.starts_at) : null;
  const planOrb = `<div class="orb${w ? "" : " hollow"}"${a.canceled_at ? ' style="filter:grayscale(1);opacity:.6"' : ""}>${
    w ? `<b>${w.day}</b><span>${w.weekday}</span>` : "<b>?</b>"}</div>`;
  const T = viewer ? esc(viewer.personal_token) : "";
  const SAVED = { in: "Saved. You're in.", out: "Saved. Marked as can't make it.", added: "Added. Everyone can say if it works." };

  return page(C.fullTitle(a) + " · Squad Up", `
${saved && SAVED[saved] ? `<div class="bubble saved">${esc(SAVED[saved])}</div>` : ""}
${a.canceled_at ? `<div class="bubble notice"><h3>This plan was deleted</h3>
  ${a.canceled_reason ? `<p class="muted" style="margin:4px 0 0">${esc(a.canceled_reason)}</p>` : ""}</div>`
  : over && lockedOpt ? `<div class="bubble plain"><h3>This happened ${esc(longDate(lockedOpt.starts_at))}</h3></div>` : ""}

<div class="title-row${a.canceled_at ? " off" : ""}" style="${style}">
  ${planOrb}
  <h1>${titleHtml(a)}</h1>
</div>
<div style="${style}">
  <div class="meta" style="margin-top:8px">
    ${tag ? `<span class="tag">${esc(tag.name)}</span>` : ""}
    <span>by ${esc(creator ? creator.name : "someone")}</span>
    ${isCreator && !closed ? `<a class="pill sm" href="/squadup/edit/${esc(a.id)}?t=${T}">Edit</a>` : ""}
  </div>
  ${a.note ? `<p style="margin:10px 0 0">${esc(a.note)}</p>` : ""}
</div>

${suggestion && isCreator && !closed ? `<div class="bubble callout" style="${style};margin-top:20px">
  <h3>More people can do ${esc(C.formatWhen(suggestion.to.starts_at))}</h3>
  <p class="muted" style="margin:4px 0 0">${suggestion.toCount} vs ${suggestion.fromCount}</p>
  <div class="row tight"><button class="go sm" data-lock="${esc(suggestion.to.id)}">Move it</button>
  <button class="quiet sm" id="keep">Keep it</button></div>
</div>` : ""}

<h2>When</h2>
${closed ? "" : sub(viewer ? "Tap every time that works for you." : "Add your name below to say which times work.")}
${optHtml}
${out.length ? `<p class="small muted">Can't make it: ${esc(nameList(out))}</p>` : ""}

${closed ? (viewer ? `<div class="row"><a class="pill sm" href="/squadup/new?t=${T}&amp;again=${esc(a.id)}">Do it again</a>
  <a class="pill sm quiet" href="/squadup/past?t=${T}">Past plans</a></div>` : "") : `
<div class="row" style="${style}">
  <button class="sm${iAmOut ? " on" : ""}" id="cant">${iAmOut ? "You're out" : "Can't make it"}</button>
  <button class="sm" id="suggest">Suggest a time</button>
</div>
<div id="sugbox" class="bubble plain hidden" style="margin-top:14px">
  <label for="sugwhen">Time</label>
  <input id="sugwhen" type="datetime-local">
  <label for="sugnote">Note <span class="muted">(optional)</span></label>
  <input id="sugnote" placeholder="After work works better">
  <div class="row" style="${style}"><button class="go" id="sugsend">Send to ${esc(creator ? firstName(creator.name) : "organizer")}</button></div>
</div>
<div class="err" id="msg"></div>`}

${invites ? inviteSection(a, invites, tag, closed, invitedNote, smsOn) : ""}

${!viewer && !closed ? `<h2>Join in</h2>
<div class="bubble" style="${style}">
  <label for="jname">Name</label><input id="jname" autocomplete="name">
  <label for="jemail">Email</label><input id="jemail" type="email" autocomplete="email">
  <label for="jphone">Phone <span class="muted">(optional)</span></label>
  <input id="jphone" type="tel" autocomplete="tel">
  <div class="row"><button class="go" id="join">I'm in</button></div>
  <div class="err" id="jmsg"></div>
</div>` : ""}`, POST + `
var A=${JSON.stringify(a.id)}, TOKEN=${JSON.stringify(viewer ? viewer.personal_token : null)};
function guard(fn){ return async function(){
  if(!TOKEN){ show("msg","Add your name below to join in.");
    var j=document.getElementById("jname"); if(j) j.focus(); return; }
  try{ await fn.apply(this,arguments); }catch(e){ show("msg", e.message); } }; }

document.querySelectorAll("[data-vote]").forEach(function(b){
  b.onclick = guard(async function(){
    await post("/squadup/api/rsvp",{token:TOKEN,activity_id:A,option_id:b.dataset.vote});
    location.reload();
  });
});
document.querySelectorAll("[data-lock]").forEach(function(b){
  b.onclick = guard(async function(){
    await post("/squadup/api/lock",{token:TOKEN,activity_id:A,option_id:b.dataset.lock});
    location.reload();
  });
});
document.querySelectorAll("[data-approve]").forEach(function(b){
  b.onclick = guard(async function(){
    await post("/squadup/api/option-decide",{token:TOKEN,option_id:b.dataset.approve,approve:true});
    location.reload();
  });
});
document.querySelectorAll("[data-dismiss]").forEach(function(b){
  b.onclick = guard(async function(){
    await post("/squadup/api/option-decide",{token:TOKEN,option_id:b.dataset.dismiss,approve:false});
    location.reload();
  });
});
var cant=document.getElementById("cant");
if(cant) cant.onclick = guard(async function(){
  await post("/squadup/api/rsvp",{token:TOKEN,activity_id:A,cant:true}); location.reload(); });
var keep=document.getElementById("keep");
if(keep) keep.onclick=function(){ this.closest(".callout").style.display="none"; };
var sug=document.getElementById("suggest");
if(sug) sug.onclick=function(){ var b=document.getElementById("sugbox"); b.classList.toggle("hidden");
  if(!b.classList.contains("hidden")) document.getElementById("sugwhen").focus(); };
var ss=document.getElementById("sugsend");
if(ss) ss.onclick = guard(async function(){
  await post("/squadup/api/suggest",{token:TOKEN,activity_id:A,
    starts_at:document.getElementById("sugwhen").value,
    label:document.getElementById("sugnote").value});
  location.reload();
});
${inviteJs({ invite: "/squadup/api/invite", inviteNew: "/squadup/api/invite-new", idKey: "activity_id", back: "/squadup/a/" })}
var jb=document.getElementById("join");
if(jb) jb.onclick=async function(){
  this.disabled=true; show("jmsg","");
  try{
    var r=await post("/squadup/api/signup",{
      name:document.getElementById("jname").value,
      email:document.getElementById("jemail").value,
      phone:document.getElementById("jphone").value,
      activity_id:A, tags:[]});
    if(r.emailed){ show("jmsg","You're already in. We "+(r.via==="text"?"texted":"emailed")+" your link.","ok"); this.disabled=false; }
    else location.href="/squadup/a/"+A+"?t="+encodeURIComponent(r.token);
  }catch(e){ show("jmsg",e.message); this.disabled=false; }
};`, { token: viewer ? viewer.personal_token : null });
}


// The invite picker's script, shared by plans and Find-a-time polls. Expects
// A (the plan or poll id) and TOKEN on the page.
function inviteJs(cfg) {
  const back = `"${cfg.back}"+A+"?t="+encodeURIComponent(TOKEN)+"&invited="+r.invited+"&held="+(r.held||0)+` +
    `"&unreachable="+(r.unreachable||0)+"&waiting="+(r.waiting||0)+"#invited"`;
  return `
var picked=new Set();
document.querySelectorAll("[data-invitee]").forEach(function(c){
  c.onclick=function(){ var id=c.dataset.invitee;
    if(picked.has(id)){picked.delete(id);c.classList.remove("on");} else {picked.add(id);c.classList.add("on");}
    c.setAttribute("aria-pressed", picked.has(id));
    var n=document.getElementById("invitesend");
    n.textContent = picked.size ? "Invite " + picked.size : "Invite";
    n.disabled = !picked.size; };
});
var no=document.getElementById("newopen");
if(no) no.onclick=function(){ document.getElementById("newbox").classList.remove("hidden"); no.classList.add("hidden");
  document.getElementById("nname").focus(); };
var ns=document.getElementById("newsend");
if(ns) ns.onclick=async function(){
  ns.disabled=true; show("invmsg","");
  try{
    var r=await post(${JSON.stringify(cfg.inviteNew)},{token:TOKEN,${cfg.idKey}:A,
      name:document.getElementById("nname").value, email:document.getElementById("nemail").value,
      phone:document.getElementById("nphone").value});
    location.href=${back};
  }catch(e){ show("invmsg",e.message); ns.disabled=false; }
};
var io=document.getElementById("inviteopen");
if(io) io.onclick=function(){ var b=document.getElementById("invitebox"); b.classList.toggle("hidden"); };
var isend=document.getElementById("invitesend");
if(isend) isend.onclick=async function(){
  isend.disabled=true; show("invmsg","");
  try{
    var r=await post(${JSON.stringify(cfg.invite)},{token:TOKEN,${cfg.idKey}:A,person_ids:[...picked]});
    location.href=${back};
  }catch(e){ show("invmsg",e.message); isend.disabled=false; }
};
`;
}

/* invites: who's been asked, and a picker for asking more */
const MARK = { in: " ✓", out: " ✗", none: "" };
function inviteSection(a, inv, tag, closed, note, smsOn, words) {
  const w = words || {};
  const people = list => list.map(p => `<button type="button" class="chip" data-invitee="${esc(p.id)}"
      aria-pressed="false">${esc(p.name)}</button>`).join("");
  const anyoneLeft = true;   // there's always "someone new"
  if (closed && !inv.invited.length) return "";
  return `<h2 id="invited">Invited</h2>
${closed ? "" : sub(w.lead || "Ask people personally. They get an email they can answer in one tap.")}
${note ? `<div class="bubble saved">${note.n ? `Invited ${note.n}.` : "They were already invited."}${
    note.held ? ` ${note.held} couldn't be messaged today (daily limit), but they'll see it on the site.` : ""}${
    note.unreachable ? ` ${note.unreachable} can't be reached right now (they turned off messages, or have no email).` : ""}${
    note.waiting ? ` ${note.waiting} already got an invite and haven't said they're in yet, so they weren't messaged again. It's on their page if they look.` : ""}</div>` : ""}
${inv.invited.length ? `<div class="people">${inv.invited.map(p =>
    `<span class="person ${p.status}" title="${p.by ? "Invited by " + esc(p.by) : ""}">${esc(p.name)}${MARK[p.status]}</span>`
  ).join("")}</div>` : `<p class="small muted">Nobody yet.</p>`}
${closed || !anyoneLeft ? "" : `
<div class="row"><button class="sm" id="inviteopen">+ Invite people</button></div>
<div id="invitebox" class="bubble plain hidden" style="margin-top:14px;${tagStyle(tag)}">
  ${inv.into.length ? `<label>Into ${esc(tag ? tag.name : "this")}</label>
  <div class="chips">${people(inv.into)}</div>` : ""}
  ${inv.others.length ? `<label>${inv.into.length ? "Everyone else" : "Everyone"}</label>
  <div class="chips">${people(inv.others)}</div>` : ""}
  ${inv.into.length || inv.others.length ? `<div class="row"><button class="go" id="invitesend" disabled>Invite</button></div>` : ""}
  <div class="newperson">
    <button type="button" class="sm" id="newopen">+ Someone new</button>
    <div id="newbox" class="hidden">
      <label for="nname">Name</label>
      <input id="nname" maxlength="60" autocomplete="off" placeholder="Their name">
      <label for="nemail">Email${smsOn ? ` <span class="muted">(or phone)</span>` : ""}</label>
      <input id="nemail" type="email" autocomplete="off" placeholder="friend@example.com">
      <label for="nphone">Phone <span class="muted">(${smsOn ? "they'll get a text" : "optional, for texts later"})</span></label>
      <input id="nphone" type="tel" autocomplete="off" placeholder="(239) 555-0123">
      <p class="small muted" style="margin:10px 0 0">${w.hint || "They'll get the invite and can answer right from it."}
        This adds them to Squad Up.</p>
      <div class="row"><button class="go" id="newsend">Invite them</button></div>
    </div>
  </div>
  <div class="err" id="invmsg"></div>
</div>`}`;
}

/* ------------------------------------------------------------- new/edit -- */
// One form for a new plan, scheduling an idea, "Do it again", and editing.
function newPage(person, tags, opts) {
  const o = opts || {};
  const idea = o.idea || null;
  const f = o.prefill || (idea ? { title: idea.title, tag_id: idea.tag_id, note: idea.note } : {});
  const edit = !!o.editId;
  const style = f.tag_id ? tagStyle((tags.find(t => t.id === f.tag_id) || {}).name) : "";
  const T = person.personal_token;
  const fp = o.fromPoll || null;
  const heading = edit ? "Edit plan" : fp ? "Make it a plan" : idea ? "Put a time on it" : o.prefill ? "Do it again" : "New plan";
  return page(heading + " · Squad Up", `
<h1>${heading}</h1>
${edit ? sub("Changing the time or place emails everyone who's in. Renames and notes go out quietly.") : ""}
${fp ? sub(`<b>${esc(fp.when)}</b> works for ${fp.n} of ${fp.of}${fp.maybe ? ` (plus ${fp.maybe} if need be)` : ""}. ${f.backup ? "The next most popular date is filled in as the backup. " : ""}Check the time, pick a category, and post it. Squad Up members who answered get it on their page.`) : ""}
<div class="bubble plain" style="margin-top:18px;${style}">
  <label for="title">What</label>
  <input id="title" maxlength="120" placeholder="Pickleball" value="${esc(f.title)}">

  <label for="loc">Where <span class="muted">(optional)</span></label>
  <input id="loc" maxlength="${C.LOCATION_MAX}" placeholder="Josh's place" value="${esc(f.location)}">

  <label for="tag">Category</label>
  ${tagPicker(tags, f.tag_id || null)}

  <label for="p1">When</label>
  <input id="p1" type="datetime-local" value="${esc(f.primary)}">
  <div id="bkwrap">
    <label for="p2">Backup time</label>
    <div class="inline"><input id="p2" type="datetime-local" value="${esc(f.backup)}">
      <button type="button" class="quiet sm" id="bkdel">Remove</button></div>
  </div>
  <div class="row tight hidden" id="bkaddrow">
    <button type="button" class="sm" id="bkadd">+ Backup time</button></div>

  <label for="note">Note <span class="muted">(optional)</span></label>
  <input id="note" placeholder="Bring paddles if you have them" value="${esc(f.note)}">

  <div class="row"><button class="go" id="go">${edit ? "Save changes" : "Post it"}</button>
    ${edit ? `<a class="pill sm quiet" href="/squadup/a/${esc(o.editId)}?t=${esc(T)}">Cancel</a>` : ""}
    ${fp ? `<a class="pill sm quiet" href="/squadup/f/${esc(fp.id)}?t=${esc(T)}">Back to the vote</a>` : ""}</div>
  <div class="err" id="msg"></div>
</div>
${!edit && !fp ? `<p class="small muted" style="margin-top:6px">Not sure when? <a href="/squadup/find?t=${esc(T)}${idea ? `&amp;idea=${esc(idea.id)}` : ""}">Find a time with everyone</a> instead.</p>` : ""}
${edit ? `<div class="row" style="margin-top:36px"><button class="quiet danger sm" id="del">Delete plan</button></div>` : ""}`,
  POST + TAGPICKER_JS + `
var TOKEN=${JSON.stringify(T)}, EDIT=${JSON.stringify(o.editId || null)};
function v(id){ return document.getElementById(id).value; }
// The backup box shows by default to nudge people toward offering a second
// time. Blank means no backup. Phones fill a date box the moment it's
// tapped, so "Remove" is the reliable way to clear one; the backup only
// counts while its box is showing.
function backupVal(){ return document.getElementById("bkwrap").classList.contains("hidden") ? "" : v("p2"); }
document.getElementById("bkadd").onclick=function(){
  document.getElementById("bkwrap").classList.remove("hidden");
  document.getElementById("bkaddrow").classList.add("hidden");
  document.getElementById("p2").focus(); };
// start the backup from the main time, so it's a quick nudge of the day
document.getElementById("p2").addEventListener("focus", function(){
  if(!this.value && v("p1")) this.value = v("p1"); });
document.getElementById("bkdel").onclick=function(){
  document.getElementById("p2").value="";
  document.getElementById("bkwrap").classList.add("hidden");
  document.getElementById("bkaddrow").classList.remove("hidden"); };
document.getElementById("go").onclick=async function(){
  this.disabled=true; show("msg","");
  var fields=Object.assign({token:TOKEN, title:v("title"), location:v("loc"),
      primary:v("p1"), backup:backupVal(), note:v("note")}, tagFields());
  try{
    if(EDIT){
      await post("/squadup/api/activity-edit", Object.assign({activity_id:EDIT}, fields));
      location.href="/squadup/a/"+EDIT+"?t="+encodeURIComponent(TOKEN);
    } else {
      var r=await post("/squadup/api/activity", Object.assign({idea_id:${JSON.stringify(idea ? idea.id : null)},
        poll_id:${js(fp ? fp.id : null)}, poll_option_id:${js(fp ? fp.optionId : null)},
        poll_backup_option_id:${js(fp ? fp.backupOptionId : null)}}, fields));
      location.href="/squadup/a/"+r.id+"?t="+encodeURIComponent(TOKEN);
    }
  }catch(e){ show("msg",e.message); this.disabled=false; }
};
var del=document.getElementById("del");
if(del) del.onclick=async function(){
  var why=prompt("Delete this plan? Everyone who's in gets a note. Add a reason (optional).");
  if(why===null) return;
  try{ await post("/squadup/api/cancel",{token:TOKEN,activity_id:EDIT,reason:why});
    location.href="/squadup/a/"+EDIT+"?t="+encodeURIComponent(TOKEN); }
  catch(e){ show("msg",e.message); }
};`, { token: T });
}


/* ----------------------------------------------------------------- start -- */
// "+ New plan": you already know when, or you want to find a time together.
function startPage(person, ideaId) {
  const T = esc(person.personal_token);
  const idea = ideaId ? `&amp;idea=${esc(ideaId)}` : "";
  return page("New plan · Squad Up", `
<h1>New plan</h1>
${sub("Do you already know when?")}
<a class="bubble row-card choice" href="/squadup/new?t=${T}${idea}">
  <div class="orb"><b>✓</b><span>date</span></div>
  <div class="body"><h3>I know when</h3>
    <p class="muted small" style="margin:4px 0 0">Pick the day and time, plus a backup. Everyone says if they're in.</p></div>
</a>
<a class="bubble row-card choice" href="/squadup/find?t=${T}${idea}" style="--h:276;--l:52%">
  <div class="orb hollow"><b>?</b><span>dates</span></div>
  <div class="body"><h3>Find a time</h3>
    <p class="muted small" style="margin:4px 0 0">Offer a bunch of dates and send a link. People tap what works, no account needed, then you make the winner a plan.</p></div>
</a>`, "", { token: person.personal_token });
}

/* ------------------------------------------------------------------ find -- */
// The calendar for picking dates. Shared by "Find a time" and "+ Add dates".
const CAL_HTML = (id) => `
<div class="cal" id="${id}">
  <div class="calhead">
    <button type="button" class="sm quiet" data-cal="prev" aria-label="Previous month">‹</button>
    <b data-cal="title"></b>
    <button type="button" class="sm quiet" data-cal="next" aria-label="Next month">›</button>
  </div>
  <div class="calgrid" data-cal="grid"></div>
</div>
<div class="slots" data-cal="slots"></div>
<div class="alltime hidden" data-cal="all">
  <label>Same time for all <span class="muted">(optional)</span></label>
  <div class="inline"><input type="time" data-cal="alltime"><button type="button" class="sm" data-cal="apply">Set all</button></div>
</div>`;

// Client side: a month grid where tapping a day adds it, and a list of the
// picked days, each with an optional time (and room for a second time).
const CAL_JS = `
function makeCal(root, slotsEl, allEl, today){
  var MON=["January","February","March","April","May","June","July","August","September","October","November","December"];
  var WD=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"], SM=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  var t=today.split("-").map(Number), y=t[0], m=t[1]-1, slots=[];
  function pad(n){return (n<10?"0":"")+n;}
  function key(yy,mm,dd){return yy+"-"+pad(mm+1)+"-"+pad(dd);}
  function label(d){var p=d.split("-").map(Number);var dt=new Date(p[0],p[1]-1,p[2]);return WD[dt.getDay()]+" "+SM[p[1]-1]+" "+p[2];}
  function has(d){return slots.some(function(s){return s.day===d;});}
  function draw(){
    root.querySelector("[data-cal=title]").textContent=MON[m]+" "+y;
    var first=new Date(y,m,1).getDay(), n=new Date(y,m+1,0).getDate(), h="";
    WD.forEach(function(w){h+="<span class=\\"wd\\">"+w[0]+"</span>";});
    for(var i=0;i<first;i++)h+="<span></span>";
    for(var d=1;d<=n;d++){var k=key(y,m,d), past=k<today;
      h+="<button type=\\"button\\" class=\\"day"+(has(k)?" on":"")+(k===today?" today":"")+"\\" data-day=\\""+k+"\\""+(past?" disabled":"")+
        " aria-pressed=\\""+has(k)+"\\">"+d+"</button>";}
    root.querySelector("[data-cal=grid]").innerHTML=h;
    root.querySelector("[data-cal=prev]").disabled = (y*12+m) <= (t[0]*12+t[1]-1);
    root.querySelectorAll("[data-day]").forEach(function(b){ b.onclick=function(){
      var k=b.dataset.day;
      if(has(k)) slots=slots.filter(function(s){return s.day!==k;});
      else slots.push({day:k,time:""});
      slots.sort(function(a,b){return a.day<b.day?-1:a.day>b.day?1:0;});
      draw(); list(); }; });
  }
  function list(){
    var h="";
    slots.forEach(function(s,i){
      h+="<div class=\\"slot\\"><span class=\\"sday\\">"+label(s.day)+"</span>"+
        "<input type=\\"time\\" data-i=\\""+i+"\\" value=\\""+(s.time||"")+"\\" aria-label=\\"Time for "+label(s.day)+" (optional)\\">"+
        "<button type=\\"button\\" class=\\"sm quiet\\" data-more=\\""+i+"\\" title=\\"Another time this day\\">+ time</button>"+
        "<button type=\\"button\\" class=\\"sm quiet\\" data-del=\\""+i+"\\" aria-label=\\"Remove\\">✕</button></div>";
    });
    slotsEl.innerHTML = slots.length ? h : "<p class=\\"small muted\\" style=\\"margin:10px 0 0\\">Tap days on the calendar. Times are optional.</p>";
    allEl.classList.toggle("hidden", slots.length<2);
    slotsEl.querySelectorAll("input[data-i]").forEach(function(inp){ inp.onchange=inp.oninput=function(){ slots[+inp.dataset.i].time=inp.value; }; });
    slotsEl.querySelectorAll("[data-del]").forEach(function(b){ b.onclick=function(){ slots.splice(+b.dataset.del,1); draw(); list(); }; });
    slotsEl.querySelectorAll("[data-more]").forEach(function(b){ b.onclick=function(){
      var i=+b.dataset.more; slots.splice(i+1,0,{day:slots[i].day,time:""}); list();
      var x=slotsEl.querySelector("input[data-i=\\""+(i+1)+"\\"]"); if(x) x.focus(); }; });
  }
  root.querySelector("[data-cal=prev]").onclick=function(){ m--; if(m<0){m=11;y--;} draw(); };
  root.querySelector("[data-cal=next]").onclick=function(){ m++; if(m>11){m=0;y++;} draw(); };
  allEl.querySelector("[data-cal=apply]").onclick=function(){
    var v=allEl.querySelector("[data-cal=alltime]").value; slots.forEach(function(s){s.time=v;}); list(); };
  draw(); list();
  return { picked:function(){ return slots.map(function(s){return {day:s.day,time:s.time||null};}); } };
}`;

function findPage(person, tags, opts) {
  const o = opts || {};
  const idea = o.idea || null;
  const T = person.personal_token;
  return page("Find a time · Squad Up", `
<h1>Find a time</h1>
${sub("Pick every date that could work. You'll get a link to send. People tap the ones that work for them, with just their name.")}
<div class="bubble plain" style="margin-top:18px">
  <label for="title">What</label>
  <input id="title" maxlength="120" placeholder="Pickleball" value="${esc(idea ? idea.title : "")}">
  <label for="loc">Where <span class="muted">(optional)</span></label>
  <input id="loc" maxlength="${C.LOCATION_MAX}" placeholder="Josh's place">
  <label for="tag">Category</label>
  ${tagPicker(tags, idea ? idea.tag_id : null)}
  <p class="small muted" style="margin:6px 0 0">People who follow it see the vote on their home page and get a message.</p>
  <label>Dates</label>
  ${CAL_HTML("cal")}
  <label for="note">Note <span class="muted">(optional)</span></label>
  <input id="note" maxlength="280" placeholder="Evenings are best" value="${esc(idea && idea.note ? idea.note : "")}">
  <div class="row"><button class="go" id="go">Make the link</button></div>
  <div class="err" id="msg"></div>
</div>`, POST + TAGPICKER_JS + CAL_JS + `
var TOKEN=${js(T)};
var cal=makeCal(document.getElementById("cal"), document.querySelector("[data-cal=slots]"),
  document.querySelector("[data-cal=all]"), ${js(o.today)});
function v(id){ return document.getElementById(id).value; }
document.getElementById("go").onclick=async function(){
  var b=this; b.disabled=true; show("msg","");
  try{
    var r=await post("/squadup/api/poll",Object.assign({token:TOKEN,title:v("title"),location:v("loc"),note:v("note"),
      idea_id:${js(idea ? idea.id : null)}, options:cal.picked()}, tagFields()));
    location.href="/squadup/f/"+r.id+"?t="+encodeURIComponent(TOKEN)+"&created=1";
  }catch(e){ show("msg",e.message); b.disabled=false; }
};`, { token: T });
}

/* ------------------------------------------------------------- poll edit -- */
// Everything is editable. Each existing date can be nudged (answers stay
// with it) or removed; new ones come from the same calendar.
function pollEditPage(person, poll, tags, ctx) {
  const T = person.personal_token;
  const { options, today } = ctx;
  const rows = options.map(o => `<div class="erow" data-oid="${esc(o.id)}" data-answers="${o.answers}">
      <input type="date" value="${esc(o.day)}" aria-label="Date" data-f="day">
      <input type="time" value="${esc(o.time || "")}" aria-label="Time (optional)" data-f="time">
      <button type="button" class="sm quiet" data-rm aria-label="Remove ${esc(o.when)}">✕</button>
      ${o.answers ? `<span class="small muted erow-n">${o.answers} answered</span>` : ""}
    </div>`).join("");
  return page("Edit · " + C.fullTitle(poll), `
<h1>Edit</h1>
${sub("Change anything. Moving a date's day or time keeps everyone's answers on it; removing a date drops its answers. Nobody is messaged about edits.")}
<div class="bubble plain" style="margin-top:18px">
  <label for="title">What</label>
  <input id="title" maxlength="120" value="${esc(poll.title)}">
  <label for="loc">Where <span class="muted">(optional)</span></label>
  <input id="loc" maxlength="${C.LOCATION_MAX}" value="${esc(poll.location)}">
  <label for="tag">Category</label>
  ${tagPicker(tags, poll.tag_id || null)}
  <label for="note">Note <span class="muted">(optional)</span></label>
  <input id="note" maxlength="280" value="${esc(poll.note)}">
  <label>Dates</label>
  <div id="erows">${rows}</div>
  <div class="row tight"><button type="button" class="sm" id="addopen">+ Add dates</button></div>
  <div id="addbox" class="hidden" style="margin-top:12px">${CAL_HTML("cal")}</div>
  <div class="row"><button class="go" id="go">Save changes</button>
    <a class="pill sm quiet" href="/squadup/f/${esc(poll.id)}?t=${esc(T)}">Cancel</a></div>
  <div class="err" id="msg"></div>
</div>
<div class="row" style="margin-top:36px"><button class="quiet danger sm" id="pdel">Delete this vote</button></div>`,
  POST + TAGPICKER_JS + CAL_JS + `
var TOKEN=${js(T)}, P=${js(poll.id)}, cal=null;
function v(id){ return document.getElementById(id).value; }
document.querySelectorAll("[data-rm]").forEach(function(b){ b.onclick=function(){
  var row=b.closest(".erow"), n=+row.dataset.answers;
  if(n && !confirm("Remove this date? "+n+(n===1?" person's answer":" people's answers")+" for it go too.")) return;
  row.remove(); }; });
document.getElementById("addopen").onclick=function(){
  var x=document.getElementById("addbox"); x.classList.toggle("hidden");
  if(!cal) cal=makeCal(document.getElementById("cal"), x.querySelector("[data-cal=slots]"), x.querySelector("[data-cal=all]"), ${js(today)}); };
document.getElementById("go").onclick=async function(){
  var b=this; b.disabled=true; show("msg","");
  var keep=[...document.querySelectorAll(".erow")].map(function(r){ return { id:r.dataset.oid,
    day:r.querySelector("[data-f=day]").value, time:r.querySelector("[data-f=time]").value||null }; });
  try{
    await post("/squadup/api/poll-edit", Object.assign({token:TOKEN, poll_id:P, title:v("title"), location:v("loc"),
      note:v("note"), keep:keep, add: cal ? cal.picked() : []}, tagFields()));
    location.href="/squadup/f/"+P+"?t="+encodeURIComponent(TOKEN)+"&saved=1";
  }catch(e){ show("msg",e.message); b.disabled=false; }
};
document.getElementById("pdel").onclick=async function(){
  if(!confirm("Delete this vote? The link stops working.")) return;
  try{ await post("/squadup/api/poll-cancel",{token:TOKEN,poll_id:P}); location.href="/squadup/p/"+encodeURIComponent(TOKEN); }
  catch(e){ show("msg",e.message); }
};`, { token: T });
}

/* ------------------------------------------------------------------ poll -- */
function pollPage(poll, ctx) {
  const { options, votes, viewer, creator, plan, isCreator, myVote, created, shareUrl,
          tag, invites, invitedNote, smsOn, saved } = ctx;
  const T = viewer ? viewer.personal_token : null;
  const done = !!poll.finalized_at;
  const live = options.filter(o => !o.past);
  const yes = {}, maybe = {}, score = {};
  options.forEach(o => {
    yes[o.id] = votes.filter(v => v.option_ids.includes(o.id)).map(v => v.name);
    maybe[o.id] = votes.filter(v => (v.maybe_ids || []).includes(o.id) && !v.option_ids.includes(o.id)).map(v => v.name);
    score[o.id] = yes[o.id].length + maybe[o.id].length / 2;
  });
  const top = Math.max(0, ...live.map(o => score[o.id]));
  const total = votes.length || 1;
  const none = votes.filter(v => !v.option_ids.length && !(v.maybe_ids || []).length).map(v => v.name);
  const style = tag ? tagStyle(tag) : "--h:276;--l:52%";

  const optHtml = options.map(o => {
    const y = yes[o.id], m = maybe[o.id];
    const lead = !o.past && top > 0 && score[o.id] === top;
    return `<div class="bubble opt${lead ? " plan" : ""}${o.past ? " gone" : ""}" style="${style}">
      <div class="top">
        <div>
          <div class="when">${esc(o.when)}</div>
          ${lead || o.past ? `<div class="meta">${lead ? `<span class="tag solid">Most people</span>` : ""}${
            o.past ? `<span class="tag">Passed</span>` : ""}</div>` : ""}
        </div>
        <span class="count">${y.length} of ${votes.length}${m.length ? `<span class="maybe-n"> +${m.length} if need be</span>` : ""}</span>
      </div>
      ${y.length ? `<div class="who">${esc(fullList(y))}</div>` : ""}
      ${m.length ? `<div class="who soft">If need be: ${esc(fullList(m))}</div>` : ""}
      <div class="track split"><div class="bar" style="width:${Math.round(y.length / total * 100)}%"></div><div class="bar maybe" style="width:${Math.round(m.length / total * 100)}%"></div></div>
      ${done || o.past ? "" : `<div class="row tight">
        <button class="sm" data-pick="${esc(o.id)}" disabled>This works</button>
        <button class="sm soft" data-maybe="${esc(o.id)}" disabled>If need be</button>
        ${isCreator ? `<a class="pill sm quiet" href="/squadup/new?t=${esc(T)}&amp;poll=${esc(poll.id)}&amp;opt=${esc(o.id)}">Make it the plan</a>` : ""}
      </div>`}
    </div>`;
  }).join("");

  return page(C.fullTitle(poll) + " · Squad Up", `
${saved ? `<div class="bubble saved">Saved.</div>` : ""}
${done ? `<div class="bubble callout" style="${style}"><h3>It's set${plan ? `: ${esc(plan.when)}` : ""}</h3>
  ${plan ? `<div class="row tight"><a class="pill go sm" href="/squadup/a/${esc(plan.id)}${T ? `?t=${esc(T)}` : ""}">See the plan</a></div>` : ""}</div>` : ""}
<div class="title-row" style="${style}">
  <div class="orb hollow"><b>${live.length}</b><span>date${live.length === 1 ? "" : "s"}</span></div>
  <h1>${titleHtml(poll)}</h1>
</div>
<div style="${style}">
  <div class="meta" style="margin-top:8px"><span class="tag">${tag ? esc(tag.name) : "Finding a time"}</span>
    <span>Finding a time · by ${esc(creator ? creator.name : "someone")}</span>
    ${isCreator && !done ? `<a class="pill sm" href="/squadup/fedit/${esc(poll.id)}?t=${esc(T)}">Edit</a>` : ""}</div>
  ${poll.note ? `<p style="margin:10px 0 0">${esc(poll.note)}</p>` : ""}
</div>

${isCreator && !done ? `<div class="bubble share" id="share" style="${style};margin-top:20px">
  <h3>${created ? "Your link is ready" : "Share the link"}</h3>
  <p class="muted small" style="margin:4px 0 10px">Send it to anyone. They answer with just their name.</p>
  <code class="link" id="shareurl">${esc(shareUrl)}</code>
  <div class="row tight"><button class="go sm" id="copy">Copy link</button>
    <button class="sm hidden" id="nshare">Share…</button></div>
  <div class="ok" id="cmsg"></div>
</div>` : ""}

${done ? "" : `<div class="bubble plain" id="me" style="margin-top:20px">
  <div id="named" class="hidden"><span class="muted">Answering as</span> <b id="myname"></b>
    <button type="button" class="sm quiet" id="notme">Not you?</button></div>
  <div id="askname" class="hidden">
    <label for="gname">Your name</label>
    <div class="inline"><input id="gname" maxlength="${C.POLL_NAME_MAX}" autocomplete="given-name" placeholder="Emily">
      <button class="go sm" id="gstart">Next</button></div>
  </div>
  <div class="err" id="nmsg"></div>
</div>`}

<h2>Which dates work?</h2>
${done ? "" : sub((votes.length ? `${votes.length} ${votes.length === 1 ? "person has" : "people have"} answered. ` : "Nobody's answered yet. ") +
  "Tap <b>This works</b> on every date you can make, or <b>If need be</b> if you could make it work.")}
${optHtml}
${none.length ? `<p class="small muted">None of these work: ${esc(fullList(none))}</p>` : ""}
<div class="err" id="msg"></div>

${isCreator && !done && live.length ? `<div class="row" style="${style}">
  <a class="pill sm go" href="/squadup/new?t=${esc(T)}&amp;poll=${esc(poll.id)}">Make the leader the plan</a></div>` : ""}

${invites ? `<div style="${style}">${inviteSection(poll, invites, tag, false, invitedNote, smsOn, {
    lead: "Ask people to vote. They get a link to tap the dates that work for them.",
    hint: "They'll get a link to vote." })}</div>` : ""}

${!viewer && !done ? `<p class="small muted" style="margin-top:28px">Squad Up is how friends make plans. <a href="/squadup/join">Join</a> to hear about the next one.</p>` : ""}`,
  POST + `
var P=${js(poll.id)}, A=P, TOKEN=${js(T)}, DONE=${done}, VOTES=${js(votes)},
    MEMBER=${js(viewer ? { name: viewer.name, vote_id: myVote ? myVote.id : null } : null)};
var STORE="squadup-poll-"+P, me=null;
function load(){ try{ return JSON.parse(localStorage.getItem(STORE)||"null"); }catch(e){ return null; } }
function keep(x){ try{ if(x) localStorage.setItem(STORE,JSON.stringify(x)); else localStorage.removeItem(STORE); }catch(e){} }
var picks=new Set(), maybes=new Set();
function mark(){
  document.querySelectorAll("[data-pick]").forEach(function(b){
    var on=picks.has(b.dataset.pick);
    b.disabled=!me; b.classList.toggle("on",on); b.textContent=on?"Works for me ✓":"This works";
    b.setAttribute("aria-pressed",on); });
  document.querySelectorAll("[data-maybe]").forEach(function(b){
    var on=maybes.has(b.dataset.maybe);
    b.disabled=!me; b.classList.toggle("on",on); b.textContent=on?"If need be ✓":"If need be";
    b.setAttribute("aria-pressed",on); });
}
function who(){
  if(DONE) return;
  if(MEMBER){ me={name:MEMBER.name, vote_id:MEMBER.vote_id}; }
  else { var s=load(); me = s && VOTES.some(function(v){return v.id===s.vote_id;}) ? s : null; }
  var mine = me && VOTES.find(function(v){return v.id===me.vote_id;});
  picks=new Set(mine ? mine.option_ids : []); maybes=new Set(mine ? (mine.maybe_ids||[]) : []);
  document.getElementById("named").classList.toggle("hidden",!me);
  document.getElementById("askname").classList.toggle("hidden",!!me);
  var nm=document.getElementById("notme"); if(nm) nm.classList.toggle("hidden",!!MEMBER);
  if(me) document.getElementById("myname").textContent=me.name;
  mark();
}
async function save(){
  var body={poll_id:P, option_ids:[...picks], maybe_ids:[...maybes]};
  if(MEMBER) body.token=TOKEN; else if(me && me.key) body.key=me.key; else body.name=me.name;
  var r=await post("/squadup/api/poll-vote", body);
  if(!MEMBER){ me={name:r.name, vote_id:r.vote_id, key:(me&&me.key)||r.key}; keep(me); }
  return r;
}
async function flip(id, mine, other){
  var had=mine.has(id), hadOther=other.has(id);
  if(had) mine.delete(id); else { mine.add(id); other.delete(id); }
  mark(); show("msg","");
  try{ await save(); location.reload(); }
  catch(e){ if(had) mine.add(id); else mine.delete(id); if(hadOther) other.add(id); mark(); show("msg",e.message); }
}
if(!DONE){
  document.getElementById("gstart").onclick=async function(){
    var n=document.getElementById("gname").value.trim(); show("nmsg","");
    if(!n){ show("nmsg","Add your name first."); return; }
    this.disabled=true;
    try{ me={name:n}; await save(); location.reload(); }
    catch(e){ me=null; show("nmsg",e.message); this.disabled=false; }
  };
  document.getElementById("gname").addEventListener("keydown",function(e){ if(e.key==="Enter") document.getElementById("gstart").click(); });
  document.getElementById("notme").onclick=function(){ keep(null); me=null; who(); document.getElementById("gname").focus(); };
  document.querySelectorAll("[data-pick]").forEach(function(b){ b.onclick=function(){ flip(b.dataset.pick, picks, maybes); }; });
  document.querySelectorAll("[data-maybe]").forEach(function(b){ b.onclick=function(){ flip(b.dataset.maybe, maybes, picks); }; });
  who();
}
var cp=document.getElementById("copy");
if(cp){
  var url=document.getElementById("shareurl").textContent;
  cp.onclick=async function(){
    try{ await navigator.clipboard.writeText(url); show("cmsg","Copied.","ok"); }
    catch(e){ var r=document.createRange(); r.selectNodeContents(document.getElementById("shareurl"));
      var s=getSelection(); s.removeAllRanges(); s.addRange(r); show("cmsg","Selected. Copy it from here.","ok"); }
  };
  if(navigator.share){ var ns2=document.getElementById("nshare"); ns2.classList.remove("hidden");
    ns2.onclick=function(){ navigator.share({title:${js(C.fullTitle(poll))}, text:"Which of these dates work for you?", url:url}).catch(function(){}); }; }
}
${invites ? inviteJs({ invite: "/squadup/api/poll-invite", inviteNew: "/squadup/api/poll-invite-new", idKey: "poll_id", back: "/squadup/f/" }) : ""}`,
  { token: T });
}

/* ------------------------------------------------------------------ stop -- */
function stopPage(person) {
  const off = !!person.opted_out_at;
  return page("Squad Up", `
<h1>${off ? "Messages are off" : "Stop all messages?"}</h1>
${sub(off ? "You won't get any emails or texts from Squad Up. You can still use your page."
          : "You won't get any more emails or texts from Squad Up, about anything. You can still use your page, and turn them back on any time.")}
<div class="row">
  <button class="${off ? "go" : "danger"}" id="flip">${off ? "Turn messages back on" : "Stop all messages"}</button>
  <a class="pill quiet" href="/squadup/p/${esc(person.personal_token)}">Go to my page</a>
</div>
<div class="err" id="msg"></div>`, POST + `
document.getElementById("flip").onclick=async function(){
  try{ await post("/squadup/api/stop",{token:${JSON.stringify(person.personal_token)}, off:${off ? "false" : "true"}});
    location.reload(); }catch(e){ show("msg",e.message); }
};`, { token: person.personal_token });
}

/* ----------------------------------------------------------------- reply -- */
// Landing page for one-tap email answers. Saving happens in script so link
// scanners that merely open the URL don't answer on anyone's behalf.
function replyPage(a, person, what) {
  const back = `/squadup/a/${esc(a.id)}?t=${esc(person.personal_token)}`;
  return page("Squad Up", `
<div class="bubble plain" style="margin-top:24px;text-align:center">
  <h3>${titleHtml(a)}</h3>
  <p class="muted" id="msg" style="margin:10px 0 0">Saving…</p>
  <noscript><p><a class="pill" href="${back}">Open the plan</a></p></noscript>
</div>`, POST + `
(async function(){
  try{
    var r = await post("/squadup/api/reply",{token:${JSON.stringify(person.personal_token)},
      activity_id:${JSON.stringify(a.id)}, do:${JSON.stringify(String(what))}});
    location.replace(${JSON.stringify(back)}+"&saved="+encodeURIComponent(r.saved));
  }catch(e){
    var m=document.getElementById("msg"); m.textContent=e.message; m.className="err";
    var l=document.createElement("a"); l.className="pill"; l.href=${JSON.stringify(back)};
    l.textContent="Open the plan"; l.style.marginTop="14px";
    m.parentNode.appendChild(l);
  }
})();`, { token: person.personal_token });
}

function simplePage(title, heading, body) {
  return page(title, `<h1>${esc(heading)}</h1><p class="muted" style="margin-top:8px">${esc(body)}</p>
    <div class="row"><a class="pill" href="/squadup">Start over</a></div>`);
}

module.exports = { page, esc, joinPage, personPage, activityPage, newPage, pastPage,
                   startPage, findPage, pollPage, pollEditPage,
                   replyPage, stopPage, simplePage };
