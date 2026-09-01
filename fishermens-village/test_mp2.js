/* Plays an actual round to completion over the wire: Emily hunts cans and
   throws them at a stationary Gin until someone wins, then both rematch. */
const { spawn } = require("child_process");
const WebSocket = require("ws");
const SIM = require("./sim.js");
const wait = ms => new Promise(r => setTimeout(r, ms));
const fail = [];
const PORT = 3566;

const srv = spawn("node", ["server/index.js"],
  { env: { ...process.env, PORT: String(PORT) }, cwd: __dirname });

function client(){
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const c = { ws, msgs:[], role:null, code:null, last:null, over:undefined, started:false };
  ws.on("message", raw=>{
    const m = JSON.parse(raw);
    if(m.t === "s"){ c.last = m.d; return; }
    c.msgs.push(m);
    if(m.t === "joined"){ c.role = m.role; c.code = m.code; }
    if(m.t === "start"){ c.started = true; c.seed = m.seed; c.over = undefined; }
    if(m.t === "over"){ c.over = m.winner; }
  });
  c.send = o => { if(ws.readyState===1) ws.send(JSON.stringify(o)); };
  c.ready = new Promise(r=>ws.on("open", r));
  return c;
}

(async ()=>{
  await wait(900);
  const G = client(); await G.ready; G.send({t:"join", role:"gin"});
  await wait(250);
  const E = client(); await E.ready; E.send({t:"join", role:"emily", code:G.code});
  await wait(500);
  if(!G.started || !E.started){ console.log("could not start a round"); srv.kill(); process.exit(1); }

  // rebuild the park locally from the shared seed so the test can see where
  // the cans are -- exactly what the real client does
  const world = SIM.newWorld(E.seed);
  const canHomes = world.cans.map(c=>c.home);
  console.log("round started, seed", E.seed, "| cans in the park:", canHomes.length);

  const gx = () => E.last ? E.last.g[0] : 0;
  const ex = () => E.last ? E.last.e[0] : 0;
  const holding = () => E.last ? !!E.last.e[5] : false;
  const score = () => E.last ? [E.last.g[6], E.last.e[6]] : [0,0];
  const goneFlags = () => E.last ? E.last.cn : [];

  async function walkTo(target, budgetMs){
    const t0 = Date.now();
    while(Date.now() - t0 < budgetMs){
      const d = target - ex();
      if(Math.abs(d) < 18) break;
      E.send({t:"i", l: d < 0, r: d > 0});
      await wait(60);
    }
    E.send({t:"i", l:false, r:false});
  }

  console.log("\nEmily plays for real; Gin stands still.");
  const t0 = Date.now();
  let throws = 0;
  while(E.over === undefined && Date.now() - t0 < 75000){
    if(!holding()){
      // nearest can that's still on the ground
      let best = null, bd = 1e9;
      goneFlags().forEach((alive,i)=>{
        if(!alive) return;
        const d = Math.abs(canHomes[i] - ex());
        if(d < bd){ bd = d; best = canHomes[i]; }
      });
      if(best === null){ await wait(300); continue; }
      await walkTo(best, 9000);
      await wait(150);
    } else {
      // get inside throwing range of Gin, face him, let go
      const want = gx() - 110;
      await walkTo(want, 9000);
      const face = gx() > ex();
      E.send({t:"i", l: !face, r: face});
      await wait(90);
      E.send({t:"i", l:false, r:false, a:1});
      throws++;
      await wait(900);
    }
  }

  const [ginHits, emilyHits] = score();
  console.log(`\nthrows: ${throws} | final score  gin ${ginHits} - emily ${emilyHits}`);
  console.log("server declared a winner:", E.over, "| both clients agree:", G.over === E.over);
  if(E.over === undefined) fail.push("no winner after 75s of real play");
  if(E.over !== undefined && G.over !== E.over) fail.push("clients disagree about who won");
  if(E.over === "emily" && emilyHits < SIM.C.HITS_TO_WIN) fail.push("declared a winner below the hit threshold");

  console.log("\n=== rematch ===");
  G.send({t:"rematch"});
  await wait(300);
  const waitMsg = G.msgs.filter(m=>m.t==="rematchWait").length;
  console.log("one side asked, server told them to wait:", waitMsg > 0);
  if(waitMsg === 0) fail.push("a one-sided rematch did not produce a wait notice");

  const startsBefore = G.msgs.filter(m=>m.t==="start").length;
  E.send({t:"rematch"});
  await wait(600);
  const startsAfter = G.msgs.filter(m=>m.t==="start").length;
  console.log("both asked -> new round started:", startsAfter > startsBefore);
  if(startsAfter <= startsBefore) fail.push("both sides asking for a rematch did not restart the round");
  console.log("scores reset:", score());
  if(score()[0] !== 0 || score()[1] !== 0) fail.push("rematch did not reset the score");

  console.log("\n" + (fail.length ? "FAILURES:\n - "+fail.join("\n - ")
                                  : "FULL MATCH + REMATCH PASSED"));
  srv.kill(); process.exit(0);
})().catch(e=>{ console.error("crashed:", e); srv.kill(); process.exit(1); });
