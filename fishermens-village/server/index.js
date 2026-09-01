/* ============================================================================
   FISHERMAN'S VILLAGE — game server
   Authoritative: clients send button states, the server runs the simulation
   and broadcasts snapshots. Also serves the client itself, so one Render
   web service covers everything.
   ========================================================================== */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const SIM = require("../sim.js");

const PORT = process.env.PORT || 3000;
const TICK = 1000 / 60;      // simulation step
const SEND = 1000 / 20;      // snapshot broadcast
const ROOM_IDLE_MS = 10 * 60 * 1000;

/* ---------- static client ---------- */
const CLIENT = path.join(__dirname, "..", "index.html");
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }
  fs.readFile(CLIENT, (err, buf) => {
    if (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      return res.end("client build missing — run: npm run build");
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(buf);
  });
});

/* ---------- rooms ---------- */
const rooms = new Map();

function code() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}
function makeRoom(id) {
  const r = {
    id, players: {},            // role -> ws
    W: null, loop: null, sendAcc: 0, last: 0,
    touched: Date.now()
  };
  rooms.set(id, r);
  return r;
}
function roomCount(r) { return Object.keys(r.players).length; }

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* socket died mid-send */ }
  }
}
function broadcast(r, obj) {
  Object.values(r.players).forEach(ws => send(ws, obj));
}

function startRound(r) {
  r.started = true;
  r.W = SIM.newWorld(Math.floor(Math.random() * 1e9));
  r.last = Date.now();
  r.sendAcc = 0;
  broadcast(r, { t: "start", seed: r.W.seed });
  if (!r.loop) r.loop = setInterval(() => tick(r), TICK);
}

function tick(r) {
  const now = Date.now();
  const dt = Math.min(64, now - r.last);
  r.last = now;
  if (!r.W) return;

  SIM.step(r.W, dt);

  r.sendAcc += dt;
  if (r.sendAcc >= SEND) {
    r.sendAcc = 0;
    broadcast(r, { t: "s", d: SIM.encode(r.W) });
  }
  if (r.W.over) {
    // flush one last snapshot first -- otherwise the winning hit can land
    // between broadcasts and clients finish showing a stale score
    broadcast(r, { t: "s", d: SIM.encode(r.W) });
    broadcast(r, { t: "over", winner: r.W.winner });
    clearInterval(r.loop); r.loop = null;
  }
  if (now - r.touched > ROOM_IDLE_MS) closeRoom(r, "idle");
}

function closeRoom(r, why) {
  if (r.loop) clearInterval(r.loop);
  broadcast(r, { t: "bye", why });
  Object.values(r.players).forEach(ws => { try { ws.close(); } catch (e) {} });
  rooms.delete(r.id);
}

/* ---------- sockets ---------- */
const wss = new WebSocketServer({ server });

wss.on("connection", ws => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", raw => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }

    if (m.t === "join") {
      let r;
      if (m.code) {
        // joining a friend's room by code
        r = rooms.get(String(m.code).toUpperCase());
        if (!r) return send(ws, { t: "err", msg: "No game with that code." });
        if (r.dead) return send(ws, { t: "err", msg: "That game has ended." });
        if (roomCount(r) >= 2) return send(ws, { t: "err", msg: "That game is full." });
      } else {
        // hosting: always a fresh private room, so nobody can take the slot
        // you just read the code out for
        let id;
        do { id = code(); } while (rooms.has(id));
        r = makeRoom(id);
      }

      const wanted = m.role === "emily" ? "emily" : "gin";
      const role = r.players[wanted] ? (wanted === "gin" ? "emily" : "gin") : wanted;
      if (r.players[role]) return send(ws, { t: "err", msg: "That game is full." });

      r.players[role] = ws;
      r.touched = Date.now();
      ws.room = r; ws.role = role;

      send(ws, { t: "joined", role, code: r.id, waiting: roomCount(r) < 2 });
      if (roomCount(r) === 2) startRound(r);
      else broadcast(r, { t: "waiting", code: r.id });
      return;
    }

    const r = ws.room;
    if (!r) return;
    r.touched = Date.now();

    if (m.t === "i" && r.W) {
      const p = r.W[ws.role];
      if (!p) return;
      p.in.l = !!m.l;
      p.in.r = !!m.r;
      if (m.a) p.in.aEdge = true;   // consumed by the next step
      if (m.j) p.in.jEdge = true;
      return;
    }
    if (m.t === "rematch") {
      ws.wantsRematch = true;
      const all = Object.values(r.players);
      if (all.length === 2 && all.every(s => s.wantsRematch)) {
        all.forEach(s => s.wantsRematch = false);
        startRound(r);
      } else {
        broadcast(r, { t: "rematchWait", who: ws.role });
      }
    }
  });

  ws.on("close", () => {
    const r = ws.room;
    if (!r) return;
    delete r.players[ws.role];
    if (roomCount(r) === 0) {
      if (r.loop) clearInterval(r.loop);
      rooms.delete(r.id);
      return;
    }
    if (r.started) {
      // a round was underway -- the room is finished, not reusable
      if (r.loop) { clearInterval(r.loop); r.loop = null; }
      r.W = null; r.dead = true;
      broadcast(r, { t: "left" });
    } else {
      // still in the lobby; the host can keep waiting for someone else
      broadcast(r, { t: "waiting", code: r.id });
    }
  });
});

// drop sockets that stopped answering, so rooms don't wedge
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 30000);

server.listen(PORT, () => console.log("Fisherman's Village listening on " + PORT));
