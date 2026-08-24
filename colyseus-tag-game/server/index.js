/* =====================================================================
   TAG — authoritative game server
   The server owns everything: positions, collisions, who is "it", and
   how long each player has been "it". Clients only send intent.
   ===================================================================== */

const { Schema, MapSchema, ArraySchema, defineTypes } = require("@colyseus/schema");
const { Room, Server } = require("colyseus");
const { WebSocketTransport } = require("@colyseus/ws-transport");
const express = require("express");
const path = require("path");

/* ---------------- tuning ---------------- */
const ARENA = 900;          // square field, world units
const PLAYER_R = 18;
const SPEED = 260;          // units per second
const TAG_IMMUNITY = 2.0;   // seconds the new "it" cannot tag back
const MAX_PLAYERS = 8;
const TICK_HZ = 30;

// Muted, low-saturation palette -- deliberately close in tone so the
// red "it" ring is the only thing that pops.
const COLORS = [
  "#7E96A8", // dusty blue
  "#8FA292", // sage
  "#C08B7A", // clay
  "#A08CA8", // mauve
  "#C4B48F", // sand
  "#8B8D99", // slate
  "#99A177", // olive
  "#C49BA0", // rose
];

/* ---------------- obstacles ----------------
   Fixed layout, symmetric enough to feel fair from any spawn. Circles
   are pillars; rects are walls. Both are solid.                        */
const OBSTACLES = [
  { type: "circle", x: 450, y: 450, r: 62 },   // centre pillar
  { type: "circle", x: 205, y: 205, r: 40 },
  { type: "circle", x: 695, y: 205, r: 40 },
  { type: "circle", x: 205, y: 695, r: 40 },
  { type: "circle", x: 695, y: 695, r: 40 },
  { type: "rect", x: 405, y: 120, w: 90, h: 26 },   // top
  { type: "rect", x: 405, y: 754, w: 90, h: 26 },   // bottom
  { type: "rect", x: 120, y: 405, w: 26, h: 90 },   // left
  { type: "rect", x: 754, y: 405, w: 26, h: 90 },   // right
];

/* ---------------- state ---------------- */
class Player extends Schema {}
defineTypes(Player, {
  name: "string",
  x: "number",
  y: "number",
  color: "string",
  isIt: "boolean",
  immunity: "number", // seconds remaining before this player can tag
  itTime: "number",   // total seconds spent being "it"
});

class TagState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
  }
}
defineTypes(TagState, { players: { map: Player } });

/* ---------------- geometry helpers ---------------- */
function resolveObstacles(p) {
  for (const o of OBSTACLES) {
    if (o.type === "circle") {
      const dx = p.x - o.x, dy = p.y - o.y;
      const d = Math.hypot(dx, dy);
      const min = o.r + PLAYER_R;
      if (d < min && d > 0.0001) {
        p.x = o.x + (dx / d) * min;
        p.y = o.y + (dy / d) * min;
      } else if (d <= 0.0001) {
        p.x = o.x + min; // dead centre: shove out along +x
      }
    } else {
      // closest point on the rect to the player, then push out radially
      const hw = o.w / 2, hh = o.h / 2;
      const cx = Math.max(o.x - hw, Math.min(p.x, o.x + hw));
      const cy = Math.max(o.y - hh, Math.min(p.y, o.y + hh));
      const dx = p.x - cx, dy = p.y - cy;
      const d = Math.hypot(dx, dy);
      if (d < PLAYER_R) {
        if (d > 0.0001) {
          p.x = cx + (dx / d) * PLAYER_R;
          p.y = cy + (dy / d) * PLAYER_R;
        } else {
          // centre is inside the rect: eject along the shallowest axis
          const left = Math.abs(p.x - (o.x - hw)), right = Math.abs(o.x + hw - p.x);
          const top = Math.abs(p.y - (o.y - hh)), bot = Math.abs(o.y + hh - p.y);
          const m = Math.min(left, right, top, bot);
          if (m === left) p.x = o.x - hw - PLAYER_R;
          else if (m === right) p.x = o.x + hw + PLAYER_R;
          else if (m === top) p.y = o.y - hh - PLAYER_R;
          else p.y = o.y + hh + PLAYER_R;
        }
      }
    }
  }
  p.x = Math.max(PLAYER_R, Math.min(ARENA - PLAYER_R, p.x));
  p.y = Math.max(PLAYER_R, Math.min(ARENA - PLAYER_R, p.y));
}

function isFreeSpot(x, y) {
  for (const o of OBSTACLES) {
    if (o.type === "circle") {
      if (Math.hypot(x - o.x, y - o.y) < o.r + PLAYER_R * 2) return false;
    } else {
      const hw = o.w / 2 + PLAYER_R * 2, hh = o.h / 2 + PLAYER_R * 2;
      if (Math.abs(x - o.x) < hw && Math.abs(y - o.y) < hh) return false;
    }
  }
  return true;
}

// Spread spawns around a ring, skipping anything blocked.
function spawnPoint(seat) {
  for (let attempt = 0; attempt < 24; attempt++) {
    const angle = (seat / MAX_PLAYERS) * Math.PI * 2 + attempt * 0.26;
    const radius = 330 - (attempt % 3) * 55;
    const x = ARENA / 2 + Math.cos(angle) * radius;
    const y = ARENA / 2 + Math.sin(angle) * radius;
    if (x > PLAYER_R * 2 && x < ARENA - PLAYER_R * 2 &&
        y > PLAYER_R * 2 && y < ARENA - PLAYER_R * 2 && isFreeSpot(x, y)) {
      return { x, y };
    }
  }
  return { x: ARENA / 2, y: ARENA / 2 };
}

function cleanName(raw, fallback) {
  const s = String(raw == null ? "" : raw).replace(/[^\w \-']/g, "").trim().slice(0, 12);
  return s.length ? s : fallback;
}

/* ---------------- room ---------------- */
class TagRoom extends Room {
  onCreate() {
    this.setState(new TagState());
    this.maxClients = MAX_PLAYERS;
    this.inputs = new Map();
    this.freeSeats = Array.from({ length: MAX_PLAYERS }, (_, i) => i);

    // A held direction (keyboard / joystick).
    this.onMessage("move", (client, dir) => {
      const inp = this.inputs.get(client.sessionId);
      if (!inp) return;
      const x = Number(dir && dir.x), y = Number(dir && dir.y);
      inp.dx = Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0;
      inp.dy = Number.isFinite(y) ? Math.max(-1, Math.min(1, y)) : 0;
      if (inp.dx !== 0 || inp.dy !== 0) { inp.tx = null; inp.ty = null; }
    });

    // A tapped destination. Still an intent: the server clamps it and
    // walks there at normal speed, so this can't be used to teleport.
    this.onMessage("target", (client, pos) => {
      const inp = this.inputs.get(client.sessionId);
      if (!inp) return;
      const x = Number(pos && pos.x), y = Number(pos && pos.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      inp.tx = Math.max(PLAYER_R, Math.min(ARENA - PLAYER_R, x));
      inp.ty = Math.max(PLAYER_R, Math.min(ARENA - PLAYER_R, y));
      inp.dx = 0; inp.dy = 0;
    });

    this.setSimulationInterval((ms) => this.tick(ms / 1000), 1000 / TICK_HZ);
  }

  onJoin(client, options) {
    const seat = this.freeSeats.length ? this.freeSeats.shift() : 0;
    const p = new Player();
    const spot = spawnPoint(seat);
    p.name = cleanName(options && options.name, "Player " + (seat + 1));
    p.x = spot.x; p.y = spot.y;
    p.color = COLORS[seat % COLORS.length];
    p.isIt = false;
    p.immunity = 0;
    p.itTime = 0;

    this.state.players.set(client.sessionId, p);
    this.inputs.set(client.sessionId, { dx: 0, dy: 0, tx: null, ty: null, seat });

    // Nobody is "it" yet (first player in, or the previous "it" left):
    // this player takes it.
    let anyIt = false;
    this.state.players.forEach((q) => { if (q.isIt) anyIt = true; });
    if (!anyIt) { p.isIt = true; p.immunity = TAG_IMMUNITY; }

    console.log(`${p.name} joined (${this.state.players.size}/${MAX_PLAYERS})`);
  }

  onLeave(client) {
    const leaving = this.state.players.get(client.sessionId);
    const wasIt = !!(leaving && leaving.isIt);
    const inp = this.inputs.get(client.sessionId);
    if (inp) this.freeSeats.unshift(inp.seat);

    this.state.players.delete(client.sessionId);
    this.inputs.delete(client.sessionId);

    // "it" must never disappear with a disconnect -- hand it to whoever
    // has spent the least time as "it" so far (fairest choice).
    if (wasIt && this.state.players.size > 0) {
      let best = null;
      this.state.players.forEach((q) => {
        if (!best || q.itTime < best.itTime) best = q;
      });
      if (best) { best.isIt = true; best.immunity = TAG_IMMUNITY; }
    }
    if (leaving) console.log(`${leaving.name} left (${this.state.players.size}/${MAX_PLAYERS})`);
  }

  tick(dt) {
    // 1. movement
    for (const [id, inp] of this.inputs) {
      const p = this.state.players.get(id);
      if (!p) continue;

      let dx = inp.dx, dy = inp.dy;
      if (inp.tx !== null) {
        const ax = inp.tx - p.x, ay = inp.ty - p.y;
        const dist = Math.hypot(ax, ay);
        if (dist < 4) { inp.tx = null; inp.ty = null; dx = 0; dy = 0; }
        else { dx = ax / dist; dy = ay / dist; }
      }
      if (dx !== 0 || dy !== 0) {
        const m = Math.hypot(dx, dy) || 1;
        p.x += (dx / m) * SPEED * dt;
        p.y += (dy / m) * SPEED * dt;
      }
      resolveObstacles(p);
    }

    // 2. timers + who is "it"
    let it = null;
    this.state.players.forEach((p) => {
      if (p.immunity > 0) p.immunity = Math.max(0, p.immunity - dt);
      if (p.isIt) { p.itTime += dt; it = p; }
    });

    // 3. tag: a referee decision, made here and nowhere else
    if (it && it.immunity <= 0) {
      let tagged = null;
      this.state.players.forEach((q) => {
        if (tagged || q === it || q.isIt) return;
        if (Math.hypot(q.x - it.x, q.y - it.y) <= PLAYER_R * 2) tagged = q;
      });
      if (tagged) {
        it.isIt = false;
        tagged.isIt = true;
        tagged.immunity = TAG_IMMUNITY;
        console.log(`${it.name} tagged ${tagged.name}`);
      }
    }
  }
}

/* ---------------- server ---------------- */
const gameServer = new Server({
  transport: new WebSocketTransport(),
  express: (app) => {
    app.use(express.static(path.join(__dirname, "..", "client")));
  },
});
gameServer.define("tag", TagRoom);

const PORT = process.env.PORT || 2567;
gameServer.listen(PORT).then(() => {
  console.log(`TAG server listening on http://localhost:${PORT}`);
});

module.exports = { ARENA, PLAYER_R, OBSTACLES, resolveObstacles, isFreeSpot, spawnPoint, cleanName, COLORS };
