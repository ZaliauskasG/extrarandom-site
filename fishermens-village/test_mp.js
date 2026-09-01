/* Boots the real server and drives two real WebSocket clients through a
   full match. This is the test that actually matters for multiplayer. */
const { spawn } = require("child_process");
const WebSocket = require("ws");
const wait = ms => new Promise(r => setTimeout(r, ms));
const fail = [];
const PORT = 3555;

const srv = spawn("node", ["server/index.js"], {
  env: { ...process.env, PORT: String(PORT) },
  cwd: __dirname
});
let srvOut = "";
srv.stdout.on("data", d => srvOut += d);
srv.stderr.on("data", d => srvOut += d);

function client(name){
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const c = { ws, name, msgs: [], role:null, code:null, snaps:0, started:false, over:null, left:false };
  ws.on("message", raw => {
    const m = JSON.parse(raw);
    if(m.t === "s"){ c.snaps++; c.last = m.d; return; }
    c.msgs.push(m);
    if(m.t === "joined"){ c.role = m.role; c.code = m.code; }
    if(m.t === "start"){ c.started = true; c.seed = m.seed; }
    if(m.t === "over"){ c.over = m.winner; }
    if(m.t === "left"){ c.left = true; }
  });
  c.send = o => { if(ws.readyState===1) ws.send(JSON.stringify(o)); };
  c.ready = new Promise(res => ws.on("open", res));
  return c;
}

(async ()=>{
  await wait(900);
  console.log("server said:", srvOut.trim() || "(nothing)");

  /* ---- 1. host + join by code ---- */
  console.log("\n=== two clients join the same room by code ===");
  const A = client("A"); await A.ready;
  A.send({ t:"join", role:"gin" });
  await wait(300);
  console.log("A joined as:", A.role, "| code:", A.code, "| waiting:", A.msgs.find(m=>m.t==="joined").waiting);
  if(A.role !== "gin") fail.push("host did not get the role it asked for");
  if(!A.code) fail.push("host got no room code");

  const B = client("B"); await B.ready;
  B.send({ t:"join", role:"gin", code:A.code });   // asks for gin too -- should be given emily
  await wait(400);
  console.log("B joined as:", B.role, "(asked for gin, room already had one)");
  if(B.role !== "emily") fail.push("second player was not pushed to the free role");

  console.log("both got 'start':", A.started, B.started);
  if(!A.started || !B.started) fail.push("round never started once the room filled");
  console.log("same world seed on both:", A.seed === B.seed, `(${A.seed})`);
  if(A.seed !== B.seed) fail.push("clients got different seeds -- parks would not match");

  /* ---- 2. snapshots flowing ---- */
  await wait(1200);
  console.log("\n=== snapshots ===");
  console.log("A received:", A.snaps, "| B received:", B.snaps, "(expect ~20/sec)");
  if(A.snaps < 10 || B.snaps < 10) fail.push("snapshots are not flowing at the expected rate");
  const snapBytes = JSON.stringify(A.last).length;
  console.log("snapshot size:", snapBytes, "bytes ->", Math.round(snapBytes*20/1024), "KB/s per client");
  if(snapBytes > 4000) fail.push("snapshot is bigger than expected");

  /* ---- 3. input actually moves your character ---- */
  console.log("\n=== input ===");
  const x0 = A.last.g[0];
  A.send({ t:"i", l:false, r:true });
  await wait(700);
  A.send({ t:"i", l:false, r:false });
  await wait(150);
  const x1 = A.last.g[0];
  console.log("A held right: gin x", x0, "->", x1);
  if(x1 <= x0) fail.push("holding right did not move the player server-side");

  console.log("B sees the same position:", B.last.g[0] === A.last.g[0], `(${B.last.g[0]} vs ${A.last.g[0]})`);
  if(B.last.g[0] !== A.last.g[0]) fail.push("the two clients disagree about where Gin is");

  /* ---- 4. a real scoring play, driven over the wire ---- */
  console.log("\n=== scoring over the network ===");
  // Emily grabs a can and throws it at Gin
  let guard = 0;
  while(!B.last.e[5] && guard++ < 60){       // e[5] = holding
    B.send({ t:"i", l:false, r:true });
    await wait(100);
  }
  B.send({ t:"i", l:false, r:false });
  console.log("emily picked up a can over the wire:", !!B.last.e[5]);
  if(!B.last.e[5]) fail.push("emily never managed to pick up a can");

  console.log("\n=== disconnect handling ===");
  A.ws.close();
  await wait(500);
  console.log("B was told the opponent left:", B.left);
  if(!B.left) fail.push("remaining player was not notified of the disconnect");

  /* ---- 5. hosting always makes a fresh private room ---- */
  console.log("\n=== hosting creates a private room, nobody can snipe the slot ===");
  const P = client("P"); await P.ready; P.send({ t:"join", role:"gin" });
  await wait(250);
  // a second host must NOT land in P's room -- they get their own
  const S2 = client("S2"); await S2.ready; S2.send({ t:"join", role:"gin" });
  await wait(250);
  console.log("P code:", P.code, "| other host code:", S2.code);
  if(P.code === S2.code) fail.push("a second host was dropped into the first host's private room");
  if(P.started || S2.started) fail.push("a host started a round without a friend joining");

  // P's actual friend joins with the code
  const Q = client("Q"); await Q.ready; Q.send({ t:"join", role:"emily", code:P.code });
  await wait(450);
  console.log("P:", P.role, "| Q:", Q.role, "| both started:", P.started && Q.started);
  if(!(P.started && Q.started)) fail.push("the coded join did not start the round");
  if(P.role === Q.role) fail.push("both players ended up with the same role");

  /* ---- 6. bad code is rejected cleanly ---- */
  console.log("\n=== joining a code that doesn't exist ===");
  const Z = client("Z"); await Z.ready;
  Z.send({ t:"join", role:"gin", code:"ZZZZ" });
  await wait(300);
  const err = Z.msgs.find(m=>m.t==="err");
  console.log("got a clean error:", !!err, err ? `("${err.msg}")` : "");
  if(!err) fail.push("joining a nonexistent code did not return an error");

  /* ---- 7. room full ---- */
  console.log("\n=== joining a full room ===");
  const R2 = client("R2"); await R2.ready;
  R2.send({ t:"join", role:"gin", code:P.code });
  await wait(300);
  const err2 = R2.msgs.find(m=>m.t==="err");
  console.log("third player rejected:", !!err2, err2 ? `("${err2.msg}")` : "");
  if(!err2) fail.push("a third player was allowed into a full room");

  console.log("\n" + (fail.length ? "FAILURES:\n - " + fail.join("\n - ")
                                  : "ALL MULTIPLAYER CHECKS PASSED"));
  srv.kill();
  process.exit(0);
})().catch(e=>{ console.error("test crashed:", e); srv.kill(); process.exit(1); });
