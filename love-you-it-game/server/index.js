/* =====================================================================
   WE LOVE YOU, I.T. — multiplayer server
   MILESTONE 1: the building, movement, collision, floors, presence.
   The server owns all positions; clients only send a direction.
   ===================================================================== */

const { Schema, MapSchema, defineTypes } = require("@colyseus/schema");
const { Room, Server } = require("colyseus");
const { WebSocketTransport } = require("@colyseus/ws-transport");
const express = require("express");
const path = require("path");
const { G_DN, G_UP } = require("./mapdata.js");

/* ---------------- world ---------------- */
const TILE = 22;
const GW = 64, GH = 50;
const SPEED = 8.2;              // tiles per second
const RADIUS = 0.32;            // player collision radius, in tiles
const MAX_ACTIVE = 8;
const MAX_IN_ROOM = 16;         // extras become spectators
const TICK_HZ = 30;
const RECONNECT_GRACE = 90;     // seconds a dropped player keeps their seat

function gridFromRows(rows) {
  return rows.map(r => Array.from(r, c => (c === "#" ? 1 : 0)));
}
function blankGrid() {
  return Array.from({ length: GH }, () => new Array(GW).fill(1));
}
function carve(g, x, y, w, h) {
  for (let j = y; j < y + h; j++)
    for (let i = x; i < x + w; i++)
      if (g[j] && g[j][i] !== undefined) g[j][i] = 0;
}
// the yard: stops a few tiles past the outdoor work so nobody laps the building
function buildExt() {
  const g = blankGrid();
  carve(g, 4, 4, 33, 10);
  carve(g, 4, 4, 13, 41);
  carve(g, 4, 36, 29, 9);
  return g;
}

const LEVELS = {
  DN:  { id: "DN",  name: "FIRST FLOOR",  grid: gridFromRows(G_DN) },
  UP:  { id: "UP",  name: "SECOND FLOOR", grid: gridFromRows(G_UP) },
  EXT: { id: "EXT", name: "OUTSIDE",      grid: buildExt() },
};

const TRANSITIONS = [
  { level:"DN", x:8,  y:8,  to:"UP",  tx:8,  ty:8,  label:"STAIR A", kind:"stair" },
  { level:"UP", x:8,  y:8,  to:"DN",  tx:8,  ty:8,  label:"STAIR A", kind:"stair" },
  { level:"DN", x:51, y:8,  to:"UP",  tx:48, ty:8,  label:"STAIR B", kind:"stair" },
  { level:"UP", x:48, y:8,  to:"DN",  tx:51, ty:8,  label:"STAIR B", kind:"stair" },
  { level:"DN", x:2,  y:7,  to:"EXT", tx:12, ty:20, label:"EXIT DOOR", kind:"door" },
  { level:"EXT",x:10, y:20, to:"DN",  tx:5,  ty:7,  label:"ENTRANCE",  kind:"door" },
];

// room labels are display-only; the client draws them
const LABELS = {
  DN: [["LOBBY",19,8],["IT HQ",30,8],["CYBER OPS",40,5],["CTQP CUBE",10,20],
       ["PRINT ROOM",10,26],["JOHN CUBE",21,24],["MECHANICAL",30,18],["BATH",40,20],
       ["BATH",40,28],["TRUCK GARAGE",52,18],["CAMERA SYSTEM",52,26],
       ["DAVE'S OFFICE",11,41],["CSS",26,41],["HR",39,41],["GARAGE",53,41],
       ["STAIRS",8,10],["STAIRS",52,10]],
  UP: [["GIN'S OFFICE",20,8],["OPEN DESKS",31,5],["PE OFFICE",39,8],["SUPPLY",56,5],
       ["AC / MECH",21,21],["BATH",30,19],["BATH",30,27],["KITCHEN",42,24],
       ["BLUEBEAM DESK",54,18],["CONFERENCE",30,36],["STAIRS",9,10],["STAIRS",48,10]],
  EXT:[["THE YARD",10,30]],
};

/* ---------------- characters ----------------
   Ryan and Juan are IT only. Gin swings: IT once the roster reaches 6,
   Employee below that. Everyone else is Employee only.                */
const CHARACTERS = [
  { id:"ryan",   name:"Ryan",   team:"it"   },
  { id:"juan",   name:"Juan",   team:"it"   },
  { id:"gin",    name:"Gin",    team:"flex" },
  { id:"jason",  name:"Jason",  team:"emp"  },
  { id:"raif",   name:"Raif",   team:"emp"  },
  { id:"thomas", name:"Thomas", team:"emp"  },
  { id:"andy",   name:"Andy",   team:"emp"  },
  { id:"ben",    name:"Ben",    team:"emp"  },
];

// total active players -> [IT, Employees]
const SPLITS = { 2:[1,1], 3:[1,2], 4:[2,2], 5:[2,3], 6:[3,3], 7:[3,4], 8:[3,5] };
function splitFor(total) {
  if (total < 2) return [0, 0];
  return SPLITS[Math.min(8, total)] || [3, 5];
}
function ginTeamFor(total) { return splitFor(total)[0] >= 3 ? "it" : "emp"; }

/* ---------------- state ---------------- */
class Player extends Schema {}
defineTypes(Player, {
  charId: "string",
  name: "string",
  team: "string",      // "it" | "emp" | "" (spectator)
  level: "string",
  x: "number",
  y: "number",
  facing: "number",
  moving: "boolean",
  spectator: "boolean",
  connected: "boolean",
  ready: "boolean",
});

class GameState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
  }
}
defineTypes(GameState, {
  players: { map: Player },
  phase: "string",     // milestone 1 stays in "lobby"
});

/* ---------------- collision ---------------- */
function solid(level, tx, ty) {
  const g = LEVELS[level].grid;
  if (ty < 0 || ty >= GH || tx < 0 || tx >= GW) return true;
  return g[ty][tx] === 1;
}
function canWalk(level, x, y) {
  const r = RADIUS;
  for (const [ox, oy] of [[-r,-r],[r,-r],[-r,r],[r,r]]) {
    if (solid(level, Math.floor(x + ox), Math.floor(y + oy))) return false;
  }
  return true;
}
// walk outward from an anchor until we find standable tiles
function spawnSpots(level, ax, ay, n) {
  const out = [], seen = new Set([ay * GW + ax]), q = [[ax, ay]];
  while (q.length && out.length < n) {
    const [x, y] = q.shift();
    if (!solid(level, x, y)) out.push([x, y]);
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx, ny = y + dy, k = ny * GW + nx;
      if (nx < 0 || ny < 0 || nx >= GW || ny >= GH || seen.has(k)) continue;
      seen.add(k); q.push([nx, ny]);
    }
  }
  while (out.length < n) out.push(out[0] || [ax, ay]);
  return out;
}

/* ---------------- room ---------------- */
class OfficeRoom extends Room {
  onCreate() {
    this.setState(new GameState());
    this.state.phase = "lobby";
    this.maxClients = MAX_IN_ROOM;
    this.inputs = new Map();

    this.onMessage("move", (client, dir) => {
      const inp = this.inputs.get(client.sessionId);
      if (!inp) return;
      const x = Number(dir && dir.x), y = Number(dir && dir.y);
      inp.dx = Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0;
      inp.dy = Number.isFinite(y) ? Math.max(-1, Math.min(1, y)) : 0;
    });

    // pick / swap character (lobby only in this milestone)
    this.onMessage("pick", (client, charId) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const c = CHARACTERS.find(c => c.id === charId);
      if (!c) return;
      // taken by someone else?
      let taken = false;
      this.state.players.forEach((q, id) => {
        if (id !== client.sessionId && q.charId === charId) taken = true;
      });
      if (taken) return;
      p.charId = c.id;
      p.name = c.name;
      p.spectator = false;
      this.assignTeams();
      this.placeAtSpawn(p);
    });

    this.onMessage("ready", (client, val) => {
      const p = this.state.players.get(client.sessionId);
      if (p) p.ready = !!val;
    });

    this.setSimulationInterval(ms => this.tick(ms / 1000), 1000 / TICK_HZ);
  }

  activePlayers() {
    const list = [];
    this.state.players.forEach((p, id) => { if (!p.spectator && p.charId) list.push([id, p]); });
    return list;
  }

  /* Ryan/Juan are always IT. Gin follows the roster size. Everyone else
     is an employee. Because character identity determines the team, the
     split table is satisfied automatically.                            */
  assignTeams() {
    const active = this.activePlayers();
    const total = active.length;
    const ginTeam = ginTeamFor(total);
    for (const [, p] of active) {
      const c = CHARACTERS.find(c => c.id === p.charId);
      if (!c) continue;
      p.team = c.team === "flex" ? ginTeam : c.team;
    }
  }

  placeAtSpawn(p) {
    const anchor = p.team === "it" ? ["DN", 30, 8] : ["UP", 20, 8];
    const used = [];
    this.state.players.forEach(q => { if (q !== p) used.push(q.x + "," + q.y + q.level); });
    const spots = spawnSpots(anchor[0], anchor[1], anchor[2], 8);
    for (const [sx, sy] of spots) {
      const key = (sx + 0.5) + "," + (sy + 0.5) + anchor[0];
      if (!used.includes(key)) {
        p.level = anchor[0]; p.x = sx + 0.5; p.y = sy + 0.5;
        return;
      }
    }
    p.level = anchor[0]; p.x = spots[0][0] + 0.5; p.y = spots[0][1] + 0.5;
  }

  onJoin(client, options) {
    const p = new Player();
    p.charId = ""; p.name = "";
    p.team = ""; p.level = "DN";
    p.x = 30.5; p.y = 8.5;
    p.facing = 1; p.moving = false;
    p.ready = false; p.connected = true;
    // beyond the active cap you watch until a slot frees up
    p.spectator = this.activePlayers().length >= MAX_ACTIVE;

    this.state.players.set(client.sessionId, p);
    this.inputs.set(client.sessionId, { dx: 0, dy: 0, transCd: 0 });
    console.log(`client ${client.sessionId.slice(0,6)} joined (${this.state.players.size} in room)`);
  }

  async onLeave(client, consented) {
    console.log("onLeave consented=", consented);
    const p = this.state.players.get(client.sessionId);
    if (!p) return;
    p.connected = false;               // body goes idle, stays in the world
    p.ready = false;

    // NB: Colyseus passes the WebSocket close CODE here, not a boolean.
    // 1000 = clean, deliberate leave. 1001/1005/1006 = the connection
    // dropped (tab closed, network died) -- those should hold the seat.
    var deliberate = (consented === true) || (consented === 1000);
    if (deliberate) return this.removePlayer(client.sessionId);
    try {
      // hold their seat; they rejoin straight back into this character
      await this.allowReconnection(client, RECONNECT_GRACE);
      p.connected = true;
      console.log(`${p.name || client.sessionId.slice(0,6)} reconnected`);
    } catch (e) {
        this.removePlayer(client.sessionId);
    }
  }

  removePlayer(id) {
    const p = this.state.players.get(id);
    this.state.players.delete(id);
    this.inputs.delete(id);
    this.assignTeams();
    // promote a waiting spectator into the free slot
    if (this.activePlayers().length < MAX_ACTIVE) {
      this.state.players.forEach(q => {
        if (q.spectator && q.charId) q.spectator = false;
      });
    }
    if (p) console.log(`${p.name || id.slice(0,6)} left (${this.state.players.size} in room)`);
  }

  tick(dt) {
    for (const [id, inp] of this.inputs) {
      const p = this.state.players.get(id);
      if (!p) continue;
      if (inp.transCd > 0) inp.transCd -= dt;

      let dx = inp.dx, dy = inp.dy;
      const mag = Math.hypot(dx, dy);
      p.moving = mag > 0.01;
      if (!p.moving) continue;
      dx /= mag; dy /= mag;
      if (Math.abs(dx) > 0.15) p.facing = dx > 0 ? 1 : -1;

      const step = SPEED * dt;
      const nx = p.x + dx * step, ny = p.y + dy * step;

      // spectators drift through walls with a free camera
      if (p.spectator) {
        p.x = Math.max(0, Math.min(GW, nx));
        p.y = Math.max(0, Math.min(GH, ny));
        continue;
      }
      // slide along walls rather than sticking to them
      if (canWalk(p.level, nx, p.y)) p.x = nx;
      if (canWalk(p.level, p.x, ny)) p.y = ny;

      if (inp.transCd <= 0) {
        for (const t of TRANSITIONS) {
          if (t.level !== p.level) continue;
          if (Math.hypot(p.x - (t.x + 0.5), p.y - (t.y + 0.5)) < 0.8) {
            p.level = t.to; p.x = t.tx + 0.5; p.y = t.ty + 0.5;
            inp.transCd = 1.1;          // stops instant up/down flicker
            break;
          }
        }
      }
    }
  }
}

/* ---------------- server ---------------- */
const gameServer = new Server({
  transport: new WebSocketTransport(),
  express: (app) => {
    app.get("/mapdata", (_req, res) => {
      res.json({
        TILE, GW, GH,
        levels: Object.fromEntries(Object.entries(LEVELS).map(([k, v]) => [k, { name: v.name, grid: v.grid }])),
        transitions: TRANSITIONS,
        labels: LABELS,
        characters: CHARACTERS,
      });
    });
    app.use(express.static(path.join(__dirname, "..", "client")));
  },
});
gameServer.define("wlyit", OfficeRoom);

const PORT = process.env.PORT || 2567;
gameServer.listen(PORT).then(() => {
  console.log(`WE LOVE YOU I.T. (multiplayer) listening on http://localhost:${PORT}`);
});

module.exports = { LEVELS, TRANSITIONS, canWalk, solid, spawnSpots, splitFor, ginTeamFor, CHARACTERS, GW, GH };
