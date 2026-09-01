/* ============================================================================
   FISHERMAN'S VILLAGE — shared simulation
   Loaded by BOTH the browser client and the Node server. Nothing in here may
   touch the DOM, canvas, or window. Keeping one copy is the whole point: the
   server is authoritative in multiplayer, the client runs the same code for
   single player, and tuning a constant changes both at once.
   ========================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SIM = factory();
})(typeof self !== "undefined" ? self : this, function () {

  const C = {
    WORLD_W: 3200,
    GROUND: 358,
    GRASS_TOP: 252,
    CH_H: 104,
    TREE_H: 168,
    CAN_H: 26,

    SPEED: 132,
    TREE_RANGE: 62,
    SPLASH_RANGE: 95,
    SHAKE_WINDUP: 650,
    TREE_COOL: 9000,
    CAN_RESPAWN: 7000,
    THROW_SPEED: 330,
    HITS_TO_WIN: 3,
    HIT_STUN: 900,

    TREE_COUNT: 7,
    WILL_FIRST: [9000, 15000],
    WILL_AGAIN: [15000, 24000],
    WILL_LIFE: 8200
  };

  const WILL_LINES = [
    "How old are you guys?",
    "I'll be downtown if you wanna come say hi.",
    "Is this really your anniversary?",
    "Are you okay with spicy food?"
  ];

  // Seeded RNG so the server and client lay out the identical park from a
  // single number, instead of shipping every tree and can position.
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeActor(role, x) {
    return {
      role, x, facing: 1, moving: false, anim: 0, hits: 0,
      stun: 0, holding: false, shaking: 0, shakeTree: -1, hitFlash: 0,
      in: { l: false, r: false, a: false, aEdge: false }
    };
  }

  function newWorld(seed) {
    const R = rng(seed || 1);
    const trees = [];
    const n = C.TREE_COUNT;
    for (let i = 0; i < n; i++) {
      trees.push({
        x: 260 + i * (C.WORLD_W - 520) / (n - 1) + (i % 2 ? 40 : -30),
        water: true, cool: 0, shake: 0, variant: i % 3 === 2 ? "B" : "A"
      });
    }
    const cans = [];
    trees.forEach((t, i) => {
      cans.push({ home: t.x - 46, x: t.x - 46, gone: false, t: 0 });
      if (i % 2 === 0) cans.push({ home: t.x + 52, x: t.x + 52, gone: false, t: 0 });
    });
    cans.push({ home: 150, x: 150, gone: false, t: 0 });
    cans.push({ home: C.WORLD_W - 160, x: C.WORLD_W - 160, gone: false, t: 0 });

    return {
      seed: seed || 1, R,
      trees, cans,
      gin: makeActor("gin", 420),
      emily: makeActor("emily", C.WORLD_W - 420),
      shots: [], drops: [], splashes: [],
      will: null,
      willTimer: C.WILL_FIRST[0] + R() * (C.WILL_FIRST[1] - C.WILL_FIRST[0]),
      over: false, winner: null, t: 0,
      botCool: 0
    };
  }

  function nearestTree(W, x, needWater) {
    let best = -1, bd = 1e9;
    W.trees.forEach((t, i) => {
      if (needWater && (!t.water || t.cool > 0)) return;
      const d = Math.abs(t.x - x);
      if (d < bd) { bd = d; best = i; }
    });
    return { i: best, d: bd };
  }

  function tryShake(W, a) {
    if (a.role !== "gin" || a.stun > 0 || a.shaking > 0) return;
    const { i, d } = nearestTree(W, a.x, true);
    if (i < 0 || d > C.TREE_RANGE) return;
    a.shaking = C.SHAKE_WINDUP; a.shakeTree = i;
    W.trees[i].shake = C.SHAKE_WINDUP;
  }
  function tryThrow(W, a) {
    if (a.role !== "emily" || a.stun > 0 || !a.holding) return;
    a.holding = false;
    W.shots.push({
      x: a.x + a.facing * 16, y: C.GROUND - 62,
      vx: a.facing * C.THROW_SPEED, vy: -46, spin: 0
    });
  }
  function doAction(W, a) { a.role === "gin" ? tryShake(W, a) : tryThrow(W, a); }

  function registerHit(W, target) {
    if (W.over || target.stun > 0) return;
    const other = target === W.gin ? W.emily : W.gin;
    other.hits++;
    target.stun = C.HIT_STUN;
    target.hitFlash = 420;
    if (other.hits >= C.HITS_TO_WIN) { W.over = true; W.winner = other.role; }
  }

  /* ---------- bot ---------- */
  function botThink(W, role, dt) {
    const b = W[role];
    const target = W[role === "gin" ? "emily" : "gin"];
    b.in.l = b.in.r = false; b.in.aEdge = false;
    if (b.stun > 0) return;

    W.botCool -= dt;
    let want = 0, act = false;

    if (b.role === "gin") {
      // Camp the loaded tree nearest HER, not the one nearest me -- she has to
      // come to the trees for cans anyway, so waiting where she's headed is
      // far more threatening than chasing her around the park.
      let ti = -1, td = 1e9;
      W.trees.forEach((t, i) => {
        if (!t.water || t.cool > 0) return;
        const d = Math.abs(t.x - target.x);
        if (d < td) { td = d; ti = i; }
      });
      if (ti >= 0) {
        const t = W.trees[ti];
        const myD = Math.abs(t.x - b.x);
        const herD = Math.abs(target.x - t.x);
        if (myD <= C.TREE_RANGE - 10 && herD < 48) act = true;
        else if (myD > C.TREE_RANGE - 14) want = Math.sign(t.x - b.x);
        else want = 0;
      } else want = Math.sign(target.x - b.x);
    } else {
      if (!b.holding) {
        let best = null, bd = 1e9;
        W.cans.forEach(c => {
          if (c.gone) return;
          const d = Math.abs(c.x - b.x);
          if (d < bd) { bd = d; best = c; }
        });
        if (best) want = Math.sign(best.x - b.x);
      } else {
        // a thrown can only carries ~190px, so close inside that before letting go
        const d = Math.abs(target.x - b.x);
        if (d > 150) want = Math.sign(target.x - b.x);
        else if (d < 60) want = -Math.sign(target.x - b.x);
        else act = true;
      }
    }

    if (W.botCool <= 0 && W.R() < 0.04) { want = 0; W.botCool = 260; }
    if (W.will && Math.abs(W.will.x - b.x) < 120) want = Math.sign(b.x - W.will.x) || 1;

    if (want < 0) b.in.l = true;
    if (want > 0) b.in.r = true;
    if (act) b.in.aEdge = true;
  }

  /* ---------- Will ---------- */
  function spawnWill(W) {
    const fromLeft = W.R() < 0.5;
    W.will = {
      x: fromLeft ? -120 : C.WORLD_W + 120,
      y: 90,
      dir: fromLeft ? 1 : -1,
      life: C.WILL_LIFE,
      bob: 0,
      lineIdx: Math.floor(W.R() * WILL_LINES.length)
    };
  }
  function updateWill(W, dt) {
    if (!W.will) {
      W.willTimer -= dt;
      if (W.willTimer <= 0) spawnWill(W);
      return;
    }
    const w = W.will;
    w.life -= dt; w.bob += dt / 1000;
    const t = Math.abs(W.gin.x - w.x) < Math.abs(W.emily.x - w.x) ? W.gin : W.emily;
    const dx = t.x - w.x;
    w.x += Math.sign(dx) * Math.min(Math.abs(dx), 168 * dt / 1000);
    const wantY = C.GROUND - C.CH_H - 8;
    w.y += (wantY - w.y) * Math.min(1, dt / 900);
    w.y += Math.sin(w.bob * 3.1) * 6 * dt / 100;

    [W.gin, W.emily].forEach(p => {
      if (Math.abs(p.x - w.x) < 34 && Math.abs((C.GROUND - C.CH_H / 2) - w.y) < 82) {
        // scoop and fling somewhere random
        p.x = 140 + W.R() * (C.WORLD_W - 280);
        p.stun = 520;
        p.holding = p.holding && W.R() < 0.5;
        p.shaking = 0;
        if (p.shakeTree >= 0 && W.trees[p.shakeTree]) W.trees[p.shakeTree].shake = 0;
        p.shakeTree = -1;
      }
    });

    if (w.life <= 0) {
      W.will = null;
      W.willTimer = C.WILL_AGAIN[0] + W.R() * (C.WILL_AGAIN[1] - C.WILL_AGAIN[0]);
    }
  }

  /* ---------- one tick ---------- */
  function step(W, dt) {
    if (W.over) return;
    W.t += dt;

    [W.gin, W.emily].forEach(p => {
      if (p.stun > 0) { p.moving = false; p.in.aEdge = false; return; }
      const want = (p.in.r ? 1 : 0) - (p.in.l ? 1 : 0);
      p.moving = want !== 0;
      if (want) p.facing = want;
      p.x = Math.max(60, Math.min(C.WORLD_W - 60, p.x + want * C.SPEED * dt / 1000));
      if (p.in.aEdge) { doAction(W, p); p.in.aEdge = false; }
    });

    [W.gin, W.emily].forEach(p => {
      if (p.stun > 0) p.stun -= dt;
      if (p.hitFlash > 0) p.hitFlash -= dt;
      if (p.moving) p.anim += dt;
      if (p.shaking > 0) {
        p.shaking -= dt;
        if (p.shaking <= 0) {
          const t = W.trees[p.shakeTree];
          if (t) {
            t.water = false; t.cool = C.TREE_COOL; t.shake = 0;
            for (let i = 0; i < 7; i++)
              W.drops.push({
                x: t.x - 34 + W.R() * 68,
                y: C.GROUND - C.TREE_H + 40,
                vy: 240 + W.R() * 80,
                tree: p.shakeTree
              });
          }
          p.shakeTree = -1;
        }
      }
    });

    W.trees.forEach(t => {
      if (t.cool > 0) { t.cool -= dt; if (t.cool <= 0) t.water = true; }
      if (t.shake > 0) t.shake -= dt;
    });

    W.cans.forEach(c => {
      if (c.gone) { c.t -= dt; if (c.t <= 0) { c.gone = false; c.x = c.home; } return; }
      if (!W.emily.holding && W.emily.stun <= 0 && Math.abs(W.emily.x - c.x) < 26) {
        c.gone = true; c.t = C.CAN_RESPAWN; W.emily.holding = true;
      }
    });

    for (let i = W.shots.length - 1; i >= 0; i--) {
      const s = W.shots[i];
      s.x += s.vx * dt / 1000; s.y += s.vy * dt / 1000;
      s.vy += 520 * dt / 1000; s.spin += dt / 60;
      if (Math.abs(s.x - W.gin.x) < 24 && s.y > C.GROUND - C.CH_H && s.y < C.GROUND) {
        registerHit(W, W.gin); W.shots.splice(i, 1); continue;
      }
      if (s.y > C.GROUND || s.x < 0 || s.x > C.WORLD_W) W.shots.splice(i, 1);
    }

    for (let i = W.drops.length - 1; i >= 0; i--) {
      const d = W.drops[i];
      d.y += d.vy * dt / 1000; d.vy += 400 * dt / 1000;
      if (d.y >= C.GROUND - 6) {
        W.splashes.push({ x: d.x, y: C.GROUND - 6, t: 360 });
        const t = W.trees[d.tree];
        if (t && Math.abs(W.emily.x - t.x) < C.SPLASH_RANGE) registerHit(W, W.emily);
        W.drops.splice(i, 1);
      }
    }
    for (let i = W.splashes.length - 1; i >= 0; i--) {
      W.splashes[i].t -= dt;
      if (W.splashes[i].t <= 0) W.splashes.splice(i, 1);
    }

    updateWill(W, dt);
  }

  /* ---------- wire format ----------
     Compact snapshot: arrays not objects, positions rounded. Two players at
     20Hz, so this stays tiny -- but there's no reason to send 3 decimals of
     a pixel coordinate. */
  function encode(W) {
    const a = p => [Math.round(p.x), p.facing, p.moving ? 1 : 0, Math.round(p.stun),
                    Math.round(p.shaking), p.holding ? 1 : 0, p.hits, Math.round(p.hitFlash),
                    Math.round(p.anim)];
    return {
      g: a(W.gin),
      e: a(W.emily),
      tr: W.trees.map(t => [t.water ? 1 : 0, Math.round(t.cool), Math.round(t.shake)]),
      cn: W.cans.map(c => c.gone ? 0 : 1),
      sh: W.shots.map(s => [Math.round(s.x), Math.round(s.y), +s.spin.toFixed(2)]),
      dr: W.drops.map(d => [Math.round(d.x), Math.round(d.y)]),
      sp: W.splashes.map(s => [Math.round(s.x), Math.round(s.y), Math.round(s.t)]),
      wl: W.will ? [Math.round(W.will.x), Math.round(W.will.y), W.will.dir, W.will.lineIdx] : null,
      ov: W.over ? 1 : 0,
      wn: W.winner
    };
  }
  function apply(W, s) {
    const put = (p, v) => {
      p.x = v[0]; p.facing = v[1]; p.moving = !!v[2]; p.stun = v[3];
      p.shaking = v[4]; p.holding = !!v[5]; p.hits = v[6]; p.hitFlash = v[7];
      p.anim = v[8];
    };
    put(W.gin, s.g); put(W.emily, s.e);
    s.tr.forEach((t, i) => {
      if (!W.trees[i]) return;
      W.trees[i].water = !!t[0]; W.trees[i].cool = t[1]; W.trees[i].shake = t[2];
    });
    s.cn.forEach((c, i) => { if (W.cans[i]) W.cans[i].gone = !c; });
    W.shots = s.sh.map(v => ({ x: v[0], y: v[1], spin: v[2], vx: 0, vy: 0 }));
    W.drops = s.dr.map(v => ({ x: v[0], y: v[1], vy: 0, tree: 0 }));
    W.splashes = s.sp.map(v => ({ x: v[0], y: v[1], t: v[2] }));
    W.will = s.wl ? { x: s.wl[0], y: s.wl[1], dir: s.wl[2], lineIdx: s.wl[3], bob: 0, life: 1 } : null;
    W.over = !!s.ov; W.winner = s.wn;
  }

  return { C, WILL_LINES, rng, newWorld, step, botThink, doAction, nearestTree, encode, apply };
});
