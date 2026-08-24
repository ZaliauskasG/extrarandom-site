# Tag — multiplayer

Up to 8 players chase each other around a square field. Whoever is "it"
wears a red ring. Touch someone to pass it on. No rounds — the scoreboard
tracks total time spent as "it", and the lowest time is winning.

## Layout

    tag-game/
      server/index.js       the authoritative game server (Node)
      server/package.json
      client/index.html     the whole browser client, one file

## Run locally

    cd server
    npm install
    node index.js

Open http://localhost:2567 in up to 8 tabs.

## Deploy

Push `server/` to your repo and point a Render **Web Service** at it
(Root Directory `server`, build `npm install`, start `npm start`).
The client is served by the server automatically at the same URL.

If you ever host the client separately, set `SERVER_URL` near the top of
the script in `client/index.html`.

## Design notes

- The server owns everything: positions, obstacle collision, who is "it",
  and the it-time clocks. Clients only send intent (a held direction, or
  a tapped destination) — never a position, so nobody can teleport.
- Tap-to-move destinations are clamped into the field and walked toward
  at normal speed.
- A 2s immunity on the new "it" prevents instant tag-backs while the two
  players are still overlapping.
- If "it" disconnects, the ring passes to whoever has the *least* it-time
  (fairest choice) rather than vanishing.
- Positions are smoothed client-side so motion stays fluid even when
  network updates arrive irregularly.
- The render loop schedules its next frame FIRST, so a transient error
  can never permanently kill rendering.
- Names are sanitised server-side (markup stripped, 12 char cap) and
  HTML-escaped again in the scoreboard.

## Tests

    node test-geometry.js        collision / spawns / name sanitising
    node test-gameplay.js        tag rules, it-time, disconnect handoff  (needs server running)
    node test-browser-client.js  runs the real client against a live server
