# Colyseus Hello World — Up To 8 Dots

A minimal authoritative-multiplayer demo. Up to 8 players, one coloured dot each,
one server deciding what's true.

## Folder layout

    hello-colyseus/
      server/
        index.js        <- the game server (Node.js — the "referee")
        package.json
      client/
        index.html      <- the whole browser client, single file

## Run it locally

    cd server
    npm install
    node index.js

Then open http://localhost:2567 in **up to 8 browser tabs**.
WASD or arrow keys move your dot.

## What this demonstrates

- Clients send **inputs only** ("I'm holding right"), never positions.
- The server runs a fixed 30fps tick and decides where everyone actually is.
- The server's state is synced to every client automatically.
- No client can lie about its own position, because it never reports one.

## Notes / gotchas

- The client SDK is `@colyseus/sdk` (the older `colyseus.js` package name
  belongs to the 0.16 line). The SDK version **must match** the server's
  Colyseus version line or joining fails with a confusing error.
- `onMessage` is registered on the **room**, not per-client.
- Custom HTTP routes go through Colyseus's own Express app via the
  `express:` option. Handing Colyseus a separate http.Server wires up the
  websocket but leaves matchmaking routes missing (404 on join).

## Hosting later

- `client/index.html` is static — it can live on GitHub Pages, Netlify, etc.
  Set `SERVER_URL` near the top of the file to your deployed server, e.g.
  `wss://my-game.up.railway.app`.
- `server/` needs a host that runs **Node.js** (Railway, Fly.io, Render,
  DigitalOcean, or Colyseus Cloud). GitHub Pages cannot run it.
