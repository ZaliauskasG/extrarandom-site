const {JSDOM} = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('index.html','utf8');
const wait = ms => new Promise(r=>setTimeout(r,ms));
const fail = [];

const drawnKeys = [];
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
    Object.defineProperty(w,'innerWidth',{value:960,configurable:true});
    Object.defineProperty(w,'innerHeight',{value:460,configurable:true});
  }
});
const w=dom.window, d=w.document, E=s=>w.eval(s);
const pd = el => el.dispatchEvent(new w.Event('pointerdown',{bubbles:true}));

setTimeout(async ()=>{
  console.log('=== jump sprites exist and loaded ===');
  const jumpKeys = ['gin_jump_asc','gin_jump_mid','gin_jump_peak','gin_jump_desc','gin_jump_land'];
  jumpKeys.forEach(k=>{
    const ok = E(`!!IMG[${JSON.stringify(k)}] && IMG[${JSON.stringify(k)}].width > 0`);
    console.log(k+':', ok);
    if(!ok) fail.push(k+' did not load');
  });

  console.log('\n=== full jump arc drives through the expected pose sequence ===');
  pd(d.getElementById('btnSolo'));
  await wait(60); E('finishCut()'); await wait(80);
  E('humanRole="gin"; mode="play"; W.gin.stun=0; W.gin.x=500;');

  // instrument jumpPoseKey by wrapping it to record every non-null result
  E(`
    window.__seen = [];
    const _orig = jumpPoseKey;
    jumpPoseKey = function(p){ const r = _orig(p); if(r) window.__seen.push(r); return r; };
  `);

  E('W.gin.in.jEdge = true;');
  // step through the whole ~700ms arc in small increments, rendering each time
  for(let i=0;i<60;i++){
    E('SIM.step(W, 12); render();');
    await wait(1);
  }
  const seen = E('window.__seen');
  const uniqueInOrder = [...new Set(seen)];
  console.log('poses seen, in order of first appearance:', uniqueInOrder);

  const expectedOrder = ['gin_jump_asc','gin_jump_mid','gin_jump_peak','gin_jump_desc','gin_jump_land'];
  let idx = -1;
  let inOrder = true;
  for(const pose of expectedOrder){
    const at = uniqueInOrder.indexOf(pose);
    if(at === -1){ inOrder = false; break; }
    if(at < idx){ inOrder = false; break; }
    idx = at;
  }
  console.log('all 5 poses appeared, in the right relative order:', inOrder);
  if(!inOrder) fail.push('jump poses did not appear in the expected asc->mid->peak->desc->land order');

  console.log('\n=== landing pose is brief, not stuck ===');
  // keep stepping+rendering (in simulated time, same as real gameplay would)
  // well past landing, so the 160ms land timer has a chance to naturally
  // expire through the same code path that decrements it
  for(let i=0;i<30;i++){ E('SIM.step(W, 12); render();'); await wait(1); }
  const afterLandKey = E('jumpPoseKey(W.gin)');
  console.log('jumpPoseKey(gin) well after landing (should be null):', afterLandKey);
  if(afterLandKey !== null) fail.push('expected null (fall through to normal idle/walk) once grounded, got: '+afterLandKey);

  console.log('\n=== jumping while shaking-eligible does not show the shake pose ===');
  E('W.trees.forEach(t=>{t.water=true;t.cool=0;}); W.gin.x=W.trees[0].x; W.gin.shaking=0;');
  E('window.__seen = [];');
  E('W.gin.in.jEdge = true;');
  E('SIM.step(W, 12); render();');
  const midJumpKey = E('window.__seen[window.__seen.length-1]');
  console.log('sprite while airborne near a tree:', midJumpKey);
  if(!midJumpKey || !midJumpKey.startsWith('gin_jump')) fail.push('jump pose was not shown even though airborne');

  console.log('\n'+(fail.length ? 'FAILURES:\n - '+fail.join('\n - ') : 'JUMP ANIMATION CHECKS PASSED'));
  process.exit(0);
}, 500);
