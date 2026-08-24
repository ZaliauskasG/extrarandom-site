// ---- state ----------------------------------------------------------
// Plain-JS schema (no decorators, no TypeScript, no build step needed).
const { Schema, MapSchema, defineTypes } = require("@colyseus/schema");

class Player extends Schema {}
defineTypes(Player, {
  x: "number",
  y: "number",
  color: "string",
  name: "string",
});

class DotsState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
  }
}
defineTypes(DotsState, { players: { map: Player } });

// ---- room -------------------------------------------------------------
// This is the "referee." It is the ONLY place that decides where anyone
// actually is. Clients only ever send an intent ("I'm holding W+D"); the
// room turns that into a real position on a fixed tick, then broadcasts
// the result to everyone. Nobody can lie about their own position.
const { Room } = require("colyseus");

const SPEED = 220; // pixels per second
const ARENA = { w: 720, h: 480 };
const MAX_PLAYERS = 8;
// One colour per seat, so everyone is visually distinct.
const COLORS = [
  "#5CC8FF", "#FF8A5A", "#9BF0BC", "#FFD84D",
  "#C77BFF", "#FF7BC8", "#7BE0D8", "#FF6B5A",
];
const NAMES = ["Ryan", "Juan", "Gin", "Jason", "Raif", "Thomas", "Andy", "Ben"];

class DotsRoom extends Room {
  onCreate() {
    this.setState(new DotsState());
    this.maxClients = MAX_PLAYERS;

    // Which colour/name seats are currently free. Taking a seat on join
    // and handing it back on leave means the 3rd player to join after
    // someone leaves reuses the empty seat instead of running off the end.
    this.freeSeats = Array.from({ length: MAX_PLAYERS }, (_, i) => i);

    // Track each client's current input (not their position!) so the
    // simulation tick below can move everyone consistently.
    this.inputs = new Map();

    // Registered ONCE on the room, for every client — not per-client.
    // A client only ever sends its intended direction, never a position.
    this.onMessage("move", (client, dir) => {
      const input = this.inputs.get(client.sessionId);
      if (!input) return;
      input.x = Math.max(-1, Math.min(1, Number(dir?.x) || 0));
      input.y = Math.max(-1, Math.min(1, Number(dir?.y) || 0));
      // Using the keyboard cancels any tap destination.
      if (input.x !== 0 || input.y !== 0) input.target = null;
    });

    // Tap / click to walk somewhere. The client sends a DESTINATION, not a
    // position -- the server still decides the travel speed and the bounds,
    // so this can't be abused to teleport.
    this.onMessage("target", (client, pos) => {
      const input = this.inputs.get(client.sessionId);
      if (!input) return;
      const tx = Number(pos?.x), ty = Number(pos?.y);
      if (!Number.isFinite(tx) || !Number.isFinite(ty)) return;
      input.target = {
        x: Math.max(14, Math.min(ARENA.w - 14, tx)),
        y: Math.max(14, Math.min(ARENA.h - 14, ty)),
      };
    });

    // The authoritative simulation tick: this is the "update(dt)" you
    // already know from the browser game, just running on the server
    // instead of in a requestAnimationFrame loop.
    this.setSimulationInterval((deltaMs) => this.tick(deltaMs / 1000), 1000 / 30);
  }

  onJoin(client) {
    const seat = this.freeSeats.shift();
    const player = new Player();

    // Space everyone evenly around a circle so nobody spawns on top
    // of anybody else, however many are already here.
    const angle = (seat / MAX_PLAYERS) * Math.PI * 2;
    const radius = Math.min(ARENA.w, ARENA.h) * 0.3;
    player.x = ARENA.w / 2 + Math.cos(angle) * radius;
    player.y = ARENA.h / 2 + Math.sin(angle) * radius;
    player.color = COLORS[seat];
    player.name = NAMES[seat];

    this.state.players.set(client.sessionId, player);
    this.inputs.set(client.sessionId, { x: 0, y: 0, seat, target: null });

    console.log(`${player.name} joined (${this.state.players.size}/${MAX_PLAYERS})`);
  }

  onLeave(client) {
    const input = this.inputs.get(client.sessionId);
    if (input) this.freeSeats.unshift(input.seat); // hand the seat back
    this.state.players.delete(client.sessionId);
    this.inputs.delete(client.sessionId);
    console.log(`${client.sessionId} left (${this.state.players.size}/${MAX_PLAYERS})`);
  }

  tick(dt) {
    for (const [sessionId, input] of this.inputs) {
      const player = this.state.players.get(sessionId);
      if (!player) continue;

      let dx = input.x, dy = input.y;

      // No key held? Walk toward the tapped destination, if there is one.
      if (dx === 0 && dy === 0 && input.target) {
        const tdx = input.target.x - player.x;
        const tdy = input.target.y - player.y;
        const dist = Math.hypot(tdx, tdy);
        if (dist < 3) {
          input.target = null;   // arrived
        } else {
          dx = tdx / dist;
          dy = tdy / dist;
          // don't overshoot on the last step
          if (dist < SPEED * dt) {
            player.x = input.target.x;
            player.y = input.target.y;
            input.target = null;
            continue;
          }
        }
      }

      if (dx === 0 && dy === 0) continue;
      const mag = Math.hypot(dx, dy) || 1;
      player.x += (dx / mag) * SPEED * dt;
      player.y += (dy / mag) * SPEED * dt;
      player.x = Math.max(14, Math.min(ARENA.w - 14, player.x));
      player.y = Math.max(14, Math.min(ARENA.h - 14, player.y));
    }
  }
}

// ---- server -------------------------------------------------------------
const { Server } = require("colyseus");
const { WebSocketTransport } = require("@colyseus/ws-transport");
const express = require("express");
const path = require("path");

// Colyseus owns its own internal Express app (for the websocket upgrade AND
// its matchmaking HTTP routes). The `express` option here is the documented
// way to add your own routes to that SAME app -- rather than building a
// separate app and handing Colyseus its raw HTTP server, which only wires
// up the socket and leaves matchmaking routes missing (a 404 trap).
const gameServer = new Server({
  transport: new WebSocketTransport(),
  express: (app) => {
    app.use(express.static(path.join(__dirname, "..", "client")));
  },
});
gameServer.define("dots", DotsRoom);

const PORT = process.env.PORT || 2567;
gameServer.listen(PORT).then(() => {
  console.log(`Hello-world Colyseus server running on http://localhost:${PORT}`);
  console.log(`Open http://localhost:${PORT} in up to ${MAX_PLAYERS} browser tabs to test.`);
});
