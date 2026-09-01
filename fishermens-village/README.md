# Fisherman's Village

Two-player waterfront chase. Gin shakes water out of the mangroves onto Emily;
Emily collects cans off the ground and throws them at Gin. Will occasionally
flies in and throws whoever he catches somewhere else entirely.

Single player (vs a bot) and two-player over the network both work.

---

## Deploying to Render

Push this folder to GitHub, then in Render: **New → Web Service**, point it at
the repo, and use:

| Setting | Value |
|---|---|
| Environment | Node |
| Build command | `npm install` |
| Start command | `npm start` |
| Instance type | Free is fine for two players |

That's the whole setup. `npm install` runs the build automatically (via
`postinstall`), which bakes the sprites and game logic into `index.html`.
The server then serves that file *and* handles the WebSocket connections on
the same port, so there's nothing else to configure — no separate static
site, no CORS, no environment variables.

Render assigns the port through `PORT`, which the server already reads.

**One Render-specific thing worth knowing:** free instances spin down after
inactivity, so the first visit after a quiet spell takes ~30 seconds to wake
up. Once someone's on, it stays warm. If that becomes annoying, the paid
tier removes it.

## Running locally

```bash
npm install
npm start          # http://localhost:3000
```

To test two players on one machine, open two browser windows — host in one,
join with the code in the other.

## Tests

```bash
node test_sp.js    # single player + UI, via jsdom
node test_mp.js    # multiplayer protocol: rooms, roles, disconnects
node test_mp2.js   # plays a full match over real sockets, then rematches
```

## Layout

```
sim.js            game rules — shared verbatim by client and server
client.html       rendering, input, netcode (source; has placeholders)
build.js          inlines sim.js + sprites into index.html
index.html        built output — do not edit by hand, it gets overwritten
server/index.js   WebSocket server + static hosting
sprites/          extracted art
```

`sim.js` is deliberately the only copy of the game rules. The server is
authoritative in multiplayer and the client runs the same file for single
player, so tuning a constant changes both at once instead of leaving them to
drift apart.

## Tuning

Everything worth adjusting is in the `C` block at the top of `sim.js`:

| Constant | Now | What it does |
|---|---|---|
| `SPEED` | 231 | walk speed, px/sec |
| `SHAKE_WINDUP` | 650 | delay between shaking and the water falling |
| `SPLASH_RANGE` | 95 | how close Emily must be when it lands |
| `TREE_RANGE` | 62 | how close Gin must be to shake |
| `TREE_COOL` | 9000 | how long a tree takes to refill |
| `CAN_RESPAWN` | 7000 | how long a thrown can takes to come back |
| `THROW_SPEED` | 330 | can velocity (a throw carries ~190px) |
| `HITS_TO_WIN` | 3 | hits needed to take the round |

`SHAKE_WINDUP` and `SPLASH_RANGE` are the two that decide whether Gin feels
fair. Together they set how long Emily has to notice a shake and get clear —
currently about a 0.28s reaction window. Widen the range or shorten the
windup to make Gin scarier.

## Known gaps

- **Trees don't hide anyone yet.** They draw behind the characters, so you
  can't duck behind one out of sight. Each player has their own camera, so
  going off-screen already hides you; proper occlusion is a rendering change.
- **Rounds are single, not best-of-three.** First to 3 hits takes it, then
  you're offered a rematch.
- **No audio.**
