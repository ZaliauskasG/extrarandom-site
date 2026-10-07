/* SQUAD UP — one stylesheet, inlined into every page.
   Glossy white bubbles on a pale pinstripe, in the spirit of the Wii Shop
   Channel. Color comes from the category: anything with style="--h:…;--l:…"
   takes that hue (see lib/colors.js). Without one, it falls back to the
   app's own cyan. */
module.exports = `
:root{
  --h:198; --l:46%;                 /* default hue: Wii cyan */
  --ink:#465161; --soft:#8792A2; --faint:#B7C0CC;
  --line:#DCE3EB; --white:#fff;
  --stripe-a:#F6F8FA; --stripe-b:#EEF2F6;
  --r-bubble:26px; --r-field:16px;
}
*{box-sizing:border-box;}
html,body{margin:0;padding:0;}
html{min-height:100%;background:repeating-linear-gradient(180deg,var(--stripe-a) 0 3px,var(--stripe-b) 3px 6px);}
body{
  color:var(--ink);
  font:500 16px/1.5 "M PLUS Rounded 1c","Nunito",ui-rounded,system-ui,-apple-system,sans-serif;
  -webkit-font-smoothing:antialiased;
  padding:0 0 80px;
}
.wrap{max-width:580px;margin:0 auto;padding:0 16px;}
h1,h2,h3{font-weight:800;letter-spacing:-.01em;margin:0;color:#3B4553;}
h1{font-size:30px;line-height:1.15;}
h2{font-size:19px;margin:38px 0 14px;color:#5B6676;}
h3{font-size:18px;line-height:1.25;}
p{margin:0 0 12px;}
a{color:hsl(var(--h) 75% 36%);}
.muted{color:var(--soft);}
.small{font-size:14px;}

/* ---- top bar: a white shelf with a soft lip ---- */
header.top{
  background:linear-gradient(180deg,#fff 0%,#fff 70%,#F3F6F9 100%);
  border-bottom:1px solid #E3E8EE;
  box-shadow:0 4px 14px -8px rgba(70,90,120,.35);
  margin-bottom:26px;
}
header.top .wrap{padding-top:14px;padding-bottom:14px;
  display:flex;align-items:center;justify-content:space-between;gap:12px;}
.homebtn{flex:none;}
.inline{display:flex;gap:8px;align-items:center;}
.inline input{flex:1;min-width:0;margin:0;}
.brand{display:inline-flex;align-items:center;gap:10px;text-decoration:none;
  font-weight:800;font-size:22px;color:#3B4553;letter-spacing:-.01em;}
.logo{display:inline-flex;}
.logo i{
  width:18px;height:18px;border-radius:50%;margin-left:-6px;display:block;
  background:radial-gradient(circle at 35% 30%,hsl(var(--h) 90% 82%) 0 18%,hsl(var(--h) 80% 55%) 55%,hsl(var(--h) 75% 42%) 100%);
  box-shadow:0 1px 2px rgba(0,0,0,.18),0 0 0 2px #fff;
}
.logo i:first-child{margin-left:0;}

.title-row{display:flex;gap:14px;align-items:center;}
.title-row .orb{width:64px;height:64px;}
.head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;}

/* ---- bubbles ---- */
.bubble{
  position:relative;display:block;text-decoration:none;color:inherit;
  background:linear-gradient(180deg,#fff 0%,#fff 58%,hsl(var(--h) 85% 97%) 100%);
  border:2px solid hsl(var(--h) 65% 88%);
  border-radius:var(--r-bubble);
  box-shadow:0 10px 22px -12px hsl(var(--h) 60% 35% / .45),
             0 2px 0 hsl(var(--h) 60% 92%),
             inset 0 2px 0 #fff;
  padding:16px 18px;margin:0 0 14px;
}
a.bubble{transition:transform .12s ease,box-shadow .12s ease;}
a.bubble:hover{transform:translateY(-2px);
  box-shadow:0 14px 26px -12px hsl(var(--h) 60% 35% / .55),0 2px 0 hsl(var(--h) 60% 90%),inset 0 2px 0 #fff;}
a.bubble:active{transform:translateY(0);}
.bubble.plain{border-color:#E2E7EE;background:linear-gradient(180deg,#fff 0%,#fff 60%,#F3F6FA 100%);
  box-shadow:0 10px 22px -12px rgba(60,80,110,.4),0 2px 0 #E8EDF3,inset 0 2px 0 #fff;}
.bubble.off{filter:grayscale(1);opacity:.6;}
.bubble.off h3{text-decoration:line-through;}

/* a plan or idea: badge on the left, words on the right */
.row-card{display:flex;gap:14px;align-items:center;}
.row-card .body{flex:1;min-width:0;}
.row-card h3{overflow-wrap:anywhere;
  /* long "Thing at Place" titles get cut to two lines on cards */
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
a.row-card{text-decoration:none;color:inherit;}
.at{font-weight:700;color:var(--soft);}
h1 .at{font-weight:800;}
.sub{margin:-8px 0 14px;font-size:14px;line-height:1.45;color:var(--soft);}
.sub b{color:#5B6676;}
h1 + .sub,.head + .sub{margin:10px 0 18px;}
.row-card.off{filter:grayscale(1);opacity:.6;}
.row-card.off h3{text-decoration:line-through;}
.bubble.saved{border-color:#BFE6CD;--h:140;color:#2E7D4F;font-weight:700;}
.people{display:flex;flex-wrap:wrap;gap:8px;}
.person{display:inline-block;padding:7px 13px;border-radius:999px;font-size:14px;font-weight:700;
  background:#fff;border:2px solid #E2E7EE;color:#5B6676;}
.person.in{border-color:#BFE6CD;color:#2E7D4F;background:#F3FBF6;}
.person.out{color:#9AA4B2;text-decoration:line-through;}
.newperson{margin-top:16px;padding-top:14px;border-top:2px dashed #E2E7EE;}
button.danger:not(.quiet){color:#fff;background:linear-gradient(180deg,#F07267,#D6453A);border-color:#C23A30;}
.pill.quiet{background:transparent;border-color:transparent;box-shadow:none;color:var(--soft);}

/* the badge: a glossy orb in the category color. Filled = has a date;
   hollow = an idea with no date yet. */
.orb{
  position:relative;flex:none;width:60px;height:60px;border-radius:50%;
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  color:#fff;text-shadow:0 1px 1px hsl(var(--h) 70% 25% / .55);
  background:linear-gradient(180deg,hsl(var(--h) 85% calc(var(--l) + 16%)) 0%,
                                     hsl(var(--h) 80% var(--l)) 55%,
                                     hsl(var(--h) 80% calc(var(--l) - 8%)) 100%);
  box-shadow:0 6px 12px -5px hsl(var(--h) 70% 30% / .6),inset 0 -3px 6px hsl(var(--h) 80% 25% / .25);
  overflow:hidden;
}
.orb::before{                     /* the gloss */
  content:"";position:absolute;left:12%;right:12%;top:5%;height:46%;border-radius:50%;
  background:linear-gradient(180deg,rgba(255,255,255,.75),rgba(255,255,255,.08));
}
.orb b{position:relative;font-size:22px;line-height:1;font-weight:800;}
.orb span{position:relative;font-size:12px;line-height:1.2;font-weight:700;opacity:.95;}
.orb.hollow{
  background:#fff;color:hsl(var(--h) 75% 38%);text-shadow:none;
  border:3px solid hsl(var(--h) 70% 72%);
  box-shadow:0 6px 12px -7px hsl(var(--h) 70% 30% / .45),inset 0 -3px 0 hsl(var(--h) 80% 95%);
}
.orb.hollow::before{background:linear-gradient(180deg,hsl(var(--h) 90% 96%),rgba(255,255,255,0));}

.meta{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;margin-top:4px;
  font-size:14px;color:var(--soft);}
.tag{
  display:inline-block;font-size:12.5px;font-weight:700;line-height:1;
  padding:5px 10px;border-radius:999px;
  color:hsl(var(--h) 75% 34%);background:hsl(var(--h) 90% 94%);
  border:1px solid hsl(var(--h) 70% 85%);
}
.tag.solid{color:#fff;border:0;text-shadow:0 1px 1px hsl(var(--h) 70% 22% / .45);
  background:linear-gradient(180deg,hsl(var(--h) 85% calc(var(--l) + 14%)),hsl(var(--h) 80% var(--l)));}
.flag{color:#fff;background:linear-gradient(180deg,#7D8899,#5B6676);border:0;
  text-shadow:0 1px 0 rgba(0,0,0,.15);}
.who{font-size:14px;color:var(--ink);margin-top:6px;overflow-wrap:anywhere;}
.who .n{font-weight:800;color:hsl(var(--h) 75% 36%);}

/* ---- buttons: glossy pills ---- */
button,.pill{
  -webkit-appearance:none;appearance:none;cursor:pointer;
  font:700 15px/1 "M PLUS Rounded 1c","Nunito",ui-rounded,system-ui,sans-serif;
  display:inline-flex;align-items:center;justify-content:center;gap:6px;
  min-height:42px;padding:0 20px;border-radius:999px;text-decoration:none;
  color:hsl(var(--h) 75% 36%);
  background:linear-gradient(180deg,#fff 0%,#fff 50%,#EEF2F6 100%);
  border:2px solid #D5DDE7;
  box-shadow:0 3px 0 #D5DDE7,0 6px 12px -6px rgba(70,90,120,.35);
  transition:transform .08s ease,box-shadow .08s ease;
}
button:active,.pill:active{transform:translateY(2px);box-shadow:0 1px 0 #D5DDE7;}
button.go,.pill.go,button.on{
  color:#fff;text-shadow:0 1px 1px hsl(var(--h) 70% 22% / .5);
  border-color:hsl(var(--h) 75% calc(var(--l) - 6%));
  background:linear-gradient(180deg,hsl(var(--h) 90% calc(var(--l) + 22%)) 0%,
                                     hsl(var(--h) 82% calc(var(--l) + 6%)) 48%,
                                     hsl(var(--h) 82% var(--l)) 52%,
                                     hsl(var(--h) 80% calc(var(--l) - 4%)) 100%);
  box-shadow:0 3px 0 hsl(var(--h) 75% calc(var(--l) - 14%)),
             0 8px 14px -6px hsl(var(--h) 70% 30% / .55),
             inset 0 1px 0 rgba(255,255,255,.6);
}
button.go:active,.pill.go:active,button.on:active{box-shadow:0 1px 0 hsl(var(--h) 75% calc(var(--l) - 14%));}
button.quiet{background:transparent;border-color:transparent;box-shadow:none;color:var(--soft);padding:0 10px;}
button.quiet:hover{color:var(--ink);}
button.danger{color:#D6453A;}
button:disabled{opacity:.5;cursor:default;transform:none;}
button.sm,.pill.sm{min-height:36px;padding:0 15px;font-size:14px;}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:14px 0 0;}
.row.tight{margin-top:10px;}

/* ---- fields ---- */
label{display:block;font-size:14px;font-weight:700;color:#6A7584;margin:14px 0 6px;}
label:first-child{margin-top:0;}
#bkwrap > label:first-child{margin-top:14px;}
label .muted{font-weight:500;}
input,select,textarea{
  font:500 16px "M PLUS Rounded 1c","Nunito",ui-rounded,system-ui,sans-serif;  /* 16px: iOS zooms below it */
  width:100%;color:var(--ink);background:#fff;
  border:2px solid var(--line);border-radius:var(--r-field);padding:11px 14px;
  box-shadow:inset 0 2px 3px rgba(70,90,120,.08);
}
input::placeholder{color:var(--faint);}
select{appearance:none;-webkit-appearance:none;
  background:#fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%238792A2' stroke-width='2' fill='none' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 16px center;}
input:focus,select:focus,textarea:focus{outline:none;border-color:hsl(var(--h) 75% 62%);
  box-shadow:0 0 0 4px hsl(var(--h) 90% 88%);}
button:focus-visible,.pill:focus-visible,a.bubble:focus-visible,.chip:focus-visible{
  outline:3px solid hsl(var(--h) 80% 60%);outline-offset:3px;}

/* ---- category chips: tap to follow ---- */
.chips{display:flex;gap:8px;flex-wrap:wrap;}
.chip{
  min-height:38px;padding:0 15px 0 11px;font-size:14px;gap:8px;
  color:var(--ink);
}
.chip::before{content:"";width:12px;height:12px;border-radius:50%;
  background:hsl(var(--h) 80% calc(var(--l) + 8%));box-shadow:inset 0 -2px 2px rgba(0,0,0,.15);}
.chip.on::before{background:#fff;box-shadow:none;}

/* ---- times on a plan ---- */
.opt{padding:14px 16px 16px;}
.track{height:8px;border-radius:999px;margin-top:10px;overflow:hidden;
  background:hsl(var(--h) 60% 93%);box-shadow:inset 0 1px 2px hsl(var(--h) 50% 40% / .15);}
.track .bar{height:100%;border-radius:999px;min-width:0;
  background:linear-gradient(180deg,hsl(var(--h) 90% calc(var(--l) + 20%)),hsl(var(--h) 80% var(--l)));
  transition:width .3s ease;}
.opt.plan{border-color:hsl(var(--h) 75% 70%);
  background:linear-gradient(180deg,hsl(var(--h) 95% 97%) 0%,#fff 60%,hsl(var(--h) 85% 95%) 100%);}
.opt.pending{border-style:dashed;}
.when{font-size:18px;font-weight:800;color:#3B4553;}
.opt .top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;}
.count{font-size:14px;font-weight:800;color:hsl(var(--h) 75% 36%);white-space:nowrap;}

.callout{border-color:hsl(var(--h) 75% 70%);}
.notice{border-color:#F2B8B2;--h:4;}

.err{color:#D6453A;font-size:14px;font-weight:700;margin:10px 0 0;min-height:1px;}
.ok{color:#2E9C5A;font-size:14px;font-weight:700;margin:10px 0 0;}
code.link{display:block;background:#fff;border:2px dashed var(--line);border-radius:var(--r-field);
  padding:12px 14px;font:500 13px ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;color:var(--soft);}
.empty{color:var(--soft);margin:0;}
.hidden{display:none;}
.bubble:target{border-color:hsl(var(--h) 80% 60%);box-shadow:0 0 0 5px hsl(var(--h) 90% 88%);}
@media (max-width:420px){ h1{font-size:26px;} .orb{width:54px;height:54px;} .orb b{font-size:20px;} }
@media (prefers-reduced-motion:reduce){*{transition:none!important;}}
`;
