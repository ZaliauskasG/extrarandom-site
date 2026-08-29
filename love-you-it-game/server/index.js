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
const ROUND_SECONDS = Number(process.env.ROUND_SECONDS || 300);      // 5 minute shift
const START_COUNTDOWN = 3;      // so people can still un-ready
const TRANS_R = 1.6;   // stairs/doors trigger radius (was 0.8)

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
  carve(g, 2, 4, 15, 41);   // west strip widened for the cookout
  carve(g, 4, 36, 29, 9);
  return g;
}

/* Scenery. `solid:1` gets carved into the collision grid so players have
   to walk around it; everything else is decoration.
   w/h are in TILES (the client scales the art to fit).               */
const PROPS = [
  // ---- first floor ----
  { id:"ladder",  level:"DN", x:18, y:11, w:4.6, h:3.2, solid:1 },  // lobby
  { id:"shelf",   level:"DN", x:28, y:9, w:4.4, h:6.2, solid:1 },  // IT HQ
  { id:"chair",   level:"DN", x:33, y:27, w:2.3, h:3.6, solid:1 },           // mechanical
  { id:"bottles", level:"DN", x:10, y:37, w:3.1, h:3.3, solid:1 },           // Dave's office
  { id:"spider",  level:"DN", x:35, y:37, w:2.6, h:3.3, solid:1 },           // HR
  // ---- second floor ----
  { id:"recycle", level:"UP", x:15, y:15, w:2.3, h:3.1, solid:1 },           // near WINDOWS reno
  { id:"zzplant", level:"UP", x:18, y:29, w:2.3, h:3.3, solid:1 },           // near AC
  { id:"cooler",  level:"UP", x:47, y:20, w:1.6, h:3.8, solid:1 },           // outside Bluebeam
  { id:"binbox",  level:"UP", x:48, y:15, w:2.3, h:3.0, solid:1 },           // outside Bluebeam
  { id:"filter",  level:"UP", x:51, y:7,  w:2.6, h:3.6, solid:1 },  // supply / stairs
  { id:"table",   level:"UP", x:42, y:29, w:4.4, h:3.7, solid:1 },  // kitchen centre
  { id:"palm",    level:"UP", x:36, y:37, w:1.7, h:3.9, solid:1 },           // conference
  { id:"surfboard",level:"UP",x:55, y:36, w:5.0, h:1.5 },           // near DOORS reno
  // ---- the cookout, only visible once it happens ----
  { id:"truck",   level:"EXT", x:5, y:7, w:6.0, h:3.3, solid:1, cookout:1 },
  { id:"grill",   level:"EXT", x:10, y:15, w:1.9, h:2.9, cookout:1 },
];

const LEVELS = {
  DN:  { id: "DN",  name: "FIRST FLOOR",  grid: gridFromRows(G_DN) },
  UP:  { id: "UP",  name: "SECOND FLOOR", grid: gridFromRows(G_UP) },
  EXT: { id: "EXT", name: "OUTSIDE",      grid: buildExt() },
};

for (const pr of PROPS) {
  if (!pr.solid || pr.cookout) continue;
  const g = LEVELS[pr.level].grid;
  const x0 = Math.round(pr.x - pr.w / 2), x1 = Math.round(pr.x + pr.w / 2);
  const y0 = Math.round(pr.y - pr.h / 3), y1 = Math.round(pr.y + 1);
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++)
      if (g[y] && g[y][x] !== undefined) g[y][x] = 1;
}

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
const RENOS=[
  {id:'soffit',  n:'SOFFIT',  level:'EXT',x:30,y:8},
  {id:'roof',    n:'ROOF',    level:'EXT',x:10, y:25},
  {id:'siding',  n:'SIDING',  level:'EXT',x:26,y:40},
  {id:'windows', n:'WINDOWS', level:'UP', x:8, y:21},
  {id:'doors',   n:'DOORS',   level:'UP', x:52,y:39},
];
const STATIONS=[
  {id:'cyber',    n:'Cyber Attack',            level:'DN', x:40,y:8,  need:2, brk:6},
  {id:'printjam', n:'Print Jam',               level:'DN', x:10,y:29, need:2, brk:6},
  {id:'heater',   n:'Water Heater Leak',       level:'DN', x:30,y:21, need:2, brk:6.5},
  {id:'truck',    n:'Truck Service Overdue',   level:'DN', x:52,y:20, need:2, brk:7},
  {id:'cams',     n:'Cameras Offline',         level:'DN', x:52,y:28, need:2, brk:6.5, noPing:1},
  {id:'outlook',  n:'Outlook Crash',           level:'UP', x:31,y:8,  need:2, brk:6},
  {id:'toner',    n:'Toner Out',               level:'UP', x:56,y:8,  need:2, brk:6},
  {id:'ac',       n:'AC Not Working',          level:'UP', x:21,y:24, need:2, brk:7},
  {id:'bluebeam', n:'Bluebeam License Expired',level:'UP', x:54,y:23, need:2, brk:6},
  {id:'teams',    n:'Teams Meeting Issues',    level:'UP', x:30,y:39, need:2, brk:6},
  // Not a fault -- a party. Takes ~2.5x a normal job and drags the whole
  // office outside for ten seconds.
  {id:'cookout',  n:'Cookout with Vince',      level:'EXT',x:10, y:15, need:2, brk:15, special:'cookout'},
];
const JAIL={level:'UP', x:11, y:39};

/* dwell tuning, carried over from the single-player build */
const ACT_R      = 2.4;   // how close you must be to work a pad
const RENO_SOLO  = 1.0;   // progress per second, one IT
const RENO_PAIR  = 3.0;   // two IT together
const RENO_TRIO  = 4.2;   // three
const RENO_BASE  = 20;    // solo seconds at the widest team gap (3v5)
                          // -> 20s at diff 2, 30s at diff 1, 40s when even
const EMP_CD     = 8;     // seconds an employee lies low after a sabotage
const BLOCK_AT   = 3;     // this many faults open halts renovation
const CATCH_R    = 3.4;   // how close IT must be to grab someone
const CATCH_CD   = 1.2;   // cooldown on a catch attempt, hit or miss
const SAB_GRACE  = 2.0;   // stay catchable this long after stepping off
const JAIL_TIMES = [10, 20, -1];  // 3rd catch = written up by HR, out for good
const BAIL_DWELL = 2.5;   // teammate time to spring someone early
const TALK_R     = 4.0;   // small talk: how close IT must be to be cornered
const TALK_FREEZE= 2.0;
const TALK_CD    = 10;
const TALK_RENO_PAUSE = 4.0;
const COOKOUT_FREEZE  = 10;    // everyone stands around the grill this long
const COOKOUT_COOLDOWN= 75;    // before it can be thrown again
const BOUNCE_TIME     = 1.25;  // comedy launch before landing in jail   // renovation stalls this long if cornered mid-job
const PING_DUR   = 3.4;
const PING_CD    = 10;
const INPUT_STALE= 0.4;   // no input for this long -> assume "stopped"
const ISSUE_SLA  = 30;    // seconds a fault can sit before Schelle emails
const MAX_MAIL   = 3;     // three emails and IT's afternoon is gone
const FIX_TIME   = 3.0;   // seconds IT must stand on a fault to clear it

// renovation cost scales with how lopsided the teams are
function renoNeedFor(itCount, empCount) {
  const diff = empCount - itCount;
  const mult = diff >= 2 ? 1 : (diff === 1 ? 1.5 : 2);
  return Math.round(RENO_BASE * mult);
}

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
  spectator: "boolean",      // actually watching (chose to, or no slot)
  wantsSpectate: "boolean",  // deliberately opted out of playing
  connected: "boolean",
  ready: "boolean",
  cooldown: "number",   // employee: seconds until they can sabotage again
  vulnerable: "boolean",// mid-sabotage (or just stepped off) -- catchable
  jailT: "number",      // >0 serving, 0 free, -1 written up for good
  jailCount: "number",  // how many times caught this round
  catchCd: "number",
  frozenT: "number",    // stuck in conversation
  renoLockT: "number",  // can't renovate for a moment after being cornered
  bounceT: "number",    // >0 while doing the comedy launch off screen
  stCatches: "number",  // this round: catches made (IT)
  stRepairs: "number",  // faults cleared (IT)
  stReno: "number",     // seconds spent renovating (IT)
  stBreaks: "number",   // stations broken (employee)
  stSab: "number",      // seconds spent sabotaging (employee)
  stCaught: "number",   // times caught (employee)
  stJailT: "number",    // seconds served
  wins: "number",       // session totals, survive between rounds
  losses: "number",
  talkCd: "number",
  pingCd: "number",
  atPad: "string",      // id of the pad they're standing on, "" if none
  padKind: "string",    // "reno" | "station" | ""
});

class GameState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
    this.zones = new MapSchema();
    this.stations = new MapSchema();
  }
}
class Zone extends Schema {}
defineTypes(Zone, { id:"string", progress:"number", done:"boolean" });

class Station extends Schema {}
defineTypes(Station, {
  id:"string", progress:"number", broken:"boolean",
  sla:"number",      // seconds until this fault earns an email
  fixProg:"number",  // how far IT has got repairing it
});

defineTypes(GameState, {
  players: { map: Player },
  zones: { map: Zone },
  stations: { map: Station },
  renoNeed: "number",
  faults: "number",
  cookoutT: "number",    // >0 while the cookout is happening
  cookoutDone: "boolean",// truck + grill stay parked once it's happened
  cookoutCd: "number",
  needIt: "number",      // required team sizes for the current headcount
  needEmp: "number",
  writtenUp: "number",   // employees permanently out
  mail: "number",        // emails from Schelle so far
  maxMail: "number",
  pingUntil: "number",   // >0 while a camera sweep is live
  camsDown: "boolean",
  bailProg: "number",
  renoBlocked: "boolean",
  phase: "string",        // lobby | starting | playing | results
  clock: "number",        // seconds left in the round
  roundLen: "number",     // how long this round started as
  countdown: "number",    // seconds until a round starts
  resultReason: "string",
  winner: "string",
  roundNo: "number",
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
    this.state.clock = ROUND_SECONDS;
    this.state.roundLen = ROUND_SECONDS;
    this.state.countdown = 0;
    this.state.resultReason = "";
    this.state.roundNo = 0;
    this.maxClients = MAX_IN_ROOM;
    this.inputs = new Map();

    this.onMessage("move", (client, dir) => {
      const inp = this.inputs.get(client.sessionId);
      if (!inp) return;
      const x = Number(dir && dir.x), y = Number(dir && dir.y);
      inp.dx = Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0;
      inp.dy = Number.isFinite(y) ? Math.max(-1, Math.min(1, y)) : 0;
      inp.age = 0;   // heard from them just now
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
      if (this.state.phase !== "lobby") return;   // no swapping mid-round
      p.charId = c.id;
      p.name = c.name;
      p.wantsSpectate = false;
      // only becomes a player if there's an active slot free
      p.spectator = this.activePlayers().length >= MAX_ACTIVE;
      p.ready = false;
      this.assignTeams();
      this.placeAtSpawn(p);
    });

    // Sit this one out on purpose. Frees a slot and drops you out of
    // team balancing entirely.
    this.onMessage("spectate", (client) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      p.wantsSpectate = true;
      p.spectator = true;
      p.charId = ""; p.name = "";
      p.team = "";
      p.ready = false;
      this.assignTeams();
      this.promoteWaiting();
    });

    // spectator free-camera floor jump
    this.onMessage("specfloor", (client, lvl) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || (!p.spectator && p.jailT !== -1)) return;
      if (!LEVELS[lvl]) return;
      p.level = lvl;
      // drop them somewhere sensible on that floor
      const spot = spawnSpots(lvl, Math.floor(GW / 2), Math.floor(GH / 2), 1)[0];
      p.x = spot[0] + 0.5; p.y = spot[1] + 0.5;
    });

    this.onMessage("catch", (client) => this.tryCatch(client));

    // anyone can call the next day from the results screen
    this.onMessage("nextDay", (client) => {
      if (this.state.phase !== "results") return;
      const p = this.state.players.get(client.sessionId);
      this.broadcast("nextDay", { by: p ? p.name : "someone" });
      this.resetToLobby();
    });

    // employees: corner nearby IT in conversation
    this.onMessage("smalltalk", (client) => {
      const st = this.state;
      if (st.phase !== "playing") return;
      const p = st.players.get(client.sessionId);
      if (!p || p.team !== "emp" || p.spectator || p.jailT !== 0) return;
      if (p.talkCd > 0) { client.send("notice", `You have run out of small talk (${Math.ceil(p.talkCd)}s)`); return; }
      const hit = [];
      st.players.forEach(q => {
        if (q.team !== "it" || q.spectator || q.level !== p.level) return;
        if (Math.hypot(q.x - p.x, q.y - p.y) < TALK_R) hit.push(q);
      });
      if (!hit.length) { client.send("notice", "Nobody within earshot. Awkward."); return; }
      p.talkCd = TALK_CD;
      hit.forEach(q => {
        q.frozenT = TALK_FREEZE;
        // interrupting someone mid-renovation costs them longer than the
        // freeze itself -- you broke their concentration
        if (q.padKind === "reno") q.renoLockT = TALK_RENO_PAUSE;
      });
      this.broadcast("talk", { by: p.name, name: hit[0].name, n: hit.length });
    });

    // IT: camera sweep reveals every employee briefly
    this.onMessage("ping", (client) => {
      const st = this.state;
      if (st.phase !== "playing") return;
      const p = st.players.get(client.sessionId);
      if (!p || p.team !== "it" || p.spectator) return;
      if (st.camsDown) { client.send("notice", "Cameras are offline — no sweep"); return; }
      if (p.pingCd > 0) { client.send("notice", `Ping recharging (${Math.ceil(p.pingCd)}s)`); return; }
      p.pingCd = PING_CD;
      st.pingUntil = PING_DUR;
      this.broadcast("pinged", { by: p.name });
    });

    // team-only text chat
    this.onMessage("say", (client, text) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || !p.charId) return;
      let msg = String(text == null ? "" : text).replace(/[<>]/g, "").trim().slice(0, 120);
      if (!msg) return;
      const team = p.spectator ? "spec" : p.team;
      // only your own side hears you
      for (const c of this.clients) {
        const q = this.state.players.get(c.sessionId);
        if (!q) continue;
        const qteam = q.spectator ? "spec" : q.team;
        if (qteam === team) c.send("said", { name: p.name || "someone", text: msg, team: team });
      }
    });

    this.onMessage("ready", (client, val) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.spectator || !p.charId) return;
      if (this.state.phase !== "lobby" && this.state.phase !== "starting") return;
      p.ready = !!val;
    });

    this.setSimulationInterval(ms => this.tick(ms / 1000), 1000 / TICK_HZ);
  }

  // "active" = has a character, is not spectating (by choice or overflow)
  activePlayers() {
    const list = [];
    this.state.players.forEach((p, id) => {
      if (!p.spectator && !p.wantsSpectate && p.charId) list.push([id, p]);
    });
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
    p.wantsSpectate = false;
    p.stCatches = 0; p.stRepairs = 0; p.stReno = 0;
    p.stBreaks = 0; p.stSab = 0; p.stCaught = 0; p.stJailT = 0;
    p.wins = 0; p.losses = 0;
    // beyond the active cap, or arriving mid-round, you watch first
    p.spectator = this.state.phase !== "lobby" ||
                  this.activePlayers().length >= MAX_ACTIVE;

    this.state.players.set(client.sessionId, p);
    this.inputs.set(client.sessionId, { dx: 0, dy: 0, transCd: 0 });
    console.log(`client ${client.sessionId.slice(0,6)} joined (${this.state.players.size} in room)`);
  }

  async onLeave(client, consented) {
    const p = this.state.players.get(client.sessionId);
    if (!p) return;
    p.connected = false;               // body goes idle, stays in the world
    p.ready = false;

    // NB: Colyseus passes the WebSocket close CODE here, not a boolean.
    // 1000 = clean, deliberate leave. 1001/1005/1006 = the connection
    // dropped (tab closed, network died) -- those should hold the seat.
    // Colyseus uses 4000 for a deliberate leave() and 1000 for a clean
    // socket close. 1001/1005/1006 mean the connection dropped, which is
    // what should hold the seat open for a reconnect.
    var deliberate = (consented === true) || consented === 1000 || consented >= 4000;
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
    this.promoteWaiting();
    if (p) console.log(`${p.name || id.slice(0,6)} left (${this.state.players.size} in room)`);
  }

  /* fill free active slots from anyone waiting who actually wants to play */
  promoteWaiting() {
    if (this.state.phase !== "lobby") return;
    this.state.players.forEach(q => {
      if (q.spectator && q.charId && !q.wantsSpectate &&
          this.activePlayers().length < MAX_ACTIVE) {
        q.spectator = false;
      }
    });
    this.assignTeams();
  }

  /* Everyone who intends to play must be ready, there must be at least
     two of them, and neither side can be empty -- otherwise "all ready"
     could start a round with nobody to chase.                          */
  /* Legal pairings only: 1v1, 1v2, 2v2, 2v3, 3v3, 3v4, 3v5. Because a
     player's team comes from the character they picked, a lobby can
     easily end up lopsided (e.g. 1 I.T. vs 5). Refuse to start until
     the split matches, and tell them exactly what's missing.          */
  teamCounts() {
    let it = 0, emp = 0, notReady = 0;
    for (const [, p] of this.activePlayers()) {
      if (p.team === "it") it++; else if (p.team === "emp") emp++;
      if (!p.ready && p.connected) notReady++;
    }
    return { it, emp, notReady, total: it + emp };
  }

  legalSplit(it, emp) {
    const want = SPLITS[Math.min(8, it + emp)];
    return !!want && want[0] === it && want[1] === emp;
  }

  canStart() {
    const c = this.teamCounts();
    if (c.total < 2) return false;
    if (!this.legalSplit(c.it, c.emp)) return false;
    return c.notReady === 0;
  }

  resetObjectives() {
    const active = this.activePlayers();
    let it = 0, emp = 0;
    for (const [, p] of active) { if (p.team === "it") it++; else if (p.team === "emp") emp++; }
    this.state.renoNeed = renoNeedFor(it || 1, emp || 1);
    this.state.faults = 0;
    this.state.renoBlocked = false;
    this.state.zones.clear();
    this.state.stations.clear();
    for (const r of RENOS) {
      const z = new Zone(); z.id = r.id; z.progress = 0; z.done = false;
      this.state.zones.set(r.id, z);
    }
    for (const st of STATIONS) {
      const s2 = new Station();
      s2.id = st.id; s2.progress = 0; s2.broken = false;
      s2.sla = ISSUE_SLA; s2.fixProg = 0;
      this.state.stations.set(st.id, s2);
    }
    this.state.writtenUp = 0;
    this.state.cookoutT = 0;
    this.state.cookoutDone = false;
    this.state.cookoutCd = 0;
    this.state.mail = 0;
    this.state.maxMail = MAX_MAIL;
    this.state.pingUntil = 0;
    this.state.camsDown = false;
    this.state.bailProg = 0;
    this.state.players.forEach(p => {
      p.cooldown = 0; p.atPad = ""; p.padKind = "";
      p.vulnerable = false; p.jailT = 0; p.jailCount = 0; p.catchCd = 0;
      p.frozenT = 0; p.talkCd = 0; p.pingCd = 0; p.renoLockT = 0; p.bounceT = 0;
      p.stCatches = 0; p.stRepairs = 0; p.stReno = 0;
      p.stBreaks = 0; p.stSab = 0; p.stCaught = 0; p.stJailT = 0;
    });
  }

  startRound() {
    this.resetObjectives();
    this.state.phase = "playing";
    this.state.clock = ROUND_SECONDS;
    this.state.roundLen = ROUND_SECONDS;
    this.state.countdown = 0;
    this.state.resultReason = "";
    this.state.winner = "";
    this.state.roundNo++;
    this.assignTeams();
    this.activePlayers().forEach(([, p]) => this.placeAtSpawn(p));
    console.log(`round ${this.state.roundNo} started (${this.activePlayers().length} players)`);
  }

  endRound(reason, winner) {
    if (this.state.phase === "results") return;
    this.state.phase = "results";
    this.state.winner = winner || "";
    if (winner) {
      this.state.players.forEach(p => {
        if (p.spectator || !p.charId) return;
        if (p.team === winner) p.wins++; else p.losses++;
      });
    }
    this.state.resultReason = reason;
    this.state.countdown = 0;   // no auto-return: players press "Next Day"
    console.log(`round ${this.state.roundNo} ended: ${reason}`);
  }

  resetToLobby() {
    this.state.phase = "lobby";
    this.state.clock = ROUND_SECONDS;
    this.state.countdown = 0;
    // everything resets and everyone re-picks; opting to spectate sticks
    this.state.players.forEach(p => {
      p.charId = ""; p.name = ""; p.team = "";
      p.ready = false;
      p.spectator = p.wantsSpectate ? true : false;
    });
    console.log("back to lobby");
  }

  /* how many people are actually still playing this round */
  liveActive() {
    return this.activePlayers().filter(([, p]) => p.connected).length;
  }

  /* Everything that happens by standing still: renovating, sabotaging,
     and the cooldown between sabotages. All of it server-side.        */
  objectivesTick(dt) {
    const st = this.state;
    const near = (p, o) => p.level === o.level &&
      Math.hypot(p.x - (o.x + 0.5), p.y - (o.y + 0.5)) < ACT_R;

    st.players.forEach(p => {
      if (p.cooldown > 0) p.cooldown = Math.max(0, p.cooldown - dt);
      if (p.catchCd > 0) p.catchCd = Math.max(0, p.catchCd - dt);
      if (p.talkCd > 0) p.talkCd = Math.max(0, p.talkCd - dt);
      if (p.pingCd > 0) p.pingCd = Math.max(0, p.pingCd - dt);
      if (p.frozenT > 0) p.frozenT = Math.max(0, p.frozenT - dt);
      if (p.renoLockT > 0) p.renoLockT = Math.max(0, p.renoLockT - dt);
      // vulnerability lingers briefly after stepping off a station, so
      // you can't hop off and back on as IT walks past
      if (p.sabGrace > 0) {
        p.sabGrace -= dt;
        if (p.sabGrace <= 0) p.vulnerable = false;
      }
      // finish the comedy launch, then drop them in Schelle's office
      if (p.bounceT > 0) {
        p.bounceT = Math.max(0, p.bounceT - dt);
        if (p.bounceT === 0) {
          p.level = JAIL.level;
          p.x = JAIL.x + 0.5 + (Math.random() - 0.5) * 1.6;
          p.y = JAIL.y + 0.5 + (Math.random() - 0.5) * 1.6;
        }
      }
      // serving a sentence
      if (p.jailT > 0) {
        p.jailT = Math.max(0, p.jailT - dt);
        p.stJailT += dt;
        if (p.jailT === 0) console.log(`${p.name} is back from HR, unrepentant`);
      }
      p.atPad = ""; p.padKind = "";
    });

    // renovation: IT only, progress banks permanently
    if (st.pingUntil > 0) st.pingUntil = Math.max(0, st.pingUntil - dt);
    if (st.cookoutT > 0) st.cookoutT = Math.max(0, st.cookoutT - dt);
    if (st.cookoutCd > 0) st.cookoutCd = Math.max(0, st.cookoutCd - dt);
    st.faults = 0;
    st.camsDown = false;
    st.stations.forEach(s2 => {
      if (s2.broken) { st.faults++; if (s2.id === "cams") st.camsDown = true; }
    });
    st.renoBlocked = st.faults >= BLOCK_AT;

    for (const r of RENOS) {
      const z = st.zones.get(r.id);
      if (!z || z.done) continue;
      let crew = 0;
      st.players.forEach(p => {
        if (p.team !== "it" || p.spectator || !p.charId) return;
        if (!near(p, r)) return;
        p.atPad = r.id; p.padKind = "reno";
        // cornered by small talk? you're standing there, but not working
        if (p.frozenT > 0 || p.renoLockT > 0) return;
        crew++;
      });
      if (crew > 0 && !st.renoBlocked) {
        const rate = crew >= 3 ? RENO_TRIO : (crew >= 2 ? RENO_PAIR : RENO_SOLO);
        z.progress = Math.min(st.renoNeed, z.progress + rate * dt);
        st.players.forEach(p => {
          if (p.team === "it" && p.atPad === r.id && p.padKind === "reno") p.stReno += dt;
        });
        if (z.progress >= st.renoNeed) { z.done = true; console.log(`${r.n} finished`); }
      }
    }

    // sabotage: employees only, progress is SHARED per station and is
    // lost entirely if everyone walks away
    for (const stn of STATIONS) {
      const s2 = st.stations.get(stn.id);
      if (!s2) continue;
      if (stn.special === "cookout" && st.cookoutCd > 0) { s2.progress = 0; continue; }
      const crew = [];
      st.players.forEach(p => {
        if (p.team !== "emp" || p.spectator || !p.charId) return;
        if (p.jailT !== 0) return;          // in Schelle's office
        if (!near(p, stn)) return;
        if (s2.broken) { p.atPad = stn.id; p.padKind = "broken"; return; }
        if (p.cooldown > 0) { p.atPad = stn.id; p.padKind = "cooling"; return; }
        crew.push(p);
      });
      if (s2.broken) { s2.progress = 0; continue; }
      if (crew.length === 0) { s2.progress = 0; continue; }

      // Under-staffed is slow; a full crew is full speed; and an extra
      // body beyond the requirement now speeds every station up, capped
      // at three people.
      const n = crew.length;
      const bonus = Math.max(0, Math.min(n, 3) - stn.need) * 0.5;
      const rate = n >= stn.need ? 1 + bonus : (n / stn.need) * (2 / 3);
      s2.progress += dt * rate;
      for (const p of crew) {
        p.atPad = stn.id; p.padKind = "station";
        p.vulnerable = true; p.sabGrace = SAB_GRACE;
        p.stSab += dt;
      }

      if (s2.progress >= stn.brk - 1e-6 && stn.special === "cookout") {
        s2.progress = 0;
        for (const p of crew) { p.cooldown = EMP_CD; p.atPad = ""; p.padKind = ""; p.stBreaks++; }
        this.startCookout(crew[0]);
        continue;
      }
      if (s2.progress >= stn.brk - 1e-6) {
        s2.broken = true;
        s2.progress = 0;
        s2.sla = ISSUE_SLA;
        s2.fixProg = 0;
        this.broadcast("fault", { n: stn.n });
        for (const p of crew) { p.cooldown = EMP_CD; p.atPad = ""; p.padKind = ""; p.stBreaks++; }
        console.log(`${stn.n} broken`);
      }
    }

    // bail: free employees standing in Schelle's office cut a sentence short
    const bailers = [];
    let serving = null;
    st.players.forEach(p => {
      if (p.team !== "emp" || p.spectator || !p.charId) return;
      if (p.jailT > 0) { if (!serving || p.jailT > serving.jailT) serving = p; return; }
      if (p.jailT !== 0) return;                       // written up, can't help
      if (p.level === JAIL.level &&
          Math.hypot(p.x - (JAIL.x + 0.5), p.y - (JAIL.y + 0.5)) < ACT_R + 0.7) bailers.push(p);
    });
    if (bailers.length && serving) {
      st.bailProg += dt * bailers.length;
      for (const b of bailers) { b.atPad = "jail"; b.padKind = "bail"; }
      if (st.bailProg >= BAIL_DWELL) {
        st.bailProg = 0;
        serving.jailT = 0;
        console.log(`${bailers[0].name} vouched for ${serving.name}. Bold.`);
      }
    } else st.bailProg = 0;

    // Faults left alone earn emails from Schelle. IT clears one by
    // standing on it for FIX_TIME seconds.
    for (const stn of STATIONS) {
      const s2 = st.stations.get(stn.id);
      if (!s2 || !s2.broken) continue;

      s2.sla -= dt;
      if (s2.sla <= 0) {
        s2.sla = ISSUE_SLA;            // ignore it and it keeps costing you
        st.mail++;
        this.broadcast("email", { n: stn.n, count: st.mail, max: MAX_MAIL });
        console.log(`Email from Schelle (${st.mail}/${MAX_MAIL}) -- ${stn.n}`);
      }

      let crew = 0;
      st.players.forEach(p => {
        if (p.team !== "it" || p.spectator || !p.charId || p.frozenT > 0) return;
        if (near(p, stn)) { crew++; p.atPad = stn.id; p.padKind = "fixing"; }
      });
      if (crew > 0) s2.fixProg += crew * dt;
      else s2.fixProg = Math.max(0, s2.fixProg - dt * 1.5);

      if (s2.fixProg >= FIX_TIME) {
        s2.broken = false; s2.progress = 0; s2.fixProg = 0; s2.sla = ISSUE_SLA;
        st.players.forEach(p => { if (p.atPad === stn.id && p.padKind === "fixing") p.stRepairs++; });
        this.broadcast("fixed", { n: stn.n });
        console.log(`${stn.n} fixed`);
      }
    }

    this.checkWin();
  }

  /* Catching is a referee decision: a client asks, the server decides.
     Only someone actively sabotaging (or within the grace window) can
     be caught, and a catch takes the WHOLE crew on that station.      */
  tryCatch(client) {
    const st = this.state;
    if (st.phase !== "playing") return;
    const it = st.players.get(client.sessionId);
    if (!it || it.team !== "it" || it.spectator || it.catchCd > 0) return;
    if (it.frozenT > 0) { client.send("notice", "You are trapped in a conversation"); return; }
    it.catchCd = CATCH_CD;

    let target = null, best = CATCH_R, sawSomeone = false;
    st.players.forEach(q => {
      if (q.team !== "emp" || q.spectator || !q.charId || q.jailT !== 0) return;
      if (q.level !== it.level) return;
      const d = Math.hypot(q.x - it.x, q.y - it.y);
      if (d < CATCH_R) sawSomeone = true;
      if (d < best && q.vulnerable) { best = d; target = q; }
    });
    if (!target) {
      client.send("catchMiss", sawSomeone ? "They are just standing there. Suspiciously."
                                          : "Nobody within grabbing distance");
      return;
    }

    // everyone on the same job goes down together
    const crew = [];
    st.players.forEach(q => {
      if (q.team !== "emp" || q.jailT !== 0 || !q.vulnerable) return;
      if (q === target || (target.atPad && q.atPad === target.atPad)) crew.push(q);
    });
    const list = crew.length ? crew : [target];
    for (const q of list) this.sendToJail(q, it, list.length > 1);
    if (list.length > 1) this.broadcast("bust", { by: it.name, n: list.length });
  }

  /* Everyone downs tools and stands around Vince's grill. Positions are
     set by the server so nobody can wander off during it.            */
  startCookout(by) {
    const st = this.state;
    st.cookoutT = COOKOUT_FREEZE;
    st.cookoutDone = true;
    st.cookoutCd = COOKOUT_COOLDOWN;

    const grill = PROPS.find(p => p.id === "grill");
    let i = 0, n = 0;
    st.players.forEach(p => { if (!p.spectator && p.charId) n++; });
    st.players.forEach(p => {
      if (p.spectator || !p.charId) return;
      const ang = (i / Math.max(1, n)) * Math.PI * 2;
      const rad = 2.2 + (i % 2) * 0.9;
      p.level = "EXT";
      p.x = Math.max(3, Math.min(GW - 3, grill.x + 0.5 + Math.cos(ang) * rad));
      p.y = Math.max(3, Math.min(GH - 3, grill.y + 1.5 + Math.sin(ang) * rad));
      p.frozenT = COOKOUT_FREEZE;     // nobody moves, nobody catches
      p.atPad = ""; p.padKind = "";
      p.vulnerable = false; p.sabGrace = 0;
      i++;
    });
    this.broadcast("cookout", { by: by ? by.name : "someone" });
    console.log(`COOKOUT WITH VINCE started by ${by ? by.name : "someone"}`);
  }

  sendToJail(emp, by, quiet) {
    emp.jailCount++;
    emp.stCaught++;
    if (by) by.stCatches++;
    emp.vulnerable = false; emp.sabGrace = 0;
    emp.atPad = ""; emp.padKind = "";
    const dur = JAIL_TIMES[Math.min(emp.jailCount - 1, JAIL_TIMES.length - 1)];
    // They pop up and sail off screen where they were caught, and only
    // then reappear in Schelle's office. Position is held until the
    // animation finishes so every client shows the launch in place.
    emp.bounceT = BOUNCE_TIME;
    if (dur < 0) {
      emp.jailT = -1;
      this.state.writtenUp++;
      this.broadcast("hr", { name: emp.name });
      console.log(`${emp.name} was written up by HR -- done for the day`);
    } else {
      emp.jailT = dur;
      this.broadcast("caught", { by: by.name, name: emp.name, quiet: !!quiet });
      console.log(`${by.name} caught ${emp.name}`);
    }
  }

  /* Four ways a round can end. Checked once per tick, server-side. */
  checkWin() {
    const st = this.state;
    if (st.phase !== "playing") return;

    // 1. IT finished the building
    let doneCount = 0;
    st.zones.forEach(z => { if (z.done) doneCount++; });
    if (doneCount >= RENOS.length) {
      return this.endRound("Renovations complete. The building looks incredible. Nobody will notice.", "it");
    }

    // 2. every employee written up by HR
    let emps = 0, out = 0;
    st.players.forEach(p => {
      if (p.team !== "emp" || p.spectator || !p.charId) return;
      emps++;
      if (p.jailT === -1) out++;
    });
    if (emps > 0 && out >= emps) {
      return this.endRound("Everyone was written up by HR. The office is very quiet now.", "it");
    }

    // 3. Schelle lost patience
    if (st.mail >= st.maxMail) {
      return this.endRound("Three emails from Schelle. IT has been pulled into a meeting about the meetings.", "emp");
    }
    // 4. the clock is handled in tick()
  }

  tick(dt) {
    /* ---- round lifecycle ---- */
    const st = this.state;
    if (st.phase === "lobby") {
      const c = this.teamCounts();
      const want = SPLITS[Math.min(8, Math.max(2, c.total))] || [0, 0];
      st.needIt = c.total >= 2 ? want[0] : 0;
      st.needEmp = c.total >= 2 ? want[1] : 0;
      if (this.canStart()) { st.phase = "starting"; st.countdown = START_COUNTDOWN; }
    } else if (st.phase === "starting") {
      // someone un-readied or left -- back to the lobby
      if (!this.canStart()) { st.phase = "lobby"; st.countdown = 0; }
      else {
        st.countdown -= dt;
        if (st.countdown <= 0) this.startRound();
      }
    } else if (st.phase === "playing") {
      st.clock -= dt;
      if (st.clock <= 0) { st.clock = 0; this.endRound("5 o'clock. The scaffolding stays up another week.", "emp"); }
      // if literally everyone has dropped, don't run an empty round
      else if (this.liveActive() === 0) this.endRound("Everyone left the building.", "");
    } else if (st.phase === "results") {
      // stays on screen until someone calls the next day
      if (this.liveActive() === 0 && this.state.players.size === 0) this.resetToLobby();
    }

    if (st.phase === "playing") this.objectivesTick(dt);

    for (const [id, inp] of this.inputs) {
      const p = this.state.players.get(id);
      if (!p) continue;
      if (inp.transCd > 0) inp.transCd -= dt;
      // if we stop hearing from a client, assume they let go rather than
      // letting them coast forever on a lost "stop" packet
      inp.age = (inp.age || 0) + dt;
      if (inp.age > INPUT_STALE) { inp.dx = 0; inp.dy = 0; }

      // Serving a sentence: frozen. Written up (-1): out of the round,
      // so let them roam as a spectator instead of being stuck forever.
      if (p.jailT > 0) { p.moving = false; continue; }      // stuck in HR
      const watching = p.spectator || p.jailT === -1;
      if (p.frozenT > 0) { p.moving = false; continue; }   // trapped in conversation
      let dx = inp.dx, dy = inp.dy;
      const mag = Math.hypot(dx, dy);
      p.moving = mag > 0.01;
      if (!p.moving) continue;
      dx /= mag; dy /= mag;
      if (Math.abs(dx) > 0.15) p.facing = dx > 0 ? 1 : -1;

      const step = SPEED * dt * ((p.spectator || p.jailT === -1) ? 1.6 : 1);
      const nx = p.x + dx * step, ny = p.y + dy * step;

      // spectators drift through walls with a free camera. They can't
      // use stairs (they'd have to find them), so they get a direct
      // floor jump via the "specfloor" message instead.
      if (watching) {
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
          if (Math.hypot(p.x - (t.x + 0.5), p.y - (t.y + 0.5)) < TRANS_R) {
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
        transR: TRANS_R,
        props: PROPS,
        actR: ACT_R,
        renos: RENOS,
        stations: STATIONS,
        jail: JAIL,
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

// gameServer is exported so tests can reach into a live room
module.exports = { LEVELS, TRANSITIONS, canWalk, solid, spawnSpots, splitFor, ginTeamFor, CHARACTERS, GW, GH, gameServer };
