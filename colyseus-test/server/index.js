// ---- state ----------------------------------------------------------
// Plain-JS schema (no decorators, no TypeScript, no build step needed).
const { Schema, MapSchema, defineTypes } = require("@colyseus/schema");

class Player extends Schema {}
defineTypes(Player, {
  x: "number",
  y: "number",
  color: "string",
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
const ARENA = { w: 640, h: 420 };
const COLORS = ["#5CC8FF", "#FF8A5A"];

class DotsRoom extends Room {
  onCreate() {
    this.setState(new DotsState());
    this.maxClients = 2;

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
    });

    // The authoritative simulation tick: this is the "update(dt)" you
    // already know from the browser game, just running on the server
    // instead of in a requestAnimationFrame loop.
    this.setSimulationInterval((deltaMs) => this.tick(deltaMs / 1000), 1000 / 30);
  }

  onJoin(client) {
    const player = new Player();
    const idx = this.state.players.size % COLORS.length;
    player.x = ARENA.w / 2 + (idx === 0 ? -60 : 60);
    player.y = ARENA.h / 2;
    player.color = COLORS[idx];
    this.state.players.set(client.sessionId, player);
    this.inputs.set(client.sessionId, { x: 0, y: 0 });

    console.log(`${client.sessionId} joined (${this.state.players.size}/2)`);
  }

  onLeave(client) {
    this.state.players.delete(client.sessionId);
    this.inputs.delete(client.sessionId);
    console.log(`${client.sessionId} left`);
  }

  tick(dt) {
    for (const [sessionId, input] of this.inputs) {
      const player = this.state.players.get(sessionId);
      if (!player) continue;
      const mag = Math.hypot(input.x, input.y) || 1;
      player.x += (input.x / mag) * SPEED * dt;
      player.y += (input.y / mag) * SPEED * dt;
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
  console.log(`Open http://localhost:${PORT} in TWO browser tabs to test.`);
});
