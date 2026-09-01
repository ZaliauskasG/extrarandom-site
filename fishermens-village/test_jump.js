const SIM = require('./sim.js');
const fail = [];

function freshWorld(){
  const W = SIM.newWorld(777);
  W.gin.stun = 0; W.emily.stun = 0;
  W.gin.jumpY = 0; W.gin.jumpVel = 0;
  return W;
}
function tickFor(W, ms, dt){
  dt = dt || 16;
  let left = ms;
  while(left > 0){ SIM.step(W, Math.min(dt, left)); left -= dt; }
}

console.log('=== basic jump arc ===');
{
  const W = freshWorld();
  W.gin.in.jEdge = true;
  SIM.step(W, 16);
  console.log('jumpVel right after press:', W.gin.jumpVel);
  if(W.gin.jumpVel <= 0) fail.push('jump did not impart upward velocity');

  let peak = 0, peakT = 0, t = 0;
  while(t < 1000){
    SIM.step(W, 8);
    t += 8;
    if(W.gin.jumpY > peak){ peak = W.gin.jumpY; peakT = t; }
    if(W.gin.jumpY <= 0 && t > 100) break;
  }
  console.log(`peak height: ${peak.toFixed(0)}px at t=${peakT}ms, landed by t=${t}ms`);
  if(peak < 70 || peak > 130) fail.push('jump peak height outside the intended ~90-110px range: ' + peak.toFixed(0));
  if(W.gin.jumpY !== 0) fail.push('gin did not return to jumpY=0 on landing');
  if(W.gin.jumpVel !== 0) fail.push('jumpVel was not reset to 0 on landing');
}

console.log('\n=== cannot double-jump mid-air ===');
{
  const W = freshWorld();
  W.gin.in.jEdge = true;
  SIM.step(W, 16);
  const v1 = W.gin.jumpVel;
  W.gin.in.jEdge = true;         // try again while still airborne
  SIM.step(W, 16);
  console.log('jumpVel unaffected by a second press mid-air:', W.gin.jumpVel < v1);
  if(!(W.gin.jumpVel < v1)) fail.push('a second jump press while airborne added extra height');
}

console.log('\n=== only Gin can jump ===');
{
  const W = freshWorld();
  W.emily.in.jEdge = true;
  SIM.step(W, 16);
  console.log('emily jumpVel:', W.emily.jumpVel);
  if(W.emily.jumpVel !== 0) fail.push('Emily was able to jump -- should be Gin-only');
}

console.log('\n=== stunned Gin cannot jump ===');
{
  const W = freshWorld();
  W.gin.stun = 500;
  W.gin.in.jEdge = true;
  SIM.step(W, 16);
  console.log('jumpVel while stunned:', W.gin.jumpVel);
  if(W.gin.jumpVel !== 0) fail.push('a stunned Gin was able to jump');
}

console.log('\n=== cannot shake a tree while airborne ===');
{
  const W = freshWorld();
  const t = W.trees[0]; t.water = true; t.cool = 0;
  W.gin.x = t.x;
  W.gin.in.jEdge = true;
  SIM.step(W, 16);
  console.log('jumpY after press:', W.gin.jumpY.toFixed(1));
  W.gin.in.aEdge = true;
  SIM.step(W, 16);
  console.log('shaking while airborne:', W.gin.shaking);
  if(W.gin.shaking > 0) fail.push('was able to start a shake while airborne');
}

console.log('\n=== a well-timed jump dodges an incoming can ===');
{
  const W = freshWorld();
  W.gin.x = 800; W.emily.x = 800 - 150;
  W.emily.facing = 1;
  W.shots.push({ x: W.emily.x, y: SIM.C.GROUND-62, vx: SIM.C.THROW_SPEED, vy: -46, spin:0 });
  W.gin.in.jEdge = true;
  SIM.step(W, 16);              // jump starts the same instant the can is thrown
  tickFor(W, 620, 8);           // long enough for the can to actually arrive (~455ms) and pass
  // note: a successful hit on Gin increments EMILY's score (she landed it),
  // not Gin's -- registerHit(target) credits the OTHER player
  console.log('emily hits (her score, from landing a hit on gin) after the can\'s full flight:', W.emily.hits);
  if(W.emily.hits > 0) fail.push('a well-timed jump did not dodge the can');
}

console.log('\n=== standing still, the SAME throw connects (sanity check the test itself) ===');
{
  const W = freshWorld();
  W.gin.x = 800; W.emily.x = 800 - 150;
  W.emily.facing = 1;
  W.shots.push({ x: W.emily.x, y: SIM.C.GROUND-62, vx: SIM.C.THROW_SPEED, vy: -46, spin:0 });
  tickFor(W, 620, 8);
  console.log('emily hits when gin stands still:', W.emily.hits);
  if(W.emily.hits < 1) fail.push('the baseline (no jump) throw did not connect -- test setup is wrong, not the jump');
}

console.log('\n=== bot Gin uses jump defensively ===');
{
  const W = freshWorld();
  W.gin.x = 900; W.emily.x = 900 - 100;
  W.shots.push({ x: W.emily.x, y: SIM.C.GROUND-62, vx: SIM.C.THROW_SPEED, vy: -46, spin:0 });
  let jumped = false;
  for(let i=0;i<10 && !jumped;i++){
    SIM.botThink(W, 'gin', 16);
    if(W.gin.in.jEdge) jumped = true;
    SIM.step(W, 16);
  }
  console.log('bot Gin triggered a defensive jump:', jumped);
  if(!jumped) fail.push('bot Gin never used jump against an incoming can in range');
}

console.log('\n=== wire format round-trips jumpY ===');
{
  const W = freshWorld();
  W.gin.jumpY = 42.3; W.gin.jumpVel = 200;
  const enc = SIM.encode(W);
  const W2 = SIM.newWorld(1);
  SIM.apply(W2, enc);
  console.log('encoded jumpY:', enc.g[9], '| applied jumpY:', W2.gin.jumpY);
  if(W2.gin.jumpY !== 42) fail.push('jumpY did not survive the encode/apply round-trip');
}

console.log('\n' + (fail.length ? 'FAILURES:\n - '+fail.join('\n - ') : 'ALL JUMP MECHANIC CHECKS PASSED'));
process.exit(fail.length ? 1 : 0);
