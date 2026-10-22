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
const L = require("./legal");
const { BASE } = require("./notify");

const esc = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// JSON for inside a <script> tag: "</script>" in a name can't break out
const js = v => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

const LOGO = `<span class="logo" aria-hidden="true">${
  [4, 46, 128, 192, 296].map(h => `<i style="--h:${h}"></i>`).join("")}</span>`;

// What a text or chat app shows when a Squad Up link is pasted in.
function ogTags(og) {
  const t = og.title || `Squad Up with ${L.SQUAD_WITH}`;
  const d = og.description || "Plans with friends. See what's coming up and say which times work for you.";
  return `<meta property="og:site_name" content="Squad Up">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(t)}">
<meta property="og:description" content="${esc(d)}">
${og.url ? `<meta property="og:url" content="${esc(og.url)}">` : ""}
<meta property="og:image" content="${esc(BASE)}/og.png">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="description" content="${esc(d)}">`;
}

// The styles and the small script every page shares are served as files the
// browser keeps (see /squadup/app.css and app.js), so each page is smaller.
// v changes whenever either one does, so a new version is never stuck behind
// an old copy.
let ASSETS = null;
function assets() {
  if (!ASSETS) {
    const js = EXPAND_JS + TIDY_URL_JS + ZONE_JS;
    const v = require("crypto").createHash("sha1").update(theme).update(js).digest("hex").slice(0, 10);
    ASSETS = { css: theme, js, v };
  }
  return ASSETS;
}

// A person's initial in a colored circle; guests get navy italics.
function avatar(p, cls) {
  const name = String((p && p.name) || "?").trim();
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `<span class="avatar${p && p.guest ? " guest" : ""}${cls ? " " + cls : ""}" style="--h:${h}" aria-hidden="true">${esc((name[0] || "?").toUpperCase())}</span>`;
}
// Top right of every page for anyone we know: their initial, which opens a
// small menu (account, squad members, past plans, log out).
function accountMenu(me, token) {
  const t = token ? `?t=${esc(token)}` : "";
  const guest = !!me.guest;
  const contact = guest ? "Guest" : [me.phone ? C.formatPhone(me.phone) : "", me.email || ""].filter(Boolean).join(" · ");
  const links = guest
    ? `<a href="/squadup/join">Join Squad Up</a>
       <a href="/squadup/members${t}">Squad members</a>
       <a href="/squadup/login">Log in</a>
       <a href="/squadup/logout">Not ${esc(firstName(me.name))}? Log out</a>`
    : `<a href="/squadup/account${t}">Your account</a>
       <a href="/squadup/members${t}">Squad members</a>
       <a href="/squadup/past${t}">Past plans</a>
       <a href="/squadup/logout">Log out</a>`;
  return `<details class="acct"><summary aria-label="Your account menu" title="${esc(me.name)}">${avatar({ name: me.name, guest })}</summary>
    <div class="acctmenu" role="menu">
      <div class="acctwho"><b class="${guest ? "gname" : ""}">${esc(me.name)}</b>${contact ? `<span>${esc(contact)}</span>` : ""}</div>
      ${links}
    </div></details>`;
}

function page(title, body, script, opts) {
  const o = opts || {};
  const home = o.token ? `/squadup/p/${esc(o.token)}` : "/squadup";
  // anyone we don't know yet can log in from any page; anyone we do gets
  // their account menu
  const login = !o.me && (!o.token || o.guest) && !o.gate ? `<a class="loginlink" href="/squadup/login">Log in</a>` : "";
  const menu = o.me && !o.gate ? accountMenu({ ...o.me, guest: !!o.guest || !!o.me.guest }, o.token) : "";
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#ffffff">
<title>${esc(title)}</title>
${ogTags(o.og || {})}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=M+PLUS+Rounded+1c:wght@500;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/squadup/app.css?v=${assets().v}"></head>
<body>
<header class="top"><div class="wrap">
  <a class="brand" href="${home}">${LOGO}<span>Squad Up <span class="with">with ${esc(L.SQUAD_WITH)}</span></span></a>
  <span class="hdr-right">${login}${o.token && !o.isHome && !o.guest ? `<a class="pill sm homebtn" href="${home}" aria-label="Back to home">‹ Home</a>` : ""}${menu}</span>
</div></header>
<main class="wrap">${body}</main>
<footer class="wrap legal"><a href="${L.TERMS_URL}">Terms</a> · <a href="${L.PRIVACY_URL}">Privacy</a> · <a href="mailto:${esc(L.CONTACT)}">Contact</a>${
  o.token ? ` · <a href="/squadup/logout" id="logout">Log out</a>` : ""}</footer>
<script src="/squadup/app.js?v=${assets().v}"></script>
${script ? `<script>${script}</script>` : ""}
</body></html>`;
}

/* helper JS shared by pages that post JSON */
const POST = `
async function post(url, body){
  // keepalive: a save that's under way still lands if the page closes
  const r = await fetch(url, {method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify(body||{}), keepalive:true});
  const j = await r.json().catch(()=>({error:"Something went wrong."}));
  if(!r.ok){ var err=new Error(j.error || "Something went wrong."); err.data=j; throw err; }
  return j;
}
function show(id,msg,cls){var e=document.getElementById(id);if(e){e.textContent=msg;e.className=cls||"err";}}
// The organizer decides whether a change goes out: a small box under the
// button asks, and resolves "send", "quiet", or null (cancel).
function askSend(anchor, text, yes, no){
  return new Promise(function(done){
    document.querySelectorAll(".askbox").forEach(function(x){ x.remove(); });
    var box=document.createElement("div"); box.className="askbox";
    box.innerHTML="<p></p><div class='row tight'><button type='button' class='sm go' data-a='send'></button>"+
      "<button type='button' class='sm' data-a='quiet'></button><button type='button' class='sm quiet' data-a='cancel'>Cancel</button></div>";
    box.querySelector("p").textContent=text;
    box.querySelector("[data-a=send]").textContent=yes; box.querySelector("[data-a=quiet]").textContent=no;
    (anchor.closest(".row")||anchor).after(box);
    box.onclick=function(e){ var b=e.target.closest("button"); if(!b) return; box.remove();
      done(b.dataset.a==="cancel" ? null : b.dataset.a); };
    box.scrollIntoView({block:"nearest",behavior:"smooth"});
  });
}

// pull a fresh copy of one section without reloading the page
async function refreshPart(ids){
  var r=await fetch(location.href,{cache:"no-store"}); if(!r.ok) return;
  var doc=new DOMParser().parseFromString(await r.text(),"text/html");
  [].concat(ids).forEach(function(id){
    var fresh=doc.getElementById(id), here=document.getElementById(id);
    if(fresh && here) here.innerHTML=fresh.innerHTML;
  });
}
// taps save in the background: quick taps are batched, one save at a time
function saver(saveFn, after){
  var timer=null, busy=false, again=false;
  async function run(){
    timer=null;
    if(busy){ again=true; return; }
    busy=true; again=false;
    try{ await saveFn(); if(!again) await after(); }
    catch(e){ show("msg", e.message + " Reloading…"); setTimeout(function(){ location.reload(); }, 1200); }
    busy=false; if(again) run();
  }
  var go=function(){ clearTimeout(timer); timer=setTimeout(run, 450); };
  // save anything waiting now, and wait for it (before switching whose answers these are)
  go.flush=async function(){
    if(timer){ clearTimeout(timer); run(); }
    while(busy || again || timer) await new Promise(function(r){ setTimeout(r, 60); });
  };
  return go;
}
// Like saver, but for several people at once (the organizer filling in): each
// tap queues that person's latest answer under their own key, and the queue
// saves them one after another in the background. Switching people never
// waits on the network, and a later tap for someone replaces an earlier one
// that hadn't gone out yet.
function batcher(saveOne, after){
  var pending={}, order=[], timer=null, busy=false;
  async function run(){
    timer=null; if(busy) return;
    busy=true; var ok=true;
    while(order.length){
      var k=order.shift(), job=pending[k]; delete pending[k];
      try{ await saveOne(job); }
      catch(e){ ok=false; show("msg", e.message + " Reloading…"); setTimeout(function(){ location.reload(); }, 1200); break; }
    }
    busy=false;
    if(ok) Promise.resolve().then(after).catch(function(){});
  }
  var go=function(key, job){ if(!(key in pending)) order.push(key); pending[key]=job;
    clearTimeout(timer); timer=setTimeout(run, 450); };
  go.flush=async function(){
    if(timer){ clearTimeout(timer); run(); }
    while(busy || order.length || timer) await new Promise(function(r){ setTimeout(r, 60); });
  };
  // send what's waiting right now, without waiting for it
  go.now=function(){ if(timer){ clearTimeout(timer); run(); } };
  addEventListener("pagehide", go.now);
  return go;
}
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

// "Gin, Sebastian and Danielle" / "Gin, Sebastian, Danielle [and 3 more]"
// Long lists fold up; tapping "and 3 more" opens the rest in place (HTML out).
// Names come as strings or { name, guest }. Guests (a name only, no texts or
// emails) show in navy italics everywhere, so it's clear who can't be reached.
const isGuestP = p => !!p && !p.email && !p.phone;
const asItem = x => typeof x === "string" ? { name: x, guest: false } : { name: x.name, guest: !!x.guest };
const nameHtml = x => x.guest ? `<span class="gname" title="Guest: no texts or emails">${esc(x.name)}</span>` : esc(x.name);
const joinHtml = n => n.length > 1 ? n.slice(0, -1).join(", ") + " and " + n[n.length - 1] : n.join("");
function foldList(list, fits, shows) {
  const names = list.map(nameHtml);
  if (names.length <= fits) return joinHtml(names);
  const head = names.slice(0, shows), rest = names.slice(shows);
  return head.join(", ") +
    `<span class="rest" hidden>, ${joinHtml(rest)}</span> ` +
    `<button type="button" class="more-names" data-expand aria-expanded="false" data-less="show less">and ${rest.length} more</button>`;
}
// full names for poll answers, where two Danielles need telling apart
const fullList = names => foldList(names.map(asItem), 6, 5);
// first names, unless two people in the list share one
function nameList(names) {
  const items = names.map(asItem);
  const firsts = items.map(x => firstName(x.name).toLowerCase());
  return foldList(items.map((x, i) => firsts.indexOf(firsts[i]) !== firsts.lastIndexOf(firsts[i])
    ? x : { ...x, name: firstName(x.name) }), 4, 3);
}
const GUEST_KEY = `<p class="small muted guestkey"><span class="gname">Names like this</span> are guests. They don't get texts or emails.</p>`;

// A plan's time, tagged with its zone: anyone whose phone is somewhere else
// sees their own time next to it ("4pm your time").
const whenSpan = (stamp, zone, text) =>
  `<span data-at="${esc(stamp)}" data-tz="${esc(C.zoneOf(zone))}">${esc(text)}</span>`;
const ZONE_JS = `
(function(){ try{
  var mine=Intl.DateTimeFormat().resolvedOptions().timeZone; if(!mine) return;
  function parts(ms,tz){ var o={}; new Intl.DateTimeFormat("en-US",{timeZone:tz,hourCycle:"h23",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"})
    .formatToParts(new Date(ms)).forEach(function(p){ o[p.type]=p.value; }); return Date.UTC(+o.year,+o.month-1,+o.day,+o.hour%24,+o.minute); }
  function toMs(stamp,tz){ var m=/^(\\d+)-(\\d+)-(\\d+)T(\\d+):(\\d+)/.exec(stamp); if(!m) return null;
    var want=Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5]), g=want; for(var i=0;i<3;i++){ var seen=parts(g,tz); if(seen===want) break; g+=want-seen; } return g; }
  document.querySelectorAll("[data-at][data-tz]").forEach(function(el){
    var tz=el.getAttribute("data-tz"); if(!tz || tz===mine || el.dataset.done) return;
    var ms=toMs(el.getAttribute("data-at"),tz); if(ms==null) return;
    if(parts(ms,tz)===parts(ms,mine)) return;
    var sameDay=new Date(ms).toLocaleDateString("en-US",{timeZone:tz})===new Date(ms).toLocaleDateString("en-US",{timeZone:mine});
    var t=new Date(ms).toLocaleString("en-US",sameDay?{hour:"numeric",minute:"2-digit"}:{weekday:"short",hour:"numeric",minute:"2-digit"});
    var s=document.createElement("span"); s.className="yourtime"; s.textContent=" ("+t.replace(":00","").replace(" AM","am").replace(" PM","pm")+" your time)";
    el.dataset.done="1"; el.appendChild(s);
  });
}catch(e){} })();`;
// This browser remembers who you are, so the personal key can come out of the
// address bar: copying the address then shares the public link, never yours.
const TIDY_URL_JS = `
(function(){ try{
  if(!navigator.cookieEnabled) return;
  var u=new URL(location.href), changed=false;
  if(u.searchParams.has("t")){ u.searchParams.delete("t"); changed=true; }
  if(/^\\/squadup\\/p\\/[^/]+$/.test(u.pathname)){ u.pathname="/squadup"; changed=true; }
  if(changed) history.replaceState(null,"",u.pathname+u.search+u.hash);
}catch(e){} })();`;
// one tap handler for every folded list on any page
const EXPAND_JS = `document.addEventListener("click",function(e){
  document.querySelectorAll("details.acct[open]").forEach(function(d){ if(!d.contains(e.target)) d.open=false; });
});
document.addEventListener("keydown",function(e){ if(e.key==="Escape") document.querySelectorAll("details.acct[open]").forEach(function(d){ d.open=false; }); });
document.addEventListener("click",function(e){
  var b=e.target.closest("[data-expand]"); if(!b) return;
  var r=b.previousElementSibling, open=b.getAttribute("aria-expanded")!=="true";
  if(!b.dataset.more) b.dataset.more=b.textContent;
  r.hidden=!open; b.setAttribute("aria-expanded",open); b.textContent=open?b.dataset.less:b.dataset.more;
});`;

function tagPicker(tags, selectedId) {
  return `<select id="tag">
    ${tags.map(t => `<option value="${esc(t.id)}"${t.id === selectedId ? " selected" : ""}>${esc(t.name)}</option>`).join("")}
    <option value="__new"${tags.length ? "" : " selected"}>New activity…</option>
  </select>
  <div id="newtag" class="${tags.length ? "hidden" : ""}">
    <label for="tagname">Activity name</label>
    <input id="tagname" maxlength="60" placeholder="Kayaking">
  </div>`;
}
const TAGPICKER_JS = `
var sel=document.getElementById("tag");
sel.onchange=function(){ document.getElementById("newtag").classList.toggle("hidden", sel.value!=="__new"); };
function tagFields(){ return { tag_id: sel.value==="__new" ? null : sel.value,
  tag_name: sel.value==="__new" ? document.getElementById("tagname").value : null }; }`;

/* ------------------------------------------------------------------ join -- */
// The two boxes under a sign-up form. The Terms box is required; the text box
// is how someone agrees to texts, says what the texts are, and is never
// pre-checked.
const SMS_CONSENT = `<b>Text me about Squad Up plans I'm invited to</b> (invites, times, confirmations, reminders).
  From ${L.OPERATOR}. Msg frequency varies; msg &amp; data rates may apply. Reply HELP for help, STOP to opt out.`;
const consentBlock = p => `
<div class="consent">
  <label class="check"><input type="checkbox" id="${p}sms"><span>${SMS_CONSENT}</span></label>
  <label class="check"><input type="checkbox" id="${p}agree"><span>I agree to the
    <a href="${L.TERMS_URL}" target="_blank" rel="noopener">Terms</a> and
    <a href="${L.PRIVACY_URL}" target="_blank" rel="noopener">Privacy Policy</a>.</span></label>
</div>`;

/* ---------------------------------------------------------------- welcome -- */
// One screen for the front door and for every shared link: who are you?
// Continue as a guest with just a name, get updates (phone or email, with
// consent), or log in if you already have an account.
function gatePage(ctx) {
  const ev = ctx.event || null, mode = ctx.mode, g = ctx.guest || null;
  const style = ev && ev.tag ? tagStyle(ev.tag) : "--h:276;--l:52%";
  const hero = ev ? `
<div class="title-row" style="${style}">
  <div class="orb hollow">${ev.kind === "poll" ? `<b>${ev.dates}</b><span>date${ev.dates === 1 ? "" : "s"}</span>` : "<b>✓</b><span>you in?</span>"}</div>
  <h1>${titleHtml(ev)}</h1>
</div>
${sub(`${ev.by ? `<b>${esc(firstName(ev.by))}</b> invited you. ` : ""}${ev.kind === "poll"
    ? "Pick the dates that work for you."
    : `${ev.at ? whenSpan(ev.at, ev.zone, ev.when) : esc(ev.when)}${ev.more ? ` (or ${ev.more} other time${ev.more === 1 ? "" : "s"})` : ""}. Say if you can make it.`}`)}`
  : mode === "join" ? `<h1>Get Squad Up updates</h1>${sub("Hear when plans are made or change, by text or email.")}`
  : mode === "login" ? `<h1>Log in</h1>${sub("We'll send a link to your phone or email.")}`
  : `<h1>Squad Up <span class="with">with ${esc(L.SQUAD_WITH)}</span></h1>${sub("Plans with friends. See what's coming up and say which times work for you.")}`;

  // Joining is the main box; guest and log-in open underneath it.
  const primary = mode === "login" ? "loginbox" : "updbox";
  const guestBox = `<div class="bubble plain gatebox hidden" id="guestbox" style="${style};margin-top:14px">
  <h3>Continue as a guest</h3>
  <label for="gname">What's your name?</label>
  <input id="gname" maxlength="${C.POLL_NAME_MAX}" autocomplete="given-name" placeholder="Danielle" value="${esc(g ? g.name : "")}">
  <div class="row"><button class="go wide" id="gguest">Continue as a guest</button></div>
  <p class="small muted" style="margin:8px 0 0">No account needed. Guests don't get texts or emails.</p>
  <div id="claim" class="hidden"></div>
  <div class="err" id="gmsg"></div>
</div>`;
  const updBox = `<div class="bubble plain${primary === "updbox" ? " gatebox" : " hidden"}" id="updbox" style="${primary === "updbox" ? style : "margin-top:14px"}">
  ${mode === "join" ? "" : `<h3>${primary === "updbox" ? "Join Squad Up" : "Create an account"}</h3><p class="muted small" style="margin:4px 0 4px">Get a text or email when plans are made or change. No password.</p>`}
  <label for="uname">Name</label>
  <input id="uname" maxlength="60" autocomplete="name" placeholder="Danielle" value="${esc(g ? g.name : "")}">
  <label for="uphone">Phone${ctx.smsOn ? "" : ` <span class="muted">(Coming Soon)</span>`}</label>
  <input id="uphone" type="tel" autocomplete="tel" placeholder="(239) 555-0123">
  <label for="uemail">or Email</label>
  <input id="uemail" type="email" autocomplete="email" placeholder="you@example.com">
  ${consentBlock("u")}
  <div class="row"><button class="go wide" id="ujoin">Join Squad Up</button></div>
  <div id="uclaim" class="hidden"></div>
  <div class="err" id="umsg"></div>
</div>`;
  const loginBox = `<div class="bubble plain${mode === "login" ? "" : " hidden"}" id="loginbox" style="margin-top:14px">
  ${mode === "login" ? "" : `<h3>Log in</h3><p class="muted small" style="margin:4px 0 4px">We'll send a link to your phone or email.</p>`}
  <label for="lcontact">Phone or email</label>
  <input id="lcontact" autocomplete="username" placeholder="(239) 555-0123 or you@example.com">
  <div class="row"><button class="go" id="lsend">Send my link</button></div>
  <div class="err" id="lmsg"></div>
</div>`;
  const alt = `<div class="gate-alt">
  ${mode === "login" ? `<button type="button" class="sm" id="updopen">Create an account</button>` : ""}
  ${mode === "login" ? "" : `<button type="button" class="sm quiet" id="loginopen">I already have an account</button>`}
  <button type="button" class="sm quiet" id="guestopen">Continue as a guest</button>
</div>`;
  const main = mode === "login" ? loginBox + alt + updBox + guestBox
    : updBox + alt + loginBox + guestBox;

  const og = ev ? {
    title: `${ev.by ? firstName(ev.by) + " invited you: " : ""}${C.fullTitle(ev)}`,
    description: ev.kind === "poll" ? "Finding a time. Pick the dates that work for you."
      : `${ev.when}${ev.more ? ` (or ${ev.more} other time${ev.more === 1 ? "" : "s"})` : ""}. Say if you can make it.`,
    url: ctx.url } : { url: ctx.url };
  return page(ev ? `${C.fullTitle(ev)} · Squad Up` : "Squad Up", hero + main, POST + `
var EVENT=${js(ev ? { kind: ev.kind, id: ev.id } : null)}, NEXT=${js(ctx.next || null)};
function $(id){ return document.getElementById(id); }
function h(s){ var d=document.createElement("div"); d.textContent=s; return d.innerHTML; }
// poll answers from before this screen were kept in the browser; bring them along
function oldKeys(){ var out=[]; try{ for(var i=0;i<localStorage.length;i++){ var k=localStorage.key(i);
  if(k && k.indexOf("squadup-poll-")===0){ var v=JSON.parse(localStorage.getItem(k)||"null"); if(v && v.key) out.push(v.key); } } }catch(e){} return out; }
function forgetOld(){ try{ Object.keys(localStorage).forEach(function(k){ if(k.indexOf("squadup-poll-")===0) localStorage.removeItem(k); }); }catch(e){} }
function here(){ return EVENT ? location.pathname : (NEXT || "/squadup"); }
function done(){ forgetOld(); if(EVENT) location.reload(); else location.href=NEXT || "/squadup"; }
function box(id, html){ var c=$(id); c.innerHTML=html; c.classList.toggle("hidden", !html); }
function initial(input, msg){ var g=$(input); g.value=g.value.trim().split(" ")[0]+" "; g.focus();
  show(msg,"Add a last initial so we can tell you apart, like \\""+g.value.trim()+" K.\\"","muted"); }

/* Continue as a guest. A name that's already on Squad Up asks first. */
var gSkip=false, declined={}, notIds=[];
async function asGuest(){
  var gb=$("gguest"), n=$("gname").value.trim().replace(/\\s+/g," "); show("gmsg",""); box("claim","");
  if(!n){ show("gmsg","Type your name first."); $("gname").focus(); return; }
  if(declined[n.toLowerCase()]){ show("gmsg","Someone already goes by "+n+". Add a last initial, like \\""+n.split(" ")[0]+" K.\\""); return; }
  gb.disabled=true;
  try{ await post("/squadup/api/guest",{name:n, skipSimilar:gSkip, notIds:notIds, keys:oldKeys()}); done(); }
  catch(e){
    gb.disabled=false;
    var m=e.data && e.data.match; if(!m){ show("gmsg",e.message); return; }
    var exact=!!e.data.exact, guests=m.filter(function(x){ return x.guest; }), members=m.filter(function(x){ return !x.guest; });
    var lead = exact && members.length ? h(members[0].name)+" has a Squad Up account. Is that you?"
      : exact ? "Are you <b>"+h(guests[0].name)+"</b>? Your answers will load so you can change them."
      : "Is one of these you?";
    box("claim","<p style='margin:12px 0 10px'>"+lead+"</p><div class='row tight'>"+
      guests.map(function(x){ return "<button class='sm go' data-claim='"+h(x.id)+"'>"+(exact?"Yes, that's me":h(x.name))+"</button>"; }).join("")+
      members.map(function(x){ return "<button class='sm' data-login>"+(exact?"Yes, log me in":h(x.name)+" (log in)")+"</button>"; }).join("")+
      "<button class='sm quiet' data-other data-exact='"+(exact?1:0)+"'>"+(m.length>1?"None of these":"No, I'm someone else")+"</button></div>");
  }
}
var gg=$("gguest");
if(gg){
  gg.onclick=asGuest;
  $("gname").addEventListener("keydown",function(e){ if(e.key==="Enter") asGuest(); });
  $("gname").addEventListener("input",function(){ gSkip=false; var u=$("uname"); if(u && !u.dataset.touched) u.value=this.value; });
  $("claim").addEventListener("click", async function(e){
    var b=e.target.closest("button"); if(!b) return;
    if(b.hasAttribute("data-login")){ box("claim",""); openBox("loginbox"); return; }
    if(b.hasAttribute("data-other")){
      [].forEach.call($("claim").querySelectorAll("[data-claim]"),function(x){ notIds.push(x.dataset.claim); });
      box("claim","");
      if(b.dataset.exact==="1"){ declined[$("gname").value.trim().replace(/\\s+/g," ").toLowerCase()]=1; return initial("gname","gmsg"); }
      gSkip=true; return asGuest();
    }
    b.disabled=true;
    try{ await post("/squadup/api/guest",{claim:{id:b.dataset.claim}, keys:oldKeys()}); done(); }
    catch(e){ b.disabled=false; show("gmsg",e.message); }
  });
}
var un=$("uname"); if(un) un.addEventListener("input",function(){ this.dataset.touched="1"; uSkip=false; });
var PRIMARY=${js(mode === "login" ? "loginbox" : "updbox")};
function openBox(id){ ["updbox","loginbox","guestbox"].forEach(function(x){ var el=$(x); if(el && x!==PRIMARY) el.classList.toggle("hidden", x!==id || !el.classList.contains("hidden")); });
  var el=$(id); if(el && !el.classList.contains("hidden")){ el.scrollIntoView({behavior:"smooth",block:"start"});
    var f=el.querySelector("input"); if(f && !f.value) f.focus(); } }
var uo=$("updopen"); if(uo) uo.onclick=function(){ openBox("updbox"); };
var lo=$("loginopen"); if(lo) lo.onclick=function(){ openBox("loginbox"); };
$("guestopen").onclick=function(){ var g=$("gname"), u=$("uname"); if(g && !g.value && u.value) g.value=u.value; openBox("guestbox"); };

/* Join. A name a guest already answered with: "is that you?" */
var uSkip=false;
async function join(claimId){
  var b=$("ujoin"); b.disabled=true; show("umsg",""); box("uclaim","");
  try{
    var r=await post("/squadup/api/signup",{ name:$("uname").value || ($("gname")||{}).value || "",
      phone:$("uphone").value, email:$("uemail").value, claim_guest:claimId||null, skipSimilar:uSkip,
      agree:$("uagree").checked, sms_consent:$("usms").checked, keys:oldKeys(), next:here() });
    if(r.emailed){ show("umsg","You're already on Squad Up. We "+(r.via==="text"?"texted":"emailed")+" you a link to log in.","ok"); b.disabled=false; return; }
    forgetOld(); if(EVENT || NEXT) location.href=here(); else location.href=r.url;
  }catch(e){
    b.disabled=false;
    var m=e.data && e.data.match; if(!m){ show("umsg",e.message); return; }
    box("uclaim","<p style='margin:12px 0 10px'>"+h(e.message)+" If so, your answers come with you.</p><div class='row tight'>"+
      m.map(function(x){ return "<button class='sm go' data-uclaim='"+h(x.id)+"'>"+(m.length===1?"Yes, I'm "+h(x.name):h(x.name))+"</button>"; }).join("")+
      "<button class='sm quiet' data-uother data-exact='"+(e.data.exact?1:0)+"'>No, that's not me</button></div>");
  }
}
$("ujoin").onclick=function(){ join(null); };
$("uclaim").addEventListener("click", function(e){
  var b=e.target.closest("button"); if(!b) return;
  if(b.hasAttribute("data-uother")){ box("uclaim","");
    if(b.dataset.exact==="1") return initial("uname","umsg");
    uSkip=true; return join(null); }
  join(b.dataset.uclaim);
});
$("lsend").onclick=async function(){
  var b=this; b.disabled=true; show("lmsg","");
  try{
    var r=await post("/squadup/api/login",{contact:$("lcontact").value, keys:oldKeys(), next:here()});
    show("lmsg","If there's an account for that, your log-in link is on its way."+
      (r.textingOff ? " Texting is coming soon, so links go by email for now. If you signed up with just a phone number, check back soon." : " Check your "+($("lcontact").value.indexOf("@")>0?"email.":"texts.")),"ok");
  }catch(e){ show("lmsg",e.message); }
  b.disabled=false;
};
$("lcontact").addEventListener("keydown",function(e){ if(e.key==="Enter") $("lsend").click(); });`, { gate: true, og });
}

// After logging out: forget the browser's guest answers too, then go back.
function logoutPage(next) {
  return page("Logged out · Squad Up", `<h1>Logged out</h1>${sub("This browser won't remember you any more.")}
<div class="row"><a class="pill" href="${esc(next)}">Continue</a></div>`, `
try{ Object.keys(localStorage).forEach(function(k){ if(k.indexOf("squadup-poll-")===0) localStorage.removeItem(k); }); }catch(e){}
location.replace(${js(next)});`, { gate: true });
}

// "Answering as Kayla · Not you?" for guests
const guestBar = (g, path) => `<div class="guestbar small"><span class="muted">Answering as</span> <b>${esc(g.name)}</b> ·
  <a href="/squadup/logout?next=${esc(encodeURIComponent(path))}">Not you?</a> ·
  <a href="/squadup/join?next=${esc(encodeURIComponent(path))}">Get updates</a></div>`;

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
        ${w ? `<span>${whenSpan(locked.starts_at, a.timezone, `${w.month} ${w.day}, ${w.time}${C.zoneOf(a.timezone) !== C.HOME_ZONE ? " " + C.zoneAbbr(a.timezone, C.stampToDate(locked.starts_at, a.timezone)) : ""}`)}</span>` : ""}
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
  "", { token: T, me: person });
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

/* ------------------------------------------------------------- activities --
   What the squad likes to do, each with who's interested. "I'm interested"
   is following: when someone schedules it, everyone interested hears, unless
   their bell is off. "Schedule it" starts a plan with the activity picked. */
const BELL_ON = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 3a5 5 0 0 0-5 5v3.2c0 .9-.3 1.8-.9 2.5L5 15.2V17h14v-1.8l-1.1-1.5a4 4 0 0 1-.9-2.5V8a5 5 0 0 0-5-5Zm-2 15.5a2 2 0 0 0 4 0" fill="currentColor"/></svg>`;
const BELL_OFF = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 3a5 5 0 0 0-5 5v3.2c0 .9-.3 1.8-.9 2.5L5 15.2V17h14v-1.8l-1.1-1.5a4 4 0 0 1-.9-2.5V8a5 5 0 0 0-5-5Zm-2 15.5a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 4l16 16" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`;
const bellLabel = (name, muted) => muted
  ? `Messages about new ${name} plans are off. Tap to turn them on.`
  : `You'll hear when someone schedules ${name}. Tap to turn that off.`;

function activityCard(k, token, guestView) {
  const n = k.people.length;
  return `<div class="bubble act${k.interested ? " mine" : ""}" id="act-${esc(k.id)}" style="${tagStyle(k.name)}">
  <div class="acthead">
    <h3>${esc(k.name)}${k.isNew ? ` <span class="newtag">New</span>` : ""}</h3>
    ${k.interested && !guestView ? `<button type="button" class="bell${k.muted ? "" : " on"}" data-bell="${esc(k.id)}" data-name="${esc(k.name)}"
      data-muted="${k.muted ? 1 : 0}" aria-pressed="${!k.muted}" title="${esc(bellLabel(k.name, k.muted))}"
      aria-label="${esc(bellLabel(k.name, k.muted))}">${k.muted ? BELL_OFF : BELL_ON}</button>` : ""}
  </div>
  ${k.note ? `<p class="actnote">${esc(k.note)}</p>` : ""}
  ${n ? `<details class="actwho"><summary>${n} interested</summary>
    <div class="people">${k.people.map(x => `<span class="person">${nameHtml(x)}</span>`).join("")}</div></details>`
    : `<p class="actnone">Nobody yet</p>`}
  <div class="row tight">
    <button type="button" class="sm${k.interested ? " on" : ""}" data-int="${esc(k.id)}" data-on="${k.interested ? 0 : 1}">${
      k.interested ? "Interested ✓" : "I'm interested"}</button>
    ${guestView ? "" : `<a class="pill sm" href="/squadup/start?t=${esc(token)}&amp;tag=${esc(k.id)}">Schedule it</a>`}
    ${k.canEdit && !guestView ? `<button type="button" class="sm quiet" data-actedit="${esc(k.id)}" data-name="${esc(k.name)}"
      data-note="${esc(k.note || "")}">Edit</button>` : ""}
  </div>
  ${k.interested && k.muted && !guestView ? `<p class="bellnote">Messages off. You're still on the list.</p>` : ""}
</div>`;
}

// Yours and new ones always show; past the first few others, the rest fold.
const ACT_SHOW = 6;
function activitiesSection(kinds, token, guestView) {
  const top = kinds.filter(k => k.interested || k.isNew);
  const others = kinds.filter(k => !k.interested && !k.isNew);
  const shown = [...top, ...others.slice(0, Math.max(ACT_SHOW - top.length, 3))];
  const folded = kinds.filter(k => !shown.includes(k));
  return `<h2 id="activities">Activities</h2>
${sub(guestView
    ? "Things the squad likes to do. Tap <b>I'm interested</b> so whoever plans one knows to ask you."
    : "Things the squad likes to do. Tap <b>I'm interested</b> to hear when someone schedules one. The bell turns those messages off but keeps you on the list.")}
${kinds.length ? shown.map(k => activityCard(k, token, guestView)).join("") : `<div class="bubble plain"><p class="empty">Nothing yet.</p></div>`}
${folded.length ? `<div hidden>${folded.map(k => activityCard(k, token, guestView)).join("")}</div>
<button type="button" class="sm morebtn" data-expand aria-expanded="false" data-less="Show fewer">Show ${folded.length} more</button>` : ""}
${kinds.some(k => k.people.some(m => m.guest)) ? GUEST_KEY : ""}
${guestView ? "" : `<div class="row"><button class="sm" id="actopen">+ New activity</button></div>
<div id="actbox" class="bubble plain hidden" style="margin-top:14px">
  <h3 id="actboxhead" class="hidden">Edit activity</h3>
  <label for="aname">What's the activity?</label>
  <input id="aname" maxlength="60" placeholder="Pickleball">
  <label for="anote">Note <span class="muted">(optional)</span></label>
  <input id="anote" maxlength="140" placeholder="Courts at Lakes Park">
  <div class="row"><button class="go" id="actgo">Add it</button>
    <button class="sm quiet hidden" id="actcancel">Cancel</button>
    <button class="sm quiet danger hidden" id="actdel">Take it off the list</button></div>
</div>`}
<div class="err" id="actmsg"></div>`;
}
const actJs = token => `
var ATOKEN=${js(token)}, BELL_ON=${js(BELL_ON)}, BELL_OFF=${js(BELL_OFF)};
function backToAct(id){ location.hash = id ? "act-"+id : "activities"; location.reload(); }
document.querySelectorAll("[data-int]").forEach(function(b){
  b.onclick=async function(){ b.disabled=true; show("actmsg","");
    try{ await post("/squadup/api/interest",{token:ATOKEN,tag_id:b.dataset.int,on:b.dataset.on==="1"}); backToAct(b.dataset.int); }
    catch(e){ show("actmsg",e.message); b.disabled=false; } };
});
// the bell flips in place: you stay on the list either way
document.querySelectorAll("[data-bell]").forEach(function(b){
  b.onclick=async function(){
    var mute=b.dataset.muted!=="1", name=b.dataset.name, card=b.closest(".act"); b.disabled=true; show("actmsg","");
    try{ await post("/squadup/api/interest",{token:ATOKEN,tag_id:b.dataset.bell,muted:mute});
      b.dataset.muted=mute?"1":"0"; b.classList.toggle("on",!mute); b.setAttribute("aria-pressed",String(!mute));
      b.innerHTML=mute?BELL_OFF:BELL_ON;
      var label=mute ? "Messages about new "+name+" plans are off. Tap to turn them on." : "You'll hear when someone schedules "+name+". Tap to turn that off.";
      b.title=label; b.setAttribute("aria-label",label);
      var note=card.querySelector(".bellnote");
      if(!note){ note=document.createElement("p"); note.className="bellnote"; card.appendChild(note); }
      note.textContent = mute ? "Messages off. You're still on the list." : "Messages on. You'll hear when someone schedules it.";
    }catch(e){ show("actmsg",e.message); }
    b.disabled=false; };
});
// one form for adding an activity and for editing your own
var actEditing=null;
function actForm(d){
  var $=function(id){ return document.getElementById(id); };
  actEditing=d ? d.actedit : null;
  $("aname").value=d ? d.name : ""; $("anote").value=d ? d.note : "";
  $("actboxhead").classList.toggle("hidden",!d); $("actcancel").classList.toggle("hidden",!d);
  $("actdel").classList.toggle("hidden",!d); $("actgo").textContent=d ? "Save" : "Add it";
  var x=$("actbox"); x.classList.remove("hidden"); x.scrollIntoView({behavior:"smooth",block:"center"}); $("aname").focus();
}
var actOpen=document.getElementById("actopen");
if(actOpen){
  actOpen.onclick=function(){ var x=document.getElementById("actbox");
    if(!x.classList.contains("hidden") && !actEditing){ x.classList.add("hidden"); return; } actForm(null); };
  document.querySelectorAll("[data-actedit]").forEach(function(b){ b.onclick=function(){ actForm(b.dataset); }; });
  document.getElementById("actcancel").onclick=function(){ actEditing=null; document.getElementById("actbox").classList.add("hidden"); };
  document.getElementById("actdel").onclick=async function(){
    if(!confirm("Take this activity off the list? Past plans keep it.")) return;
    var b=this; b.disabled=true; show("actmsg","");
    try{ await post("/squadup/api/tag-edit",{token:ATOKEN,tag_id:actEditing,remove:true}); backToAct(null); }
    catch(e){ show("actmsg",e.message); b.disabled=false; }
  };
  document.getElementById("actgo").onclick=async function(){
    var b=this; b.disabled=true; show("actmsg","");
    try{ var r=await post(actEditing ? "/squadup/api/tag-edit" : "/squadup/api/tag-new",{token:ATOKEN,tag_id:actEditing,
        name:document.getElementById("aname").value, note:document.getElementById("anote").value});
      backToAct(r.id); }
    catch(e){ show("actmsg",e.message); b.disabled=false; }
  };
}`;

// A guest's home: everything coming up, plus a way to get updates.
function guestHomePage(g, data) {
  const T = g.personal_token;
  const { activities, polls, tagById } = data;
  return page("Squad Up", `
<div class="head"><h1>Hey, ${esc(firstName(g.name))}</h1></div>
<div class="bubble welcome">
  <h3>You're here as a guest</h3>
  <p class="muted" style="margin:4px 0 10px">You can say which times work for you. To hear when plans are made or change, get updates by text or email.</p>
  <div class="row tight"><a class="pill sm go" href="/squadup/join">Get updates</a>
    <a class="pill sm quiet" href="/squadup/logout">Not ${esc(firstName(g.name))}?</a></div>
</div>
<h2>Plans</h2>
${sub("Coming up. Tap one to say which times work for you.")}
${activities.length ? activities.map(a => planCard(a, tagById, T)).join("")
  : `<div class="bubble plain"><p class="empty">Nothing planned right now.</p></div>`}
${polls.length ? `<h2 id="polls">Finding a time</h2>
${sub("Dates up for a vote. Tap one to say which work for you.")}
${polls.map(x => pollCard(x, T)).join("")}` : ""}
${(data.kinds || []).length ? activitiesSection(data.kinds, T, true) : ""}`,
  POST + actJs(T), { token: T, isHome: true, guest: true, me: g });
}

function personPage(person, data) {
  const { activities, tagById } = data;
  const kinds = data.kinds || [];
  const T = person.personal_token;

  return page("Squad Up", `
${data.confirmEmail ? `<div class="bubble notice" id="confirmbox"><h3>Check your email</h3>
  <p class="muted" style="margin:4px 0 10px">Tap the link we sent to ${esc(person.email)} to confirm it's yours. Until then, Squad Up won't send you anything.</p>
  <div class="row tight"><button class="sm" id="resend">Send it again</button></div>
  <div class="err" id="cmsg2"></div></div>` : ""}
${data.awaitingOptIn ? `<div class="bubble welcome" id="optinbox"><h3>Want Squad Up messages?</h3>
  <p class="muted" style="margin:4px 0 10px">A friend added you. You won't get texts or emails about plans until you say you're in on one, or turn them on here.</p>
  <label class="check"><input type="checkbox" id="optinok"><span>${person.phone && data.smsOn ? SMS_CONSENT : "Email me about Squad Up plans I'm invited to."}</span></label>
  <p class="small muted" style="margin:8px 0 0">Optional. <a href="${L.TERMS_URL}">Terms</a> · <a href="${L.PRIVACY_URL}">Privacy</a></p>
  <div class="row"><button class="sm go" id="optin" disabled>Get Squad Up messages</button></div>
  <div class="err" id="optinmsg"></div></div>
<script>(function(){
  var ok=document.getElementById("optinok"), go=document.getElementById("optin");
  ok.onchange=function(){ go.disabled=!ok.checked; };
  go.onclick=async function(){
    go.disabled=true;
    var r=await fetch("/squadup/api/optin",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({token:${js(person.personal_token)}, consent:ok.checked})});
    if(r.ok){var b=document.getElementById("optinbox");b.querySelector("h3").textContent="You're in";
      b.querySelector("p").textContent="You'll hear about plans you're invited to and activities you're interested in.";
      b.querySelectorAll("label,.small,.row").forEach(function(e){e.remove();});}
    else{ document.getElementById("optinmsg").textContent="That didn't go through. Try again."; go.disabled=false; }
  };
})();</script>` : ""}
${person.opted_out_at ? `<div class="bubble notice"><h3>Your messages are off</h3>
  <p class="muted" style="margin:4px 0 10px">You won't get texts or emails about new plans or invites.</p>
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

${activitiesSection(kinds, T, false)}`, POST + actJs(T) + `
var rs=document.getElementById("resend");
if(rs) rs.onclick=async function(){ rs.disabled=true;
  try{ await post("/squadup/api/confirm-resend",{token:${js(T)}}); show("cmsg2","Sent. Check your inbox (and spam).","ok"); }
  catch(e){ show("cmsg2",e.message); rs.disabled=false; } };`, { token: T, isHome: true, me: person });
}

/* ---------------------------------------------------------------- account --
   Opened from the initial at the top right: your name and how to reach you,
   logging out everywhere else, and deleting the account. */
function accountPage(person, data) {
  const T = person.personal_token;
  const leaving = data.leaving || { plans: [], polls: [] };
  return page("Your account · Squad Up", `
<div class="title-row">${avatar(person, "big")}<div><h1>${esc(person.name)}</h1>
  <p class="sub" style="margin:4px 0 0">${esc([person.phone ? C.formatPhone(person.phone) : "", person.email || ""].filter(Boolean).join(" · "))}</p></div></div>
<h2>Your info</h2>
<div class="row"><button class="sm" id="meopen">Edit your info</button></div>
<div class="err" id="rmsg"></div>
<div id="mebox" class="bubble plain hidden" style="margin-top:14px">
  <label for="mname">Name</label>
  <input id="mname" maxlength="60" autocomplete="name" value="${esc(person.name)}">
  <label for="mphone">Phone${data.smsOn ? "" : ` <span class="muted">(Coming Soon)</span>`}</label>
  <input id="mphone" type="tel" autocomplete="tel" placeholder="(239) 555-0123" value="${esc(person.phone || "")}">
  <label for="memail">or Email</label>
  <input id="memail" type="email" autocomplete="email" placeholder="you@example.com" value="${esc(person.email || "")}">
  <div id="msmsrow" class="hidden">
    <label class="check"><input type="checkbox" id="msms"><span>${SMS_CONSENT}</span></label>
    <p class="small muted" style="margin:8px 0 0"><a href="${L.TERMS_URL}">Terms</a> · <a href="${L.PRIVACY_URL}">Privacy</a></p>
  </div>
  <div class="row"><button class="go sm" id="mesave">Save</button>
    <button class="sm quiet" id="mecancel">Cancel</button></div>
  <div class="err" id="memsg"></div>
</div>
<h2>Messages</h2>
${sub(person.opted_out_at ? "Off. You won't get texts or emails about new plans or invites."
  : "You hear about plans you're invited to, and new plans in activities you're interested in (unless that activity's bell is off).")}
<div class="row"><a class="pill sm" href="/squadup/p/${esc(T)}#activities">Your activities</a>
  <a class="pill sm quiet" href="/squadup/stop?t=${esc(T)}">${person.opted_out_at ? "Turn messages back on" : "Stop all messages"}</a></div>
<h2>Log out</h2>
<div class="account-x">
  <a class="pill sm" href="/squadup/logout">Log out</a>
  <button class="sm quiet" id="reset">Log out of all other devices</button>
  <button class="sm quiet danger" id="delopen">Delete my account</button>
</div>
<div class="ok" id="resetmsg"></div>
<div id="delbox" class="bubble notice hidden" style="margin-top:12px">
  <h3>Delete your account?</h3>
  <p class="muted" style="margin:4px 0 8px">Your answers, votes and interests go away, and you won't get any more texts or emails.</p>
  ${leaving.plans.length || leaving.polls.length ? `<p style="margin:0 0 6px"><b>These will be canceled, and everyone will be told:</b></p>
  <ul class="small" style="margin:0 0 8px;padding-left:20px">${[...leaving.plans, ...leaving.polls.map(t => `${t} (finding a time)`)]
    .map(t => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
  <p class="small muted" style="margin:0 0 4px">Past plans stay for everyone else, without your name. Activities you added stay on the list.</p>
  <div class="row tight"><button class="sm danger" id="delgo">Delete my account</button>
    <button class="sm quiet" id="delcancel">Keep it</button></div>
  <div class="err" id="delmsg"></div>
</div>`, POST + `
var TOKEN=${js(T)};
(function(){
  var box=document.getElementById("mebox"), open=document.getElementById("meopen"),
      ph=document.getElementById("mphone"), ORIG=${js(person.phone || "")};
  function digits(s){ return String(s||"").replace(/\D/g,"").replace(/^1(?=\d{10}$)/,""); }
  function consentRow(){ var v=ph.value.trim();
    document.getElementById("msmsrow").classList.toggle("hidden", !v || digits(v)===digits(ORIG)); }
  ph.oninput=consentRow;
  open.onclick=function(){ box.classList.remove("hidden"); open.classList.add("hidden");
    document.getElementById("mname").focus(); };
  document.getElementById("mecancel").onclick=function(){ location.reload(); };
  async function saveMe(claim){
    var b=document.getElementById("mesave"); b.disabled=true; show("memsg","");
    try{ await post("/squadup/api/me",{token:TOKEN,
        name:document.getElementById("mname").value, phone:ph.value,
        email:document.getElementById("memail").value, claim_guest:claim||null,
        sms_consent:document.getElementById("msms").checked});
      location.reload(); }
    catch(e){
      b.disabled=false;
      var m=e.data && e.data.match;
      if(m && m[0] && m[0].guest && confirm(e.message+" Their answers will move to your account.")) return saveMe(m[0].id);
      show("memsg", m ? "Pick a different name, or add a last initial." : e.message);
    }
  }
  document.getElementById("mesave").onclick=function(){ saveMe(null); };
})();
document.getElementById("reset").onclick=async function(){
  if(!confirm("Log out every other phone and computer? This one stays logged in. Older links we sent you stop working too.")) return;
  try{ await post("/squadup/api/reset-link",{token:TOKEN}); show("resetmsg","Done. Everywhere else is logged out.","ok"); }
  catch(e){ show("rmsg",e.message); }
};
document.getElementById("delopen").onclick=function(){ var d=document.getElementById("delbox");
  d.classList.remove("hidden"); d.scrollIntoView({behavior:"smooth",block:"center"}); };
document.getElementById("delcancel").onclick=function(){ document.getElementById("delbox").classList.add("hidden"); };
document.getElementById("delgo").onclick=async function(){
  var b=this; b.disabled=true; show("delmsg","");
  try{ await post("/squadup/api/delete-account",{token:TOKEN, confirm:true}); location.href="/squadup/logout?next=%2Fsquadup"; }
  catch(e){ show("delmsg",e.message); b.disabled=false; }
};`, { token: T, me: person });
}

/* ---------------------------------------------------------------- members --
   Everyone in the squad. Tap a name to see the activities they're into. */
function membersPage(viewer, people, ctx) {
  const T = viewer.personal_token;
  const guest = isGuestP(viewer);
  const members = people.filter(x => !x.guest), guests = people.filter(x => x.guest);
  const row = x => `<details class="mem" id="m-${esc(x.id)}">
    <summary>${avatar(x)}<span class="memname${x.guest ? " gname" : ""}">${esc(x.name)}</span>${x.id === viewer.id ? `<span class="tag">You</span>` : ""}
      <span class="memcount">${x.kinds.length ? `${x.kinds.length} activit${x.kinds.length === 1 ? "y" : "ies"}` : ""}</span></summary>
    <div class="memdetail">
      ${x.kinds.length ? `<div class="chips">${x.kinds.map(k => `<a class="pill chip" style="${tagStyle(k.name)}" href="/squadup/p/${esc(T)}#act-${esc(k.id)}" >${esc(k.name)}</a>`).join("")}</div>`
        : `<p class="small muted" style="margin:0">No activities picked yet.</p>`}
      ${x.guest ? `<p class="small muted" style="margin:8px 0 0">Guest: no texts or emails${x.addedBy ? `. Added by ${esc(x.addedBy)}` : ""}.</p>` : ""}
    </div></details>`;
  return page("Squad members · Squad Up", `
<h1>Squad members</h1>
${sub(`${members.length} member${members.length === 1 ? "" : "s"}${guests.length ? ` and ${guests.length} guest${guests.length === 1 ? "" : "s"}` : ""}. Tap a name to see what they're into.`)}
<div class="bubble plain memlist">${members.map(row).join("") || `<p class="empty">Nobody yet.</p>`}</div>
${guests.length ? `<h2>Guests</h2>
${sub("People added by name, who don't get texts or emails.")}
<div class="bubble plain memlist">${guests.map(row).join("")}</div>` : ""}`, "",
  { token: T, guest, me: viewer, isHome: false });
}

/* -------------------------------------------- filling in for other people --
   Shared by plans and polls: the guest chips (tap to fill in, × to take them
   off), the "Filling in for…" bar with Rename and Merge into… for guests the
   organizer added, and the "is it one of these guests?" question. */
const guestChip = (id, name) => `<span class="gchip-w"><button type="button" class="sm gchip" data-edit="${esc(id)}"><span class="gname">${esc(name)}</span> <span class="muted">Edit</span></button><button type="button" class="sm gx" data-remove="${esc(id)}" aria-label="Remove ${esc(name)}" title="Remove">×</button></span>`;
function proxyBar(hint, people) {
  return `<div class="proxybar hidden" id="proxy" role="status">
  <div class="proxyrow"><span>Filling in for <b id="proxyname"></b>. ${esc(hint)}</span>
  <button class="sm go" id="proxydone">Done</button></div>
  ${people ? `<div class="proxytools hidden" id="proxytools">
    <button type="button" class="sm quiet" id="prename">Rename</button>
    <button type="button" class="sm quiet" id="pmergeopen">Same person as…</button>
    <span id="pmergebox" class="hidden inline"><select id="pmergeinto"><option value="">Pick who they are</option>${
      people.map(x => `<option value="${esc(x.id)}">${esc(x.name)}${x.guest ? " (guest)" : ""}</option>`).join("")}</select>
      <button type="button" class="sm" id="pmergego">Merge</button></span>
  </div>` : ""}
</div>`;
}
const FILLIN_JS = `
function claimShow(id, html){ var c=document.getElementById(id); c.innerHTML=html; c.classList.toggle("hidden",!html); }
function hh(s){ var d=document.createElement("div"); d.textContent=s; return d.innerHTML; }
function askInitial(input,msg){ var g=document.getElementById(input); g.value=g.value.trim().split(" ")[0]+" "; g.focus();
  show(msg,"Add a last initial so you can tell them apart, like \\""+g.value.trim()+" K.\\"","muted"); }
function offerMatches(e, box, msg){
  var m=e.data && e.data.match; if(!m){ show(msg,e.message); return; }
  var g=m.filter(function(x){ return x.guest; }), ex=!!e.data.exact;
  claimShow(box,"<p style='margin:10px 0 8px'>"+hh(e.message)+"</p><div class='row tight'>"+
    g.map(function(x){ return "<button class='sm go' data-pick='"+hh(x.id)+"'>"+(g.length===1&&ex?"Yes, "+hh(x.name):hh(x.name))+"</button>"; }).join("")+
    "<button class='sm quiet' data-new data-exact='"+(ex?1:0)+"'>"+(ex?"No, someone else":"Someone new")+"</button></div>");
}
function proxyShow(name, manage){
  document.getElementById("proxyname").textContent=name; document.getElementById("proxy").classList.remove("hidden");
  var t=document.getElementById("proxytools");
  if(t){ t.classList.toggle("hidden",!manage); document.getElementById("pmergebox").classList.add("hidden"); }
}
function proxyTools(pidFn, onRenamed, onMerged){
  var rn=document.getElementById("prename"); if(!rn) return;
  rn.onclick=async function(){
    var cur=document.getElementById("proxyname").textContent, n=prompt("Their name:", cur);
    if(n===null || !n.trim() || n.trim()===cur) return;
    try{ var r=await post("/squadup/api/guest-rename",{token:TOKEN, person_id:pidFn(), name:n});
      document.getElementById("proxyname").textContent=r.name; await onRenamed(r.name); }
    catch(e){ alert(e.message); }
  };
  document.getElementById("pmergeopen").onclick=function(){
    var b=document.getElementById("pmergebox"), sel=document.getElementById("pmergeinto"), pid=pidFn();
    [].forEach.call(sel.options,function(o){ o.hidden=o.disabled=(o.value===pid); });
    sel.value=""; b.classList.toggle("hidden");
  };
  document.getElementById("pmergego").onclick=async function(){
    var sel=document.getElementById("pmergeinto"); if(!sel.value) return;
    var who=document.getElementById("proxyname").textContent, into=sel.options[sel.selectedIndex].text.replace(/ \\(guest\\)$/,"");
    if(!confirm("Is "+who+" really "+into+"? Their answers move to "+into+", and "+who+" goes away.")) return;
    try{ await post("/squadup/api/guest-merge",{token:TOKEN, person_id:pidFn(), into_id:sel.value}); onMerged(); }
    catch(e){ alert(e.message); }
  };
}`;

/* -------------------------------------------------------------- activity -- */
function activityPage(a, ctx) {
  const { viewer, isCreator, options, responses, counts, tag, creator, guest,
          suggestion, myResponse, peopleById, over, saved, invites, invitedNote, smsOn } = ctx;
  const answers = ctx.answers || [];
  const style = tagStyle(tag);
  const closed = !!a.canceled_at || !!over;     // nothing left to answer
  const path = `/squadup/a/${a.id}`;

  const total = responses.length || 1;
  const zone = C.zoneOf(a.timezone);
  const optHtml = options.map(o => {
    const who = (counts[o.id] || []).map(id => peopleById[id]).filter(x => x && x.name)
      .map(x => ({ name: x.name, guest: isGuestP(x) }));
    const pct = Math.round((who.length / total) * 100);
    const isPlan = o.id === a.locked_option_id;
    const pending = o.status === "pending";
    const mineOn = myResponse && (myResponse.option_ids || []).includes(o.id);
    const label = isPlan ? "The plan" : pending ? "Needs your OK" : o.kind === "backup" ? "Backup" : "Suggested";
    return `<div class="bubble opt${isPlan ? " plan" : ""}${pending ? " pending" : ""}" data-id="${esc(o.id)}" style="${style}">
      <div class="top">
        <div>
          <div class="when">${whenSpan(o.starts_at, zone, C.formatWhen(o.starts_at, zone))}</div>
          <div class="meta"><span class="tag${isPlan ? " solid" : ""}">${label}</span>
            ${o.label ? `<span>${esc(o.label)}</span>` : ""}</div>
        </div>
        ${pending ? "" : `<span class="count">${who.length} in</span>`}
      </div>
      ${who.length ? `<div class="who">${nameList(who)}</div>` : ""}
      ${pending ? "" : `<div class="track"><div class="bar" style="width:${pct}%"></div></div>`}
      ${closed || !viewer ? "" : pending
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
    .map(r => peopleById[r.person_id]).filter(x => x && x.name).map(x => ({ name: x.name, guest: isGuestP(x) }));
  const anyGuest = responses.some(r => isGuestP(peopleById[r.person_id]));
  const iAmOut = myResponse && myResponse.can_make_it === false;
  const lockedOpt = options.find(o => o.id === a.locked_option_id);
  const w = lockedOpt ? whenParts(lockedOpt.starts_at) : null;
  const planOrb = `<div class="orb${w ? "" : " hollow"}"${a.canceled_at ? ' style="filter:grayscale(1);opacity:.6"' : ""}>${
    w ? `<b>${w.day}</b><span>${w.weekday}</span>` : "<b>?</b>"}</div>`;
  const T = viewer ? esc(viewer.personal_token) : "";
  const member = viewer && !guest;
  const SAVED = { in: "Saved. You're in.", out: "Saved. Marked as can't make it.", added: "Added. Everyone can say if it works." };
  const guestChips = answers.filter(x => x.guest).map(x => guestChip(x.person_id, x.name)).join("")
    || `<p class="small muted" style="margin:0">Nobody added yet.</p>`;
  const cal = ctx.calendar;
  const fillIn = isCreator && !closed;

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
  ${cal ? `<div class="row tight calrow"><button type="button" class="sm" id="calopen" aria-expanded="false">Add to calendar</button>
    <span id="calmenu" class="hidden"><a class="pill sm quiet" href="${esc(cal.ics)}">Apple / Outlook</a>
    <a class="pill sm quiet" href="${esc(cal.google)}" target="_blank" rel="noopener">Google</a></span></div>` : ""}
</div>
${guest && !closed ? guestBar(viewer, path) : ""}

${suggestion && isCreator && !closed ? `<div class="bubble callout" style="${style};margin-top:20px">
  <h3>More people can do ${esc(C.formatWhen(suggestion.to.starts_at))}</h3>
  <p class="muted" style="margin:4px 0 0">${suggestion.toCount} vs ${suggestion.fromCount}</p>
  <div class="row tight"><button class="go sm" data-lock="${esc(suggestion.to.id)}">Move it</button>
  <button class="quiet sm" id="keep">Keep it</button></div>
</div>` : ""}

${fillIn ? `<div class="bubble plain" id="others" style="margin-top:14px">
  <h3>Fill in for others</h3>
  <p class="muted small" style="margin:4px 0 10px">For people who answer by text or in person. Add them, or tap a name to change their times.</p>
  <div id="guestlist">${guestChips}</div>
  <div class="inline" style="margin-top:10px"><input id="pname" maxlength="${C.POLL_NAME_MAX}" placeholder="Their name, like Sebastian" autocomplete="off">
    <button class="sm" id="padd">+ Add</button></div>
  <div id="pclaim" class="hidden"></div>
  <div class="err" id="pmsg"></div>
</div>` : ""}

<h2 id="when">When</h2>
${fillIn ? proxyBar("Tap their times.", ctx.people) : ""}
${closed ? "" : sub("Tap every time that works for you.")}
<div id="opts">${optHtml}
${out.length ? `<p class="small muted">Can't make it: ${nameList(out)}</p>` : ""}
${anyGuest ? GUEST_KEY : ""}
<script type="application/json" id="answersjson">${js(answers)}</script></div>

${closed ? (member ? `<div class="row"><a class="pill sm" href="/squadup/new?t=${T}&amp;again=${esc(a.id)}">Do it again</a>
  <a class="pill sm quiet" href="/squadup/past?t=${T}">Past plans</a></div>` : "") : `
<div class="row" style="${style}">
  <button class="sm${iAmOut ? " on" : ""}" id="cant">${iAmOut ? "You're out" : "Can't make it"}</button>
  ${member ? `<button class="sm" id="suggest">Suggest a time</button>` : ""}
</div>
${member ? `<div id="sugbox" class="bubble plain hidden" style="margin-top:14px">
  <label for="sugwhen">Time</label>
  <input id="sugwhen" type="datetime-local">
  <label for="sugnote">Note <span class="muted">(optional)</span></label>
  <input id="sugnote" placeholder="After work works better">
  <div class="row" style="${style}"><button class="go" id="sugsend">Send to ${esc(creator ? firstName(creator.name) : "organizer")}</button></div>
</div>` : ""}
<div class="err" id="msg"></div>`}

${invites ? inviteSection(a, invites, tag, closed, invitedNote, smsOn, { shareUrl: ctx.shareUrl }) : ""}`, POST + FILLIN_JS + `
var A=${js(a.id)}, TOKEN=${js(viewer ? viewer.personal_token : null)}, ME=${js(viewer ? viewer.id : null)}, proxy=null;
function $(id){ return document.getElementById(id); }
function guard(fn){ return async function(){
  try{ await fn.apply(this,arguments); }catch(e){ show("msg", e.message); } }; }
function readAnswers(){ try{ return JSON.parse($("answersjson").textContent); }catch(e){ return []; } }
// LOCAL holds the latest taps for each person, ahead of what the server has sent back
var ANSWERS=readAnswers(), LOCAL={};
function answerOf(pid){ return ANSWERS.find(function(x){ return x.person_id===pid; }); }
function stateOf(pid){ if(pid && LOCAL[pid]) return LOCAL[pid];
  var x=pid && answerOf(pid); return x ? { option_ids:x.option_ids, can_make_it:x.can_make_it } : null; }
function picksOf(pid){ var x=stateOf(pid); return new Set(x && x.can_make_it ? x.option_ids : []); }
var MINE=picksOf(ME);
function markVotes(){
  document.querySelectorAll("[data-vote]").forEach(function(b){
    var on=MINE.has(b.dataset.vote);
    b.classList.toggle("on",on); b.textContent=on?(proxy?"Works ✓":"Works for me ✓"):"This works"; });
  var c=$("cant");
  if(c){ var x=proxy ? (proxy.person_id ? stateOf(proxy.person_id) : proxy.local) : stateOf(ME),
      isOut=!!x && !x.can_make_it && !MINE.size;
    c.classList.toggle("on",isOut); c.textContent=isOut?(proxy?"They're out":"You're out"):"Can't make it"; }
  document.querySelectorAll("[data-edit]").forEach(function(b){ b.classList.toggle("on", !!proxy && b.dataset.edit===proxy.person_id); });
}
// one save per person, in the background
async function saveOne(job){
  if(job.who){
    var pid=job.who.person_id || await job.who.ready; if(!pid) return;
    var body={token:TOKEN, activity_id:A, person_id:pid};
    if(job.cant) body.cant=true; else body.option_ids=job.picks;
    return post("/squadup/api/plan-guest", body);
  }
  return post("/squadup/api/rsvp",{token:TOKEN,activity_id:A,option_ids:job.picks});
}
var saveVotes=batcher(saveOne, async function(){ await refreshPart(["opts","guestlist"]); ANSWERS=readAnswers(); markVotes(); });
function queue(cant){
  var st={ option_ids: cant ? [] : [...MINE], can_make_it: !cant };
  if(proxy){ if(proxy.person_id) LOCAL[proxy.person_id]=st; else proxy.local=st; }
  else LOCAL[ME]=st;
  saveVotes(proxy ? "g"+proxy.key : "me", { who: proxy, picks: [...MINE], cant: !!cant });
}
// one listener for every button in the list, since refreshes swap them out
document.addEventListener("click", function(e){
  var v=e.target.closest("[data-vote]");
  if(v){
    var id=v.dataset.vote;
    if(MINE.has(id)) MINE.delete(id); else MINE.add(id);
    markVotes(); show("msg",""); queue(false); return;
  }
  var b=e.target.closest("[data-lock],[data-approve],[data-dismiss]"); if(!b) return;
  if(b.dataset.lock) return lockIt(b.dataset.lock, b);
  return decide(b.dataset.approve || b.dataset.dismiss, !!b.dataset.approve, b);
});
function whenOf(btn){ var o=btn.closest(".opt"), w=o && o.querySelector(".when [data-at]"); return w ? w.firstChild.textContent : "that time"; }
var lockIt=guard(async function(id, btn){
  var how=await askSend(btn, "Make "+whenOf(btn)+" the plan? You can let everyone know, or change it quietly.",
    "Make it the plan and tell everyone", "Just make it the plan");
  if(!how) return;
  await post("/squadup/api/lock",{token:TOKEN,activity_id:A,option_id:id,notify:how==="send"}); location.reload(); });
var decide=guard(async function(id, yes, btn){
  var how=null;
  if(yes){ how=await askSend(btn, "Add "+whenOf(btn)+"? You can ask everyone if it works for them, or just add it.",
    "Add it and ask everyone", "Just add it"); if(!how) return; }
  await post("/squadup/api/option-decide",{token:TOKEN,option_id:id,approve:yes,notify:how==="send"}); location.reload(); });
var cant=$("cant");
if(cant) cant.onclick = guard(async function(){
  if(proxy){ MINE=new Set(); queue(true); markVotes(); return; }
  await saveVotes.flush();
  await post("/squadup/api/rsvp",{token:TOKEN,activity_id:A,cant:true}); location.reload(); });
var keep=$("keep");
if(keep) keep.onclick=function(){ this.closest(".callout").style.display="none"; };
var sug=$("suggest");
if(sug) sug.onclick=function(){ var b=$("sugbox"); b.classList.toggle("hidden");
  if(!b.classList.contains("hidden")) $("sugwhen").focus(); };
var ss=$("sugsend");
if(ss) ss.onclick = guard(async function(){
  await post("/squadup/api/suggest",{token:TOKEN,activity_id:A,
    starts_at:$("sugwhen").value, label:$("sugnote").value});
  location.reload();
});

/* The organizer filling in for people who texted. Nothing here waits on the
   network: + Add opens the bar at once while the name is checked in the
   background, and taps save behind the scenes. */
if($("others")){
  var seq=0, asking=null;
  function known(pid, name){ return { key:++seq, name:name, person_id:pid, done:true, ready:Promise.resolve(pid) }; }
  function fresh(name){
    var p={ key:++seq, name:name, person_id:null, done:false }, res;
    p.ready=new Promise(function(r){ res=r; });
    p.settle=function(id){ if(p.done) return; p.done=true; p.person_id=id;
      if(id && p.local) LOCAL[id]=p.local; res(id); };
    return p;
  }
  // a name still waiting on "is it one of these?" is dropped if they move on
  function leave(){ if(proxy && !proxy.done){ proxy.settle(null); claimShow("pclaim",""); } }
  function fillFor(p){
    if(proxy!==p) leave();
    proxy=p;
    MINE=p.person_id ? picksOf(p.person_id) : new Set(p.local && p.local.can_make_it ? p.local.option_ids : []);
    var x=p.person_id && answerOf(p.person_id);
    proxyShow(p.name, !!(x && x.manage));
    show("pmsg",""); markVotes();
    var bar=$("proxy").getBoundingClientRect(); if(bar.top<0 || bar.top>innerHeight*0.6) $("when").scrollIntoView({behavior:"smooth", block:"start"});
  }
  function proxyEnd(){ leave(); proxy=null; MINE=picksOf(ME); $("proxy").classList.add("hidden"); markVotes(); }
  function chipHtml(pid, name){
    return "<span class='gchip-w'><button type='button' class='sm gchip' data-edit='"+hh(pid)+"'><span class='gname'>"+hh(name)+
      "</span> <span class='muted'>Edit</span></button><button type='button' class='sm gx' data-remove='"+hh(pid)+
      "' aria-label='Remove "+hh(name)+"' title='Remove'>×</button></span>";
  }
  function addChip(pid, name, picks){
    if(!answerOf(pid)) ANSWERS.push({ person_id:pid, name:name, guest:true, manage:true, option_ids:picks||[], can_make_it:true });
    var gl=$("guestlist");
    if([].some.call(gl.querySelectorAll("[data-edit]"),function(b){ return b.dataset.edit===pid; })) return;
    var none=gl.querySelector("p"); if(none) none.remove();
    gl.insertAdjacentHTML("beforeend", chipHtml(pid, name)); markVotes();
  }
  // check a name with the server: the same guest, a close one, or someone new
  function check(p, how){
    var body={token:TOKEN, activity_id:A, option_ids:[], peek:true};
    if(how.pick) body.person_id=how.pick; else { body.name=p.name; body.skipSimilar=!!how.skip; }
    post("/squadup/api/plan-guest", body).then(function(r){
      if(p.done) return;
      var before=answerOf(r.person_id), manage=before ? !!before.manage : true;
      p.name=r.name; addChip(r.person_id, r.name, r.option_ids);
      var tapped=p.local ? p.local.option_ids : [];
      p.settle(r.person_id);
      if(proxy===p){
        // someone already there: keep what they had, plus anything tapped meanwhile
        MINE=new Set((r.option_ids||[]).concat(tapped));
        proxyShow(r.name, manage); markVotes();
        if(tapped.length) queue(false);
      }
    }).catch(function(e){
      if(p.done) return;
      if(proxy===p && e.data && e.data.match){ asking=p; offerMatches(e, "pclaim", "pmsg"); return; }
      p.settle(null); if(proxy===p){ proxyEnd(); show("pmsg", e.message); }
    });
  }
  function padd(){
    var n=$("pname").value.trim().replace(/\\s+/g," "); show("pmsg",""); claimShow("pclaim","");
    if(!n){ show("pmsg","Type their name first."); return; }
    var same=ANSWERS.find(function(x){ return x.name.toLowerCase()===n.toLowerCase(); });
    $("pname").value="";
    if(same && same.guest) return fillFor(known(same.person_id, same.name));
    if(same){ show("pmsg", same.name+" has a Squad Up account, so they answer for themselves."); return; }
    var p=fresh(n); fillFor(p); check(p, {});
    $("pname").focus();
  }
  $("padd").onclick=padd;
  $("pname").addEventListener("keydown",function(e){ if(e.key==="Enter") padd(); });
  $("pclaim").addEventListener("click",function(e){
    var b=e.target.closest("button"); if(!b) return;
    var p=asking; claimShow("pclaim",""); if(!p || p.done) return;
    if(b.hasAttribute("data-new")){
      if(b.dataset.exact==="1"){ p.settle(null); if(proxy===p) proxyEnd(); $("pname").value=p.name; return askInitial("pname","pmsg"); }
      return check(p, {skip:true});
    }
    check(p, {pick:b.dataset.pick});
  });
  $("guestlist").addEventListener("click", function(e){
    var rm=e.target.closest("[data-remove]");
    if(rm){
      var pid=rm.dataset.remove, gx=answerOf(pid);
      if(!confirm("Take "+(gx?gx.name:"them")+" off this plan?")) return;
      rm.closest(".gchip-w").remove();
      ANSWERS=ANSWERS.filter(function(x){ return x.person_id!==pid; }); delete LOCAL[pid];
      if(proxy && proxy.person_id===pid) proxyEnd();
      // their own saves go first, so the removal is the last word
      saveVotes.flush().then(function(){
        return post("/squadup/api/plan-guest",{token:TOKEN, activity_id:A, person_id:pid, remove:true}); })
        .then(function(){ return refreshPart(["opts","guestlist"]); }).then(function(){ ANSWERS=readAnswers(); markVotes(); })
        .catch(function(err){ show("pmsg",err.message); });
      return;
    }
    var b=e.target.closest("[data-edit]"); if(!b) return;
    var x=answerOf(b.dataset.edit); if(x) fillFor(known(x.person_id, x.name));
  });
  $("proxydone").onclick=function(){ saveVotes.now(); proxyEnd(); $("others").scrollIntoView({behavior:"smooth", block:"center"}); };
  proxyTools(function(){ return proxy && proxy.person_id; }, async function(newName){
    proxy.name=newName; var x=answerOf(proxy.person_id); if(x) x.name=newName;
    [].forEach.call($("guestlist").querySelectorAll("[data-edit]"),function(b){ if(b.dataset.edit===proxy.person_id) b.querySelector(".gname").textContent=newName; });
    await saveVotes.flush(); await refreshPart(["opts","guestlist"]); ANSWERS=readAnswers(); markVotes();
  }, function(){ location.reload(); });
}
var co=$("calopen");
if(co) co.onclick=function(){ var m=$("calmenu"), open=m.classList.contains("hidden");
  m.classList.toggle("hidden",!open); co.setAttribute("aria-expanded",open); };
${invites ? inviteJs({ invite: "/squadup/api/invite", idKey: "activity_id", back: "/squadup/a/",
  shareTitle: C.fullTitle(a), shareText: `Can you make ${C.fullTitle(a)}?` }) : ""}`,
  { token: viewer ? viewer.personal_token : null, guest, me: viewer,
    og: { title: C.fullTitle(a), url: ctx.shareUrl,
      description: lockedOpt ? `${C.formatWhen(lockedOpt.starts_at, zone)}. Say if you can make it.` : "Say which times work for you." } });
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
    n.textContent = picked.size ? "Send " + picked.size + " invite" + (picked.size===1?"":"s") : "Send invites";
    n.disabled = !picked.size;
    // say exactly what's about to go out
    var t=0, m=0, x=0;
    document.querySelectorAll("[data-invitee].on").forEach(function(c){ if(c.dataset.via==="text") t++; else if(c.dataset.via==="email") m++; else x++; });
    var parts=[]; if(t) parts.push(t+" text"+(t===1?"":"s")); if(m) parts.push(m+" email"+(m===1?"":"s"));
    show("invnote", picked.size ? "Sends "+(parts.join(" and ")||"nothing")+" now."+(x?" "+x+" can't be messaged; it'll be on their page.":"") : "", "small muted"); };
});
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
var cp=document.getElementById("copy");
if(cp){
  var surl=document.getElementById("shareurl").textContent;
  cp.onclick=async function(){
    try{ await navigator.clipboard.writeText(surl); show("cmsg","Copied. Paste it in a text or group chat.","ok"); }
    catch(e){ var rg=document.createRange(); rg.selectNodeContents(document.getElementById("shareurl"));
      var sel=getSelection(); sel.removeAllRanges(); sel.addRange(rg); show("cmsg","Selected. Copy it from here.","ok"); }
  };
  if(navigator.share){ var nsh=document.getElementById("nshare"); nsh.classList.remove("hidden");
    nsh.onclick=function(){ navigator.share({title:${JSON.stringify(cfg.shareTitle || "")}, text:${JSON.stringify(cfg.shareText || "")}, url:surl}).catch(function(){}); }; }
}
`;
}

/* invites: who's been asked, a picker for people on Squad Up, and a link to
   send anyone else (they answer as a guest, or join with their own number) */
const MARK = { in: " ✓", out: " ✗", none: "" };
function inviteSection(a, inv, tag, closed, note, smsOn, words) {
  const w = words || {};
  const VIA = { sms: "text", email: "email" };
  const people = list => list.map(p => `<button type="button" class="chip" data-invitee="${esc(p.id)}" data-via="${esc(VIA[p.via] || "")}"
      aria-pressed="false">${esc(p.name)}${VIA[p.via] ? ` <span class="via">${VIA[p.via]}</span>` : ""}</button>`).join("");
  if (closed && !inv.invited.length) return "";
  const share = w.shareUrl && !closed ? `<div class="sharebox" id="share">
    <label>Send a link to anyone</label>
    <p class="small muted" style="margin:0 0 8px">${w.shareHint || "Text it from your phone or drop it in a group chat. They can answer as a guest or join."}</p>
    <code class="link" id="shareurl">${esc(w.shareUrl)}</code>
    <div class="row tight"><button class="go sm" id="copy">Copy link</button>
      <button class="sm hidden" id="nshare">Share…</button></div>
    <div class="ok" id="cmsg"></div>
  </div>` : "";
  const any = inv.into.length || inv.others.length;
  return `<h2 id="invited">Invite</h2>
${closed ? "" : sub(w.lead || "Pick people on Squad Up, or send a link to anyone.")}
${note ? `<div class="bubble saved">${note.n ? `Invited ${note.n}.` : "They were already invited."}${
    note.held ? ` ${note.held} couldn't be messaged today (daily limit), but they'll see it on the site.` : ""}${
    note.unreachable ? ` ${note.unreachable} can't be reached right now (they turned off messages, or have no email).` : ""}${
    note.waiting ? ` ${note.waiting} already got an invite and haven't said they're in yet, so they weren't messaged again. It's on their page if they look.` : ""}</div>` : ""}
${inv.invited.length ? `<label>Invited</label><div class="people">${inv.invited.map(p =>
    `<span class="person ${p.status}" title="${p.by ? "Invited by " + esc(p.by) : ""}">${esc(p.name)}${MARK[p.status]}</span>`
  ).join("")}</div>` : ""}
${closed ? "" : `
<div class="bubble plain" style="margin-top:14px;${tagStyle(tag)}">
  ${share}
  ${any ? `<div class="row"><button class="sm" id="inviteopen">+ Invite people on Squad Up</button></div>
  <div id="invitebox" class="hidden" style="margin-top:10px">
    <p class="small muted" style="margin:0 0 6px">Pick people, then tap Send. Each one gets a text (or an email, if they don't get texts) with the plan and one-tap answers.</p>
    ${inv.into.length ? `<label>Into ${esc(tag ? tag.name : "this")}</label>
    <div class="chips">${people(inv.into)}</div>` : ""}
    ${inv.others.length ? `<label>${inv.into.length ? "Everyone else" : "Everyone"}</label>
    <div class="chips">${people(inv.others)}</div>` : ""}
    <div class="row"><button class="go" id="invitesend" disabled>Send invites</button></div>
    <p id="invnote" class="small muted"></p>
  </div>` : ""}
  <div class="err" id="invmsg"></div>
</div>`}`;
}

/* ------------------------------------------------------------- new/edit -- */
// One form for a new plan, scheduling an activity, "Do it again", and editing.
// "Schedule it": who's interested, and who'll get a message about it
function whoHears(interest, what) {
  const ppl = interest.people || [];
  if (!ppl.length) return sub(`Nobody else is interested in ${esc(interest.tag.name)} yet. Invite people from the ${what} once it's up.`);
  const ping = ppl.filter(x => !x.guest && !x.muted), quiet = ppl.filter(x => x.guest || x.muted);
  return sub(`Interested: ${nameList(ppl)}.` +
    (ping.length ? ` ${ping.length === ppl.length ? "They'll" : `${ping.length} of them will`} get a message when you post it.` : "") +
    (quiet.some(x => x.guest) ? " Guests don't get messages, so let them know yourself." : "") +
    (quiet.some(x => x.muted && !x.guest) ? ` ${quiet.filter(x => x.muted && !x.guest).length === 1 ? "One has" : "Some have"} the bell off.` : ""));
}

function newPage(person, tags, opts) {
  const o = opts || {};
  const interest = o.interest || null;
  const f = o.prefill || {};
  const edit = !!o.editId;
  const style = f.tag_id ? tagStyle((tags.find(t => t.id === f.tag_id) || {}).name) : "";
  const T = person.personal_token;
  const fp = o.fromPoll || null;
  const heading = edit ? "Edit plan" : fp ? "Make it a plan" : interest ? `Schedule ${interest.tag.name}` : o.prefill ? "Do it again" : "New plan";
  const zone = C.zoneOf(f.timezone);

  return page(heading + " · Squad Up", `
<h1>${heading}</h1>
${edit ? sub("Nothing is sent unless you choose to: if you change the day or place, you'll be asked whether to tell everyone. A new time on the same day keeps everyone's answers.") : ""}
${fp ? sub(`<b>${esc(fp.when)}</b> works for ${fp.n} of ${fp.of}${fp.maybe ? ` (plus ${fp.maybe} if need be)` : ""}. ${f.backup ? "The next most popular date is filled in as the backup. " : ""}Check the time, pick an activity, and post it. Everyone who said that date works, or could make it work, goes on the plan.`) : ""}
${interest ? whoHears(interest, "plan") : ""}
<div class="bubble plain" style="margin-top:18px;${style}">
  <label for="title">What</label>
  <input id="title" maxlength="120" placeholder="Pickleball" value="${esc(f.title)}">

  <label for="loc">Where <span class="muted">(optional)</span></label>
  <input id="loc" maxlength="${C.LOCATION_MAX}" placeholder="Josh's place" value="${esc(f.location)}">

  <label for="tag">Activity</label>
  ${tagPicker(tags, f.tag_id || null)}

  <label for="p1">When</label>
  <input id="p1" type="datetime-local" value="${esc(f.primary)}">
  <div id="tzrow" class="small muted hidden" style="margin-top:6px"></div>
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
${!edit && !fp ? `<p class="small muted" style="margin-top:6px">Not sure when? <a href="/squadup/find?t=${esc(T)}${interest ? `&amp;tag=${esc(interest.tag.id)}` : ""}">Find a time with everyone</a> instead.</p>` : ""}
${edit ? `<div class="row" style="margin-top:36px"><button class="quiet danger sm" id="del">Delete plan</button></div>` : ""}`,
  POST + TAGPICKER_JS + `
var TOKEN=${JSON.stringify(T)}, EDIT=${JSON.stringify(o.editId || null)},
    ORIG=${js(edit ? { primary: f.primary || "", backup: f.backup || "", location: f.location || "", timezone: C.zoneOf(f.timezone) } : null)};
function v(id){ return document.getElementById(id).value; }
// Times are in the plan's zone (the squad's home zone). Only when this phone
// is somewhere else does it ask which one is meant.
var ZONE=${js(zone)}, HOME=${js(C.HOME_ZONE)}, tz=ZONE;
(function(){ try{
  var mine=Intl.DateTimeFormat().resolvedOptions().timeZone; if(!mine || (mine===ZONE && ZONE===HOME)) return;
  function nm(z){ try{ var p=new Intl.DateTimeFormat("en-US",{timeZone:z,timeZoneName:"long"}).formatToParts(new Date()).find(function(x){return x.type==="timeZoneName";});
    return p ? p.value.replace(/ (Standard|Daylight) Time$/," Time") : z; }catch(e){ return z; } }
  var opts=[ZONE]; if(HOME!==ZONE) opts.push(HOME); if(opts.indexOf(mine)<0) opts.push(mine);
  var row=document.getElementById("tzrow");
  row.innerHTML="Times are in <select id='tzsel'>"+opts.map(function(z){ return "<option value='"+z+"'"+(z===ZONE?" selected":"")+">"+nm(z)+(z===mine?" (your phone)":"")+"</option>"; }).join("")+"</select>";
  row.classList.remove("hidden");
  document.getElementById("tzsel").onchange=function(){ tz=this.value; };
}catch(e){} })();
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
      primary:v("p1"), backup:backupVal(), note:v("note"), timezone:tz}, tagFields());
  try{
    if(EDIT){
      // a new day or place: the organizer chooses whether everyone hears about it
      var what=[], day=function(x){ return String(x||"").split("T")[0]; };
      if(day(fields.primary)!==day(ORIG.primary) || (ORIG.backup && fields.backup && day(fields.backup)!==day(ORIG.backup)) ||
         (!ORIG.backup && fields.backup) || (ORIG.backup && !fields.backup) || fields.timezone!==ORIG.timezone) what.push("day");
      if(fields.location.trim()!==(ORIG.location||"")) what.push("place");
      var notify=false;
      if(what.length){
        this.disabled=false;
        var how=await askSend(this, "This changes the "+what.join(" and ")+". Send everyone who's in an update?",
          "Save and tell everyone", "Just save");
        if(!how) return;
        notify = how==="send"; this.disabled=true;
      }
      await post("/squadup/api/activity-edit", Object.assign({activity_id:EDIT, notify:notify}, fields));
      location.href="/squadup/a/"+EDIT+"?t="+encodeURIComponent(TOKEN);
    } else {
      var r=await post("/squadup/api/activity", Object.assign({
        poll_id:${js(fp ? fp.id : null)}, poll_option_id:${js(fp ? fp.optionId : null)},
        poll_backup_option_id:${js(fp ? fp.backupOptionId : null)}}, fields));
      location.href="/squadup/a/"+r.id+"?t="+encodeURIComponent(TOKEN);
    }
  }catch(e){ show("msg",e.message); this.disabled=false; }
};
var del=document.getElementById("del");
if(del) del.onclick=async function(){
  var how=await askSend(del, "Delete this plan? You can tell everyone it's off, or delete it quietly.",
    "Delete and tell everyone", "Delete quietly");
  if(!how) return;
  var why=how==="send" ? prompt("Add a reason for everyone (optional).") : "";
  if(why===null) return;
  try{ await post("/squadup/api/cancel",{token:TOKEN,activity_id:EDIT,reason:why,notify:how==="send"});
    location.href="/squadup/a/"+EDIT+"?t="+encodeURIComponent(TOKEN); }
  catch(e){ show("msg",e.message); }
};`, { token: T, me: person });
}


/* ----------------------------------------------------------------- start -- */
// "+ New plan": you already know when, or you want to find a time together.
function startPage(person, tag) {
  const T = esc(person.personal_token);
  const idea = tag ? `&amp;tag=${esc(tag.id)}` : "";
  return page((tag ? `Schedule ${tag.name}` : "New plan") + " · Squad Up", `
<h1>${tag ? `Schedule ${esc(tag.name)}` : "New plan"}</h1>
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
</a>`, "", { token: person.personal_token, me: person });
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
  const interest = o.interest || null;
  const T = person.personal_token;
  return page("Find a time · Squad Up", `
<h1>Find a time</h1>
${sub("Pick every date that could work. You'll get a link to send. People tap the ones that work for them, with just their name.")}
${interest ? whoHears(interest, "poll") : ""}
<div class="bubble plain" style="margin-top:18px">
  <label for="title">What</label>
  <input id="title" maxlength="120" placeholder="Pickleball" value="${esc(interest ? interest.tag.name : "")}">
  <label for="loc">Where <span class="muted">(optional)</span></label>
  <input id="loc" maxlength="${C.LOCATION_MAX}" placeholder="Josh's place">
  <label for="tag">Activity</label>
  ${tagPicker(tags, interest ? interest.tag.id : null)}
  <p class="small muted" style="margin:6px 0 0">Everyone interested in it sees the vote on their home page, and gets a message unless they've turned its bell off.</p>
  <label>Dates</label>
  ${CAL_HTML("cal")}
  <label for="note">Note <span class="muted">(optional)</span></label>
  <input id="note" maxlength="280" placeholder="Evenings are best">
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
      options:cal.picked()}, tagFields()));
    location.href="/squadup/f/"+r.id+"?t="+encodeURIComponent(TOKEN)+"&created=1";
  }catch(e){ show("msg",e.message); b.disabled=false; }
};`, { token: T, me: person });
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
  <label for="tag">Activity</label>
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
};`, { token: T, me: person });
}

/* ------------------------------------------------------------------ poll -- */
function pollPage(poll, ctx) {
  const { options, votes, viewer, creator, plan, isCreator, myVote, created, shareUrl,
          tag, invites, invitedNote, smsOn, saved } = ctx;
  const T = viewer ? viewer.personal_token : null;
  const done = !!poll.finalized_at;
  const live = options.filter(o => !o.past);
  const yes = {}, maybe = {}, score = {};
  const item = v => ({ name: v.name, guest: !v.member });
  options.forEach(o => {
    yes[o.id] = votes.filter(v => v.option_ids.includes(o.id)).map(item);
    maybe[o.id] = votes.filter(v => (v.maybe_ids || []).includes(o.id) && !v.option_ids.includes(o.id)).map(item);
    score[o.id] = yes[o.id].length + maybe[o.id].length / 2;
  });
  const top = Math.max(0, ...live.map(o => score[o.id]));
  const total = votes.length || 1;
  const none = votes.filter(v => !v.option_ids.length && !(v.maybe_ids || []).length).map(item);
  const style = tag ? tagStyle(tag) : "--h:276;--l:52%";
  const guests = votes.filter(v => !v.member);
  const guestChips = guests.length
    ? guests.map(v => guestChip(v.id, v.name)).join("")
    : `<p class="small muted" style="margin:0">Nobody added yet.</p>`;

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
      ${y.length ? `<div class="who">${fullList(y)}</div>` : ""}
      ${m.length ? `<div class="who soft">If need be: ${fullList(m)}</div>` : ""}
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

${created && isCreator ? `<div class="bubble saved">It's up. <a href="#invited">Send the link</a> to anyone you want to ask.</div>` : ""}
${ctx.guest && !done ? guestBar(viewer, `/squadup/f/${poll.id}`) : ""}

${isCreator && !done ? `<div class="bubble plain" id="others" style="margin-top:14px">
  <h3>Fill in for others</h3>
  <p class="muted small" style="margin:4px 0 10px">For people who answer by text or in person. Add them, or tap a name to change their dates.</p>
  <div id="guestlist">${guestChips}</div>
  <div class="inline" style="margin-top:10px"><input id="pname" maxlength="${C.POLL_NAME_MAX}" placeholder="Their name, like Sebastian" autocomplete="off">
    <button class="sm" id="padd">+ Add</button></div>
  <div id="pclaim" class="hidden"></div>
  <div class="err" id="pmsg"></div>
</div>` : ""}

<h2 id="dates">Which dates work?</h2>
${isCreator && !done ? proxyBar("Tap their dates.", ctx.people) : ""}
<div id="pollopts">
${done ? "" : sub((votes.length ? `${votes.length} ${votes.length === 1 ? "person has" : "people have"} answered. ` : "Nobody's answered yet. ") +
  "Tap <b>This works</b> on every date you can make, or <b>If need be</b> if you could make it work.")}
${optHtml}
${none.length ? `<p class="small muted">None of these work: ${fullList(none)}</p>` : ""}
${guests.length ? GUEST_KEY : ""}
<script type="application/json" id="votesjson">${js(votes)}</script>
</div>
<div class="err" id="msg"></div>

${isCreator && !done && live.length ? `<div class="row" style="${style}">
  <a class="pill sm go" href="/squadup/new?t=${esc(T)}&amp;poll=${esc(poll.id)}">Make the leader the plan</a></div>` : ""}

${invites ? `<div style="${style}">${inviteSection(poll, invites, tag, false, invitedNote, smsOn, {
    lead: "Ask people to vote: pick people on Squad Up, or send a link to anyone.",
    shareUrl, shareHint: "Text it from your phone or drop it in a group chat. They can vote as a guest or join." })}</div>` : ""}`,
  POST + FILLIN_JS + `
var P=${js(poll.id)}, A=P, TOKEN=${js(T)}, DONE=${done}, VOTES=${js(votes)},
    MEMBER=${js(viewer ? { name: viewer.name, vote_id: myVote ? myVote.id : null } : null)};
var me=null, proxy=null, LOCAL={};
function $(id){ return document.getElementById(id); }
function readVotes(){ try{ VOTES=JSON.parse($("votesjson").textContent); }catch(e){} }
function voteById(id){ return id ? VOTES.find(function(v){return v.id===id;}) : null; }
// LOCAL holds the latest taps for each answer, ahead of what the server has sent back
function stateOf(id){ if(id && LOCAL[id]) return LOCAL[id]; var v=voteById(id);
  return v ? { option_ids:v.option_ids, maybe_ids:v.maybe_ids||[] } : null; }
var picks=new Set(), maybes=new Set();
function loadPicks(st){ picks=new Set(st ? st.option_ids : []); maybes=new Set(st ? (st.maybe_ids||[]) : []); }
function mark(){
  var can=!!(me||proxy), self=!proxy;
  document.querySelectorAll("[data-pick]").forEach(function(b){
    var on=picks.has(b.dataset.pick);
    b.disabled=!can; b.classList.toggle("on",on); b.textContent=on?(self?"Works for me ✓":"Works ✓"):"This works";
    b.setAttribute("aria-pressed",on); });
  document.querySelectorAll("[data-maybe]").forEach(function(b){
    var on=maybes.has(b.dataset.maybe);
    b.disabled=!can; b.classList.toggle("on",on); b.textContent=on?"If need be ✓":"If need be";
    b.setAttribute("aria-pressed",on); });
  document.querySelectorAll("[data-edit]").forEach(function(b){ b.classList.toggle("on", !!proxy && b.dataset.edit===proxy.vote_id); });
}
function who(){
  if(DONE || !MEMBER) return;
  me={name:MEMBER.name, vote_id:MEMBER.vote_id};
  loadPicks(stateOf(me.vote_id) || LOCAL.me); mark();
}
// one save per answer, in the background
async function saveOne(job){
  var body={token:TOKEN, poll_id:P, option_ids:job.picks, maybe_ids:job.maybes};
  if(job.who){
    var vid=job.who.vote_id || await job.who.ready; if(!vid) return;
    body.vote_id=vid; return post("/squadup/api/poll-guest", body);
  }
  var r=await post("/squadup/api/poll-vote", body);
  me.vote_id=r.vote_id; MEMBER.vote_id=r.vote_id; return r;
}
var saveSoon=batcher(saveOne, async function(){ await refreshPart(["pollopts","guestlist"]); readVotes(); mark(); });
function queue(){
  var st={ option_ids:[...picks], maybe_ids:[...maybes] };
  if(proxy){ if(proxy.vote_id) LOCAL[proxy.vote_id]=st; else proxy.local=st; }
  else { if(me.vote_id) LOCAL[me.vote_id]=st; LOCAL.me=st; }
  saveSoon(proxy ? "g"+proxy.key : "me", { who:proxy, picks:st.option_ids, maybes:st.maybe_ids });
}
function flip(id, mine, other){
  if(!me && !proxy) return;
  if(mine.has(id)) mine.delete(id); else { mine.add(id); other.delete(id); }
  mark(); show("msg",""); queue();
}
if(!DONE){
  $("pollopts").addEventListener("click", function(e){
    var b=e.target.closest("[data-pick],[data-maybe]"); if(!b) return;
    if(b.dataset.pick) flip(b.dataset.pick, picks, maybes); else flip(b.dataset.maybe, maybes, picks);
  });
  who();
}

/* The organizer filling in for people who texted. Nothing here waits on the
   network: + Add opens the bar at once while the name is checked in the
   background, and taps save behind the scenes. */
if($("others")){
  var seq=0, asking=null;
  function known(vid, name){ return { key:++seq, name:name, vote_id:vid, done:true, ready:Promise.resolve(vid) }; }
  function fresh(name){
    var p={ key:++seq, name:name, vote_id:null, done:false }, res;
    p.ready=new Promise(function(r){ res=r; });
    p.settle=function(id){ if(p.done) return; p.done=true; p.vote_id=id;
      if(id && p.local) LOCAL[id]=p.local; res(id); };
    return p;
  }
  function leave(){ if(proxy && !proxy.done){ proxy.settle(null); claimShow("pclaim",""); } }
  function fillFor(p){
    if(proxy!==p) leave();
    proxy=p; loadPicks(p.vote_id ? stateOf(p.vote_id) : p.local);
    var v=p.vote_id && voteById(p.vote_id);
    proxyShow(p.name, !!(v && v.manage));
    show("pmsg",""); mark();
    var bar=$("proxy").getBoundingClientRect(); if(bar.top<0 || bar.top>innerHeight*0.6) $("dates").scrollIntoView({behavior:"smooth", block:"start"});
  }
  function proxyEnd(){ leave(); proxy=null; $("proxy").classList.add("hidden"); who(); mark(); }
  function chipHtml(vid, name){
    return "<span class='gchip-w'><button type='button' class='sm gchip' data-edit='"+hh(vid)+"'><span class='gname'>"+hh(name)+
      "</span> <span class='muted'>Edit</span></button><button type='button' class='sm gx' data-remove='"+hh(vid)+
      "' aria-label='Remove "+hh(name)+"' title='Remove'>×</button></span>";
  }
  function addChip(r){
    if(!voteById(r.vote_id)) VOTES.push({ id:r.vote_id, name:r.name, member:false, pid:r.person_id||null, manage:true,
      option_ids:r.option_ids||[], maybe_ids:r.maybe_ids||[] });
    var gl=$("guestlist");
    if([].some.call(gl.querySelectorAll("[data-edit]"),function(b){ return b.dataset.edit===r.vote_id; })) return;
    var none=gl.querySelector("p"); if(none) none.remove();
    gl.insertAdjacentHTML("beforeend", chipHtml(r.vote_id, r.name)); mark();
  }
  function check(p, how){
    var body={token:TOKEN, poll_id:P, option_ids:[], maybe_ids:[], peek:true};
    if(how.pick) body.person_id=how.pick; else { body.name=p.name; body.skipSimilar=!!how.skip; }
    post("/squadup/api/poll-guest", body).then(function(r){
      if(p.done) return;
      var before=voteById(r.vote_id), manage=before ? !!before.manage : true;
      p.name=r.name; addChip(r);
      var t=p.local;
      p.settle(r.vote_id);
      if(proxy===p){
        var had=voteById(r.vote_id) || {};
        picks=new Set((had.option_ids||[]).concat(t ? t.option_ids : []));
        maybes=new Set((had.maybe_ids||[]).concat(t ? t.maybe_ids : []).filter(function(id){ return !picks.has(id); }));
        proxyShow(r.name, manage); mark();
        if(t) queue();
      }
    }).catch(function(e){
      if(p.done) return;
      if(proxy===p && e.data && e.data.match){ asking=p; offerMatches(e, "pclaim", "pmsg"); return; }
      p.settle(null); if(proxy===p){ proxyEnd(); show("pmsg", e.message); }
    });
  }
  function padd(){
    var n=$("pname").value.trim().replace(/\\s+/g," "); show("pmsg",""); claimShow("pclaim","");
    if(!n){ show("pmsg","Type their name first."); return; }
    var same=VOTES.find(function(v){ return v.name.toLowerCase()===n.toLowerCase(); });
    $("pname").value="";
    if(same && !same.member) return fillFor(known(same.id, same.name));
    if(same){ show("pmsg", same.name+" has a Squad Up account, so they answer for themselves."); return; }
    var p=fresh(n); fillFor(p); check(p, {});
    $("pname").focus();
  }
  $("padd").onclick=padd;
  $("pname").addEventListener("keydown",function(e){ if(e.key==="Enter") padd(); });
  $("pclaim").addEventListener("click",function(e){
    var b=e.target.closest("button"); if(!b) return;
    var p=asking; claimShow("pclaim",""); if(!p || p.done) return;
    if(b.hasAttribute("data-new")){
      if(b.dataset.exact==="1"){ p.settle(null); if(proxy===p) proxyEnd(); $("pname").value=p.name; return askInitial("pname","pmsg"); }
      return check(p, {skip:true});
    }
    check(p, {pick:b.dataset.pick});
  });
  $("guestlist").addEventListener("click", function(e){
    var rm=e.target.closest("[data-remove]");
    if(rm){
      var vid=rm.dataset.remove, gv=voteById(vid);
      if(!confirm("Take "+(gv?gv.name:"them")+" off this vote?")) return;
      rm.closest(".gchip-w").remove();
      VOTES=VOTES.filter(function(v){ return v.id!==vid; }); delete LOCAL[vid];
      if(proxy && proxy.vote_id===vid) proxyEnd();
      saveSoon.flush().then(function(){
        return post("/squadup/api/poll-guest",{token:TOKEN, poll_id:P, vote_id:vid, remove:true}); })
        .then(function(){ return refreshPart(["pollopts","guestlist"]); }).then(function(){ readVotes(); mark(); })
        .catch(function(err){ show("pmsg",err.message); });
      return;
    }
    var b=e.target.closest("[data-edit]"); if(!b) return;
    var v=voteById(b.dataset.edit); if(v) fillFor(known(v.id, v.name));
  });
  $("proxydone").onclick=function(){ saveSoon.now(); proxyEnd(); $("others").scrollIntoView({behavior:"smooth", block:"center"}); };
  proxyTools(function(){ var v=proxy && voteById(proxy.vote_id); return v && v.pid; }, async function(newName){
    proxy.name=newName; var v=voteById(proxy.vote_id); if(v) v.name=newName;
    [].forEach.call($("guestlist").querySelectorAll("[data-edit]"),function(b){ if(b.dataset.edit===proxy.vote_id) b.querySelector(".gname").textContent=newName; });
    await saveSoon.flush(); await refreshPart(["pollopts","guestlist"]); readVotes(); mark();
  }, function(){ location.reload(); });
}
${invites ? inviteJs({ invite: "/squadup/api/poll-invite", idKey: "poll_id", back: "/squadup/f/",
  shareTitle: C.fullTitle(poll), shareText: "Which of these dates work for you?" }) : ""}`,
  { token: T, guest: !!ctx.guest, me: ctx.viewer, og: { title: `${creator ? firstName(creator.name) + " wants to find a time: " : ""}${C.fullTitle(poll)}`,
    description: "Pick the dates that work for you.", url: shareUrl } });
}

/* ------------------------------------------------------------------ stop -- */
function stopPage(person) {
  const off = !!person.opted_out_at;
  return page("Squad Up", `
<h1>${off ? "Messages are off" : "Stop all messages?"}</h1>
${sub(off ? "You won't get any texts or emails from Squad Up. You can still use your page."
          : "You won't get any more texts or emails from Squad Up, about anything. You can still use your page, and turn them back on any time.")}
<div class="row">
  <button class="${off ? "go" : "danger"}" id="flip">${off ? "Turn messages back on" : "Stop all messages"}</button>
  <a class="pill quiet" href="/squadup/p/${esc(person.personal_token)}">Go to my page</a>
</div>
<div class="err" id="msg"></div>`, POST + `
document.getElementById("flip").onclick=async function(){
  try{ await post("/squadup/api/stop",{token:${JSON.stringify(person.personal_token)}, off:${off ? "false" : "true"}});
    location.reload(); }catch(e){ show("msg",e.message); }
};`, { token: person.personal_token, me: person });
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
})();`, { token: person.personal_token, me: person });
}

const termsPage = () => page("Terms · Squad Up", `<div class="doc">${L.termsBody()}</div>`);
const privacyPage = () => page("Privacy · Squad Up", `<div class="doc">${L.privacyBody()}</div>`);

function simplePage(title, heading, body) {
  return page(title, `<h1>${esc(heading)}</h1><p class="muted" style="margin-top:8px">${esc(body)}</p>
    <div class="row"><a class="pill" href="/squadup">Start over</a></div>`);
}

module.exports = { assets, page, esc, accountPage, membersPage, avatar, gatePage, guestHomePage, logoutPage, personPage, activityPage, newPage, pastPage,
                   startPage, findPage, pollPage, pollEditPage, termsPage, privacyPage,
                   replyPage, stopPage, simplePage };
