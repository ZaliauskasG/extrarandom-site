const { spawn } = require("child_process");
const WebSocket = require("ws");
const wait = ms => new Promise(r => setTimeout(r, ms));
const fail = [];
const PORT = 3577;

const srv = spawn("node", ["server/index.js"],
  { env: { ...process.env, PORT: String(PORT) }, cwd: __dirname });

function client(){
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const c = { ws, role:null, code:null, last:null, started:false };
  ws.on("message", raw=>{
    const m = JSON.parse(raw);
    if(m.t === "s"){ c.last = m.d; return; }
    if(m.t === "joined"){ c.role = m.role; c.code = m.code; }
    if(m.t === "start"){ c.started = true; }
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
  if(!G.started || !E.started){ console.log("round did not start"); srv.kill(); process.exit(1); }

  console.log("=== jump input travels over the wire ===");
  const jumpYBefore = G.last.g[9];
  console.log("jumpY (index 9 in the wire array) before:", jumpYBefore);
  if(jumpYBefore !== 0) fail.push("expected to start grounded");

  G.send({ t:"i", l:false, r:false, j:1 });
  await wait(120);   // let a few snapshots land

  let sawAirborne = false, peak = 0;
  const t0 = Date.now();
  while(Date.now() - t0 < 500){
    if(G.last.g[9] > 0){ sawAirborne = true; peak = Math.max(peak, G.last.g[9]); }
    await wait(20);
  }
  console.log("client observed gin airborne over the network:", sawAirborne, "| peak seen:", peak);
  if(!sawAirborne) fail.push("jump input over the socket never produced airborne snapshots");
  if(peak < 60) fail.push("observed jump height over the network looked too low: " + peak);

  console.log("both clients agree on gin's jump height:", G.last.g[9] === E.last.g[9]);
  if(G.last.g[9] !== E.last.g[9]) fail.push("the two clients disagree about gin's jump height");

  await wait(700);
  console.log("gin landed again:", G.last.g[9] === 0);
  if(G.last.g[9] !== 0) fail.push("gin never returned to grounded after the jump completed");

  console.log("\n=== emily cannot jump over the wire ===");
  E.send({ t:"i", l:false, r:false, j:1 });
  await wait(150);
  console.log("emily jumpY after trying:", E.last.e[9]);
  if(E.last.e[9] !== 0) fail.push("emily was able to jump via the network protocol");

  console.log("\n" + (fail.length ? "FAILURES:\n - "+fail.join("\n - ") : "NETWORKED JUMP CHECKS PASSED"));
  srv.kill(); process.exit(fail.length ? 1 : 0);
})().catch(e=>{ console.error("crashed:", e); srv.kill(); process.exit(1); });
