/* ============================================================================
   SQUAD UP — views
   Server-rendered HTML. Each page ships its own small script; there is no
   client framework and no build step, matching the rest of extrarandom.
   Words are kept to headlines and button labels -- the layout and color do
   the explaining.
   ========================================================================== */
const theme = require("./theme");
const C = require("./core");
const { tagStyle } = require("./colors");

const esc = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

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

// "Gin, Emily and Will" / "Gin, Emily, Will and 3 more"
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
  <label for="email">Email</label>
  <input id="email" type="email" autocomplete="email" placeholder="you@example.com">
  <label for="phone">Phone <span class="muted">(optional)</span></label>
  <input id="phone" type="tel" autocomplete="tel">
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
    if(r.emailed){ show("msg","You're already in. We emailed your link.","ok"); b.disabled=false; }
    else location.href = r.url;
  }catch(e){ show("msg", e.message); b.disabled=false; }
};`);
}

/* ---------------------------------------------------------------- person -- */
function planCard(a, tagById, token) {
  const locked = a.options.find(o => o.id === a.locked_option_id);
  const tag = tagById[a.tag_id];
  const w = locked ? whenParts(locked.starts_at) : null;
  return `<a class="bubble row-card${a.canceled_at ? " off" : ""}" style="${tagStyle(tag)}"
      href="/squadup/a/${esc(a.id)}?t=${esc(token)}">
    <div class="orb${w ? "" : " hollow"}">${w ? `<b>${w.day}</b><span>${w.weekday}</span>` : `<b>?</b>`}</div>
    <div class="body">
      <h3>${esc(a.title)}</h3>
      <div class="meta">
        ${a.canceled_at ? `<span class="tag flag">Off</span>`
          : w ? `<span>${esc(w.month)} ${w.day}, ${esc(w.time)}</span>` : ""}
        ${tag ? `<span class="tag">${esc(tag.name)}</span>` : ""}
        ${!a.canceled_at && a.inCount ? `<span class="who"><span class="n">${a.inCount} in</span></span>` : ""}
        ${a.pendingCount ? `<span class="tag flag">${a.pendingCount} new time${a.pendingCount > 1 ? "s" : ""}</span>` : ""}
      </div>
    </div>
  </a>`;
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
      <a class="pill sm" href="/squadup/new?t=${esc(token)}&amp;idea=${esc(i.id)}">Pick a time</a>
      ${nudge}
    </div>
    ${soon ? `<div class="small muted" style="margin-top:8px">Fades ${esc(C.formatDay(i.expiresAt))}</div>` : ""}
  </div>`;
}

function personPage(person, data) {
  const { tags, subs, activities, tagById } = data;
  const ideas = data.ideas || [];
  const mine = new Set(subs);
  const T = person.personal_token;

  return page("Squad Up", `
<div class="head">
  <h1>Hey, ${esc(firstName(person.name))}</h1>
  <a class="pill go" href="/squadup/new?t=${esc(T)}">+ New plan</a>
</div>

<h2>Plans</h2>
${activities.length ? activities.map(a => planCard(a, tagById, T)).join("")
  : `<div class="bubble plain"><p class="empty">Nothing planned yet.</p></div>`}

<h2 id="ideas">Let's do this sometime</h2>
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
<div class="chips" id="chips">
  ${tags.map(t => `<button type="button" class="chip${mine.has(t.id) ? " on" : ""}" style="${tagStyle(t)}"
     data-id="${esc(t.id)}" aria-pressed="${mine.has(t.id)}">${esc(t.name)}</button>`).join("")}
</div>
<div class="err" id="msg"></div>` : ""}

<h2>Your private link</h2>
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
};`, { token: T });
}

/* -------------------------------------------------------------- activity -- */
function activityPage(a, ctx) {
  const { viewer, isCreator, options, responses, counts, tag, creator,
          suggestion, myResponse, peopleById } = ctx;
  const style = tagStyle(tag);

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
      ${a.canceled_at ? "" : pending
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

  return page(a.title + " · Squad Up", `
${a.canceled_at ? `<div class="bubble notice"><h3>This one's off</h3>
  ${a.canceled_reason ? `<p class="muted" style="margin:4px 0 0">${esc(a.canceled_reason)}</p>` : ""}</div>` : ""}

<div class="title-row${a.canceled_at ? " off" : ""}" style="${style}">
  ${planOrb}
  <h1>${esc(a.title)}</h1>
</div>
<div style="${style}">
  <div class="meta" style="margin-top:8px">
    ${tag ? `<span class="tag">${esc(tag.name)}</span>` : ""}
    <span>by ${esc(creator ? creator.name : "someone")}</span>
  </div>
  ${a.note ? `<p style="margin:10px 0 0">${esc(a.note)}</p>` : ""}
</div>

${suggestion && isCreator && !a.canceled_at ? `<div class="bubble callout" style="${style};margin-top:20px">
  <h3>More people can do ${esc(C.formatWhen(suggestion.to.starts_at))}</h3>
  <p class="muted" style="margin:4px 0 0">${suggestion.toCount} vs ${suggestion.fromCount}</p>
  <div class="row tight"><button class="go sm" data-lock="${esc(suggestion.to.id)}">Move it</button>
  <button class="quiet sm" id="keep">Keep it</button></div>
</div>` : ""}

<h2>When</h2>
${optHtml}
${out.length ? `<p class="small muted">Can't make it: ${esc(nameList(out))}</p>` : ""}

${a.canceled_at ? "" : `
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

${isCreator && !a.canceled_at ? `<div class="row" style="margin-top:36px">
  <button class="quiet danger sm" id="cancel">Call it off</button></div>` : ""}

${!viewer ? `<h2>Join in</h2>
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
var cx=document.getElementById("cancel");
if(cx) cx.onclick = guard(async function(){
  var why = prompt("Call it off? Add a note for everyone (optional).");
  if(why===null) return;
  await post("/squadup/api/cancel",{token:TOKEN,activity_id:A,reason:why});
  location.reload();
});
var jb=document.getElementById("join");
if(jb) jb.onclick=async function(){
  this.disabled=true; show("jmsg","");
  try{
    var r=await post("/squadup/api/signup",{
      name:document.getElementById("jname").value,
      email:document.getElementById("jemail").value,
      phone:document.getElementById("jphone").value,
      activity_id:A, tags:[]});
    if(r.emailed){ show("jmsg","You're already in. We emailed your link.","ok"); this.disabled=false; }
    else location.href="/squadup/a/"+A+"?t="+encodeURIComponent(r.token);
  }catch(e){ show("jmsg",e.message); this.disabled=false; }
};`, { token: viewer ? viewer.personal_token : null });
}

/* ------------------------------------------------------------------- new -- */
function newPage(person, tags, idea) {
  const style = idea ? tagStyle((tags.find(t => t.id === idea.tag_id) || {}).name) : "";
  return page("New plan · Squad Up", `
<h1>${idea ? "Put a time on it" : "New plan"}</h1>
<div class="bubble plain" style="margin-top:18px;${style}">
  <label for="title">What</label>
  <input id="title" placeholder="Rock climbing at the quarry" value="${idea ? esc(idea.title) : ""}">

  <label for="tag">Category</label>
  ${tagPicker(tags, idea ? idea.tag_id : null)}

  <label for="p1">When</label>
  <input id="p1" type="datetime-local">
  <label for="p2">Backup time <span class="muted">(optional)</span></label>
  <input id="p2" type="datetime-local">

  <label for="note">Note <span class="muted">(optional)</span></label>
  <input id="note" placeholder="Bring shoes, I've got the rope" value="${idea && idea.note ? esc(idea.note) : ""}">

  <div class="row"><button class="go" id="go">Post it</button></div>
  <div class="err" id="msg"></div>
</div>`, POST + TAGPICKER_JS + `
var TOKEN=${JSON.stringify(person.personal_token)};
document.getElementById("go").onclick=async function(){
  this.disabled=true; show("msg","");
  try{
    var r=await post("/squadup/api/activity",Object.assign({token:TOKEN,
      title:document.getElementById("title").value,
      primary:document.getElementById("p1").value,
      backup:document.getElementById("p2").value,
      note:document.getElementById("note").value,
      idea_id:${JSON.stringify(idea ? idea.id : null)}}, tagFields()));
    location.href="/squadup/a/"+r.id+"?t="+encodeURIComponent(TOKEN);
  }catch(e){ show("msg",e.message); this.disabled=false; }
};`, { token: person.personal_token });
}

function simplePage(title, heading, body) {
  return page(title, `<h1>${esc(heading)}</h1><p class="muted" style="margin-top:8px">${esc(body)}</p>
    <div class="row"><a class="pill" href="/squadup">Start over</a></div>`);
}

module.exports = { page, esc, joinPage, personPage, activityPage, newPage, simplePage };
