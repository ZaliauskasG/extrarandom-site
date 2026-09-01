const {JSDOM} = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('index.html','utf8');
const wait = ms => new Promise(r=>setTimeout(r,ms));
const fail = [];

const dom = new JSDOM(html, {
  runScripts:'dangerously', pretendToBeVisual:true, url:'https://x.test/',
  beforeParse(w){
    const noop=()=>{};
    const ctxStub = new Proxy({measureText:()=>({width:40})},
      {get:(t,k)=> (k in t? t[k] : noop), set:()=>true});
    w.HTMLCanvasElement.prototype.getContext = ()=>ctxStub;
    class FakeImage{ constructor(){this.width=64;this.height=104;}
      set src(v){ setTimeout(()=>this.onload&&this.onload(),0); } get src(){return '';} }
    w.Image = FakeImage;
    w.WebSocket = function(){ throw new Error('single player must not open a socket'); };
    Object.defineProperty(w,'innerWidth',{value:960,configurable:true});
    Object.defineProperty(w,'innerHeight',{value:460,configurable:true});
  }
});
const w=dom.window, d=w.document, E=s=>w.eval(s);
const pd = el => el.dispatchEvent(new w.Event('pointerdown',{bubbles:true}));

setTimeout(async ()=>{
  console.log('=== boot ===');
  console.log('sprites:', E('Object.keys(IMG).length'), '| SIM present:', E('typeof SIM.step === "function"'));
  if(E('Object.keys(IMG).length') !== 36) fail.push('expected 36 sprites (31 original + 5 jump frames)');
  if(!E('typeof SIM.step === "function"')) fail.push('shared sim did not load in the browser build');

  console.log('\n=== single player start (must not touch the network) ===');
  pd(d.getElementById('btnSolo'));
  await wait(60);
  console.log('mode:', E('mode'), '| isMulti:', E('isMulti'));
  if(E('mode') !== 'cut') fail.push('single player did not enter the cutscene');
  if(E('isMulti')) fail.push('single player incorrectly flagged as multiplayer');
  E('finishCut()'); await wait(80);
  console.log('mode after cutscene:', E('mode'), '| trees:', E('W.trees.length'));
  if(E('mode') !== 'play') fail.push('did not reach play');

  console.log('\n=== movement ===');
  const x0 = E('W.gin.x');
  E('held.right = true'); await wait(320); E('held.right = false');
  const x1 = E('W.gin.x');
  console.log('gin x:', x0.toFixed(0), '->', x1.toFixed(0));
  if(x1 <= x0) fail.push('player did not move');

  console.log('\n=== shake soaks Emily under the tree ===');
  E('const _b = SIM.botThink; window._b=_b; SIM.botThink = function(){};');  // freeze bot
  E('humanRole="gin"; W.gin.hits=0; W.emily.hits=0; W.over=false; mode="play";');
  E('const t=W.trees[0]; t.water=true; t.cool=0; W.gin.x=t.x-20; W.emily.x=t.x+10; W.emily.stun=0;');
  E('W.emily.in.l=false; W.emily.in.r=false; W.emily.in.aEdge=false;');  // stop her drifting once the bot is frozen
  E('SIM.doAction(W, W.gin)');
  console.log('shake started:', E('W.gin.shaking') > 0);
  if(!(E('W.gin.shaking')>0)) fail.push('shake did not start in range of a loaded tree');
  await wait(1300);
  console.log('gin hits:', E('W.gin.hits'), '| tree dry:', E('W.trees[0].water')===false);
  if(E('W.gin.hits') < 1) fail.push('water landing on Emily did not score');

  console.log('\n=== emily picks up and throws ===');
  E('W.trees.forEach(t=>{t.water=true;t.cool=0;});');
  E('humanRole="emily"; W.gin.hits=0; W.emily.hits=0; W.emily.stun=0; W.gin.stun=0; W.shots=[];');
  E('W.emily.holding=false; W.cans.forEach(c=>{c.gone=false;c.x=c.home;}); W.emily.x=W.cans[0].x;');
  await wait(150);
  console.log('picked up:', E('W.emily.holding'));
  if(!E('W.emily.holding')) fail.push('did not pick up a can');
  E('W.gin.x = W.emily.x + 120; W.emily.facing = 1;');
  E('SIM.doAction(W, W.emily)');
  await wait(700);
  console.log('emily hits:', E('W.emily.hits'));
  if(E('W.emily.hits') < 1) fail.push('thrown can did not connect');

  console.log('\n=== win + game over screen ===');
  // clean slate: bot frozen, both actors' stale inputs cleared, only one
  // loaded tree so there's no ambiguity about which one gets shaken
  E('SIM.botThink = function(){};');
  E('humanRole="gin"; mode="play"; W.over=false; W.winner=null;');
  E('W.gin.hits = SIM.C.HITS_TO_WIN - 1; W.emily.hits=0; W.emily.stun=0; W.gin.stun=0;');
  E('W.gin.in.l=W.gin.in.r=false; W.emily.in.l=W.emily.in.r=false;');
  E('W.trees.forEach((t,i)=>{ t.water=(i===1); t.cool=(i===1?0:9000); });');
  E('W.gin.x=W.trees[1].x; W.emily.x=W.trees[1].x;');
  E('SIM.doAction(W, W.gin)');
  await wait(1400);
  console.log('over:', E('W.over'), '| winner:', E('W.winner'), '| mode:', E('mode'));
  if(!E('W.over')) fail.push('round did not end at the hit threshold');
  if(d.getElementById('scOver').classList.contains('hidden')) fail.push('game over screen never showed');

  console.log('\n=== Will still shows up ===');
  E('SIM.botThink = window._b;');
  pd(d.getElementById('btnAgain')); await wait(80);
  E('W.willTimer = 1;');
  await wait(300);
  console.log('will active:', !!E('W.will'), '| line:', E('W.will ? SIM.WILL_LINES[W.will.lineIdx] : null'));
  if(!E('W.will')) fail.push('Will never spawned');

  console.log('\n=== lobby screens wire up ===');
  E('toTitle()'); await wait(50);
  pd(d.getElementById('btnQuick')); await wait(50);
  console.log('lobby visible:', !d.getElementById('scLobby').classList.contains('hidden'));
  if(d.getElementById('scLobby').classList.contains('hidden')) fail.push('lobby screen did not open');
  d.getElementById('joinCode').value = 'AB';
  pd(d.getElementById('btnJoin')); await wait(50);
  console.log('short code rejected:', d.getElementById('lobbyErr').textContent);
  if(!d.getElementById('lobbyErr').textContent) fail.push('short code was not rejected before dialling out');

  console.log('\n'+(fail.length ? 'FAILURES:\n - '+fail.join('\n - ') : 'SINGLE PLAYER + UI CHECKS PASSED'));
  process.exit(0);
}, 500);
