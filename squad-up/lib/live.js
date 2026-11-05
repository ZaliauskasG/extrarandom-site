/* ============================================================================
   SQUAD UP — live updates
   Each open page keeps one quiet connection (Server-Sent Events) to
   /squadup/live, listening to a few topics:
     "a:<plan id>"  a plan page        "f:<poll id>"  a poll page
     "home"         any home page (plans, polls, counts, Activities)
   When something changes, the server sends a short note -- never the data
   itself -- and the page fetches the fresh piece when the person isn't in
   the middle of tapping or typing. Notes about one topic are gathered for a
   moment and sent once, so a burst of taps means one refresh, not ten.
   Typing dots go straight through and are never saved.

   This lives in the one running copy of the app (Render runs one). If the
   app ever runs as several copies, notes would need to pass between them.
   ========================================================================== */
const crypto = require("crypto");

const TOPIC_RE = /^(home|a:[A-Za-z0-9_-]{1,40}|f:[A-Za-z0-9_-]{1,40})$/;

function makeHub(opts) {
  const o = opts || {};
  const HEARTBEAT_MS = o.heartbeatMs || 25000;   // under the ~60-100s idle cut of most proxies
  const GATHER_MS = o.gatherMs != null ? o.gatherMs : 400;
  const PER_PERSON = o.perPerson || 12;          // tabs and phones one person can have open
  const TOTAL = o.total || 1000;
  const conns = new Map();                       // id -> { id, res, topics, personId }
  const pending = new Map();                     // topic -> { what: Set, from: Set }
  let timer = null;

  const beat = setInterval(() => {
    for (const c of conns.values()) write(c, ": hi\n\n");
  }, HEARTBEAT_MS);
  if (beat.unref) beat.unref();

  function write(c, text) {
    try { c.res.write(text); } catch (e) { drop(c.id); }
  }
  function drop(id) { conns.delete(id); }

  // A page asks to listen. Returns false (and answers the request) if it can't.
  function open(req, res, topics, personId) {
    const list = [...new Set(String(topics || "").split(",").map(s => s.trim()).filter(Boolean))];
    if (!list.length || list.length > 4 || !list.every(t => TOPIC_RE.test(t))) {
      res.writeHead(400, { "Content-Type": "text/plain" }); res.end("bad topics"); return false;
    }
    let mine = 0;
    for (const c of conns.values()) if (c.personId === personId) mine++;
    if (mine >= PER_PERSON || conns.size >= TOTAL) {
      res.writeHead(503, { "Content-Type": "text/plain", "Retry-After": "30" }); res.end("busy"); return false;
    }
    const c = { id: crypto.randomBytes(9).toString("base64url"), res, topics: new Set(list), personId };
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"          // proxies: don't hold the notes back
    });
    if (res.flushHeaders) res.flushHeaders();
    if (req.socket && req.socket.setNoDelay) req.socket.setNoDelay(true);
    if (req.socket && req.socket.setTimeout) req.socket.setTimeout(0);
    conns.set(c.id, c);
    // retry: how soon the browser reconnects if the line drops
    write(c, `retry: 3000\nevent: hello\ndata: ${JSON.stringify({ id: c.id })}\n\n`);
    const bye = () => drop(c.id);
    req.on("close", bye); res.on("close", bye); res.on("error", bye);
    return true;
  }

  // Something changed. `what`: "parts" (answers, names, cards), "comments",
  // or "big" (the plan was deleted or decided: the page offers to reload).
  // `from` is the connection of whoever made the change: their page already
  // shows it, so they're skipped when they're the only one who changed it.
  function touch(topic, what, from) {
    if (topic !== "*" && !TOPIC_RE.test(topic)) return;
    let p = pending.get(topic);
    if (!p) { p = { what: new Set(), from: new Set() }; pending.set(topic, p); }
    p.what.add(what || "parts");
    p.from.add(from || "?");
    if (!timer) {
      timer = setTimeout(flush, GATHER_MS);
      if (timer.unref) timer.unref();
    }
  }
  function flush() {
    timer = null;
    const batch = [...pending.entries()];
    pending.clear();
    for (const [topic, p] of batch) {
      const skip = p.from.size === 1 ? [...p.from][0] : null;
      const text = `event: change\ndata: ${JSON.stringify({ t: topic, w: [...p.what] })}\n\n`;
      for (const c of conns.values()) {
        if (c.id === skip) continue;
        if (topic === "*" || c.topics.has(topic)) write(c, text);
      }
    }
  }

  // "Sebastian is typing": straight through, to everyone else on that page.
  function typing(topic, data, from) {
    if (!TOPIC_RE.test(topic)) return;
    const text = `event: typing\ndata: ${JSON.stringify({ t: topic, ...data })}\n\n`;
    for (const c of conns.values()) if (c.id !== from && c.topics.has(topic)) write(c, text);
  }

  function close() {
    clearInterval(beat);
    if (timer) clearTimeout(timer);
    for (const c of conns.values()) { try { c.res.end(); } catch (e) {} }
    conns.clear();
  }

  return { open, touch, typing, flush, close, size: () => conns.size, TOPIC_RE };
}

module.exports = { makeHub, TOPIC_RE };
