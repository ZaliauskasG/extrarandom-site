/* ============================================================================
   Pick Sheet Converter - engine
   A browser port of football_pool.py. Every rule, threshold and tie-break
   here mirrors the Python version, which was verified sheet by sheet against
   the Week 2 and Week 3 packets; if you change one, change both.

   Needs these globals, loaded by the page: cv (OpenCV.js), Tesseract,
   ExcelJS, and a pdfjsLib passed in to convert().
   ========================================================================== */
(function (global) {
"use strict";

const DPI = 200;
const TEAMS = {
  "Arizona": "Ari", "Atlanta": "Atl", "Baltimore": "Bal", "Buffalo": "Buf",
  "Carolina": "Car", "Chicago": "Chi", "Cincinnati": "Cin", "Cleveland": "Cle",
  "Dallas": "Dal", "Denver": "Den", "Detroit": "Det", "Green Bay": "GB",
  "Houston": "Hou", "Indianapolis": "Ind", "Jacksonville": "Jax",
  "Kansas City": "KC", "Las Vegas": "LV", "LA Chargers": "LAC",
  "LA Rams": "LAR", "Miami": "Mia", "Minnesota": "Min", "New England": "NE",
  "New Orleans": "NO", "NY Giants": "NYG", "NY Jets": "NYJ",
  "Philadelphia": "Phi", "Pittsburgh": "Pit", "San Francisco": "SF",
  "Seattle": "Sea", "Tampa Bay": "TB", "Tennessee": "Ten", "Washington": "Was",
};
const DAYS = { monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu",
               friday: "Fri", saturday: "Sat", sunday: "Sun" };
const NICKNAMES = [
  ["mike","michael","mikey","mick"], ["chris","christopher","topher"],
  ["bill","billy","will","william","willy","liam"], ["bob","bobby","rob","robert","robbie","bert"],
  ["andy","andrew","drew"], ["dave","david","davey"], ["steve","steven","stephen","stevie"],
  ["jim","jimmy","james","jamie"], ["tom","tommy","thomas"], ["joe","joey","joseph"],
  ["liz","lizzie","beth","eliza","elizabeth","betsy"], ["kate","katie","kathy","katherine","catherine"],
  ["jon","john","johnny","jonathan"], ["nick","nicky","nicholas"], ["tony","anthony"],
  ["dan","danny","daniel"], ["matt","matthew"], ["pam","pamela"], ["sam","sammy","samuel","samantha"],
  ["ed","eddie","edward"], ["phil","phillip","philip"], ["eli","elijah","elias"],
  ["jess","jessie","jessica"], ["mel","melanie"], ["alex","alexander","alexandra"],
].map(g => new Set(g));

const MARK = 0.055, SOLID = 0.50, CLEAR = 3.0;

/* ======================================================= python parity ==== */
// difflib.SequenceMatcher(None, a, b).ratio() for short strings (no autojunk)
function ratio(a, b) {
  const la = a.length, lb = b.length;
  if (!la && !lb) return 1;
  const b2j = new Map();
  for (let j = 0; j < lb; j++) { if (!b2j.has(b[j])) b2j.set(b[j], []); b2j.get(b[j]).push(j); }
  const longest = (alo, ahi, blo, bhi) => {
    let bi = alo, bj = blo, bs = 0, j2len = new Map();
    for (let i = alo; i < ahi; i++) {
      const nj = new Map();
      for (const j of (b2j.get(a[i]) || [])) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        nj.set(j, k);
        if (k > bs) { bi = i - k + 1; bj = j - k + 1; bs = k; }
      }
      j2len = nj;
    }
    return [bi, bj, bs];
  };
  let matches = 0;
  const q = [[0, la, 0, lb]];
  while (q.length) {
    const [alo, ahi, blo, bhi] = q.pop();
    const [i, j, k] = longest(alo, ahi, blo, bhi);
    if (k) {
      matches += k;
      if (alo < i && blo < j) q.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) q.push([i + k, ahi, j + k, bhi]);
    }
  }
  return 2 * matches / (la + lb);
}
// difflib.get_close_matches: score desc, ties by string desc (heapq.nlargest)
function closeMatches(word, poss, n, cutoff) {
  const out = [];
  for (const x of poss) { const s = ratio(word, x); if (s >= cutoff) out.push([s, x]); }
  out.sort((p, q) => q[0] - p[0] || (q[1] > p[1] ? 1 : q[1] < p[1] ? -1 : 0));
  return out.slice(0, n).map(p => p[1]);
}
// Python round(): halves go to the even neighbour
function pyRound(x) {
  const f = Math.floor(x), d = x - f;
  if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}
function median(a) {
  const s = [...a].sort((p, q) => p - q), n = s.length;
  if (!n) return 0;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
// Counter.most_common(1): highest count, first-seen wins ties
function mostCommon(vals) {
  const c = new Map();
  for (const v of vals) c.set(v, (c.get(v) || 0) + 1);
  let best = null, bn = 0;
  for (const [v, n] of c) if (n > bn) { best = v; bn = n; }
  return [best, bn];
}
const pyRepr = s => (s.includes("'") && !s.includes('"')) ? `"${s}"` : `'${s.replace(/'/g, "\\'")}'`;
const trunc = Math.trunc;
function maxBy(arr, f) { let b = null, bv = -Infinity; for (const x of arr) { const v = f(x); if (v > bv) { b = x; bv = v; } } return b; }

/* ======================================================= images ========== */
// A gray image is {w, h, d: Uint8Array}. Colour pages stay as canvases.
function grayFromCanvas(canvas) {
  const w = canvas.width, h = canvas.height;
  const px = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const d = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < d.length; i += 4, j++)
    d[j] = (px[i] * 19595 + px[i + 1] * 38470 + px[i + 2] * 7471 + 0x8000) >> 16;   // PIL "L"
  return { w, h, d };
}
function cropCanvas(src, x0, y0, x1, y1) {
  const W = src.width, H = src.height;
  x0 = trunc(Math.max(0, x0)); y0 = trunc(Math.max(0, y0));
  x1 = trunc(Math.min(W, x1)); y1 = trunc(Math.min(H, y1));
  const c = document.createElement("canvas");
  if (x1 <= x0 || y1 <= y0) {
    c.width = c.height = 4;
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, 4, 4);
    return c;
  }
  c.width = x1 - x0; c.height = y1 - y0;
  c.getContext("2d").drawImage(src, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
  return c;
}
function toMat(g) { const m = new cv.Mat(g.h, g.w, cv.CV_8UC1); m.data.set(g.d); return m; }
function fromMat(m) { return { w: m.cols, h: m.rows, d: new Uint8Array(m.data) }; }
function withMat(g, fn) { const s = toMat(g), t = new cv.Mat(); try { fn(s, t); return fromMat(t); } finally { s.delete(); t.delete(); } }
const rect = (w, h) => cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(w, h));
function morph(g, op, kw, kh) { const k = rect(kw, kh); try { return withMat(g, (s, t) => cv.morphologyEx(s, t, op, k)); } finally { k.delete(); } }
const opening = (g, kw, kh) => morph(g, cv.MORPH_OPEN, kw, kh);
function dilate(g, kw, kh) { const k = rect(kw, kh); try { return withMat(g, (s, t) => cv.dilate(s, t, k)); } finally { k.delete(); } }
const otsu = (g, inv) => withMat(g, (s, t) => cv.threshold(s, t, 0, 255, (inv ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY) + cv.THRESH_OTSU));
const binarize = g => withMat(g, (s, t) => cv.adaptiveThreshold(s, t, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, 41, 18));
const resizeCubic = (g, f) => withMat(g, (s, t) => cv.resize(s, t, new cv.Size(0, 0), f, f, cv.INTER_CUBIC));
function subtract(a, b) { const d = new Uint8Array(a.d.length); for (let i = 0; i < d.length; i++) d[i] = Math.max(0, a.d[i] - b.d[i]); return { w: a.w, h: a.h, d }; }
function orImg(a, b) { const d = new Uint8Array(a.d.length); for (let i = 0; i < d.length; i++) d[i] = a.d[i] | b.d[i]; return { w: a.w, h: a.h, d }; }
function fixedThresh(g, t) { const d = new Uint8Array(g.d.length); for (let i = 0; i < d.length; i++) d[i] = g.d[i] > t ? 255 : 0; return { w: g.w, h: g.h, d }; }
function invert(g) { const d = new Uint8Array(g.d.length); for (let i = 0; i < d.length; i++) d[i] = 255 - g.d[i]; return { w: g.w, h: g.h, d }; }
function sub(g, x0, y0, x1, y1) {           // numpy-style slice, clamped
  x0 = Math.max(0, Math.min(g.w, x0)); x1 = Math.max(x0, Math.min(g.w, x1));
  y0 = Math.max(0, Math.min(g.h, y0)); y1 = Math.max(y0, Math.min(g.h, y1));
  const w = x1 - x0, h = y1 - y0, d = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) d.set(g.d.subarray((y0 + y) * g.w + x0, (y0 + y) * g.w + x0 + w), y * w);
  return { w, h, d };
}
function border(g, p, v) {
  const w = g.w + 2 * p, h = g.h + 2 * p, d = new Uint8Array(w * h).fill(v);
  for (let y = 0; y < g.h; y++) d.set(g.d.subarray(y * g.w, (y + 1) * g.w), (y + p) * w + p);
  return { w, h, d };
}
function fracBelow(g, t) { let n = 0; for (let i = 0; i < g.d.length; i++) if (g.d[i] < t) n++; return g.d.length ? n / g.d.length : 0; }
function fracOn(g) { let n = 0; for (let i = 0; i < g.d.length; i++) if (g.d[i] > 0) n++; return g.d.length ? n / g.d.length : 0; }
function inkBox(g) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) if (g.d[y * g.w + x] > 0) {
    n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { n, x0, y0, x1, y1 };
}
function toCanvas(g) {
  const c = document.createElement("canvas"); c.width = g.w; c.height = g.h;
  const ctx = c.getContext("2d"), im = ctx.createImageData(g.w, g.h);
  for (let i = 0, j = 0; j < g.d.length; i += 4, j++) { im.data[i] = im.data[i + 1] = im.data[i + 2] = g.d[j]; im.data[i + 3] = 255; }
  ctx.putImageData(im, 0, 0);
  return c;
}
function thumb(canvas, maxW) {
  let w = canvas.width, h = canvas.height;
  if (w > maxW) { h = trunc(h * maxW / w); w = maxW; }
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d"); ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, w, h);
  return { data: c.toDataURL("image/png"), w, h };
}

/* ======================================================= geometry ======== */
function dropBigBlobs(mask) {
  const m = toMat(mask), lab = new cv.Mat(), st = new cv.Mat(), ce = new cv.Mat();
  try {
    const n = cv.connectedComponentsWithStats(m, lab, st, ce, 8, cv.CV_32S);
    const W = mask.w, H = mask.h, limit = 0.09 * W, drop = new Uint8Array(n);
    for (let i = 1; i < n; i++) {
      const x = st.intAt(i, 0), y = st.intAt(i, 1), bw = st.intAt(i, 2), bh = st.intAt(i, 3);
      if (bw > limit || bh > limit || x === 0 || y === 0 || x + bw >= W || y + bh >= H) drop[i] = 1;
    }
    const L = lab.data32S, d = new Uint8Array(mask.d);
    for (let i = 0; i < d.length; i++) if (drop[L[i]]) d[i] = 0;
    return { w: W, h: H, d };
  } finally { m.delete(); lab.delete(); st.delete(); ce.delete(); }
}
function boxCandidates(bw) {
  const w = bw.w, k = Math.max(12, trunc(w * 0.016));
  const horiz = opening(bw, k, 1), vert = opening(bw, 1, k);
  const grid = dropBigBlobs(dilate(orImg(horiz, vert), 3, 3));
  const m = toMat(grid), cs = new cv.MatVector(), hi = new cv.Mat(), out = [];
  try {
    cv.findContours(m, cs, hi, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < cs.size(); i++) {
      const c = cs.get(i), r = cv.boundingRect(c); c.delete();
      const { x, y, width: bw_, height: bh } = r;
      if (!(0.012 * w < bw_ && bw_ < 0.06 * w && 0.72 < bw_ / bh && bw_ / bh < 1.38)) continue;
      // a checkbox is closed on all four sides; the bold first letter of a
      // day header ("T", "M") or a big typed digit is not
      const e = Math.max(3, trunc(Math.min(bw_, bh) / 5));
      const colAny = (img, y0, y1) => { let n = 0; for (let xx = x; xx < x + bw_; xx++) { for (let yy = y0; yy < y1; yy++) if (img.d[yy * w + xx]) { n++; break; } } return n / bw_; };
      const rowAny = (img, x0, x1) => { let n = 0; for (let yy = y; yy < y + bh; yy++) { for (let xx = x0; xx < x1; xx++) if (img.d[yy * w + xx]) { n++; break; } } return n / bh; };
      const top = colAny(horiz, y, y + e), bot = colAny(horiz, y + bh - e, y + bh);
      const lft = rowAny(vert, x, x + e), rgt = rowAny(vert, x + bw_ - e, x + bw_);
      if (Math.min(top, bot, lft, rgt) >= 0.55) out.push([x + bw_ / 2, y + bh / 2, bw_, bh]);
    }
  } finally { m.delete(); cs.delete(); hi.delete(); }
  return out;
}
function theilSen(t, v) {
  if (t.length < 2) return [0, v.length ? v.reduce((p, q) => p + q, 0) / v.length : 0];
  const s = [];
  for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++)
    if (Math.abs(t[j] - t[i]) > 1e-6) s.push((v[j] - v[i]) / (t[j] - t[i]));
  const a = s.length ? median(s) : 0;
  return [a, median(v.map((vv, i) => vv - a * t[i]))];
}
function detectGames(gray) {
  const bw = binarize(gray);
  let cand = boxCandidates(bw);
  if (cand.length < 6) return null;
  const size = median(cand.map(c => c[2]));
  cand = cand.filter(c => 0.7 * size < c[2] && c[2] < 1.4 * size);
  const xs = [...cand].sort((p, q) => p[0] - q[0]);
  let cols = [], cur = [xs[0]];
  for (const c of xs.slice(1)) {
    if (c[0] - cur[cur.length - 1][0] > size * 1.5) { cols.push(cur); cur = [c]; } else cur.push(c);
  }
  cols.push(cur);
  cols = cols.map((c, i) => [c, i]).sort((p, q) => q[0].length - p[0].length || p[1] - q[1]).slice(0, 2).map(p => p[0]);
  const meanX = c => c.reduce((s, b) => s + b[0], 0) / c.length;
  cols.sort((p, q) => meanX(p) - meanX(q));
  if (cols.length < 2 || Math.min(...cols.map(c => c.length)) < 3) return null;

  const fits = [];
  for (let i = 0; i < 2; i++) {
    const [a, b] = theilSen(cols[i].map(c => c[1]), cols[i].map(c => c[0]));
    cols[i] = cols[i].filter(c => Math.abs(c[0] - (a * c[1] + b)) < 0.3 * size).sort((p, q) => p[1] - q[1]);
    fits.push([a, b]);
  }
  const [left, right] = cols;
  if (!left.length || !right.length) return null;

  // the straight-line map from left-box height to partner height that lines
  // up the most boxes; absorbs rotation and a phone photo's keystone
  const yl = left.map(c => c[1]), yr = right.map(c => c[1]), tol = 0.45 * size;
  let best = [-1, 0, 1, 0];
  for (let i1 = 0; i1 < yl.length; i1++) for (let i2 = i1 + 2; i2 < yl.length; i2++)
    for (let j1 = 0; j1 < yr.length; j1++) {
      const j2 = j1 + (i2 - i1);
      if (j2 >= yr.length) break;
      const a = (yr[j2] - yr[j1]) / (yl[i2] - yl[i1]);
      if (!(0.8 < a && a < 1.25)) continue;
      const b = yr[j1] - a * yl[i1];
      let inl = 0, score = 0;
      for (const y of yl) {
        let e = Infinity; for (const r of yr) e = Math.min(e, Math.abs(a * y + b - r));
        if (e < tol) { inl++; score += e; }
      }
      if (inl > best[0] || (inl === best[0] && score < best[1])) best = [inl, score, a, b];
    }
  const [, , ma, mb] = best;
  const xlAt = y => fits[0][0] * y + fits[0][1], xrAt = y => fits[1][0] * y + fits[1][1];
  let rows = []; const used = new Set();
  for (const lb of left) {
    const ey = ma * lb[1] + mb;
    let bd = 1e9, bj = null;
    right.forEach((rb, j) => { if (used.has(j)) return; const d = Math.abs(rb[1] - ey); if (d < bd) { bd = d; bj = j; } });
    if (bj !== null && bd < tol) { used.add(bj); const rb = right[bj]; rows.push([[lb[0], lb[1], lb[2]], [rb[0], rb[1], rb[2]], null]); }
    else rows.push([[lb[0], lb[1], size], [xrAt(ey), ey, size], "R"]);
  }
  right.forEach((rb, j) => {
    if (used.has(j)) return;
    const ey = (rb[1] - mb) / ma;
    rows.push([[xlAt(ey), ey, size], [rb[0], rb[1], rb[2]], "L"]);
  });
  // an inferred box still leaves its printed border; blank paper means the
  // "row" was a false detection
  const borderInk = ([cx, cy, sz]) => {
    const roi = sub(bw, trunc(cx - sz / 2), trunc(cy - sz / 2), trunc(cx + sz / 2), trunc(cy + sz / 2));
    if (!roi.d.length) return 0;
    const e = Math.max(2, trunc(sz * 0.22));
    for (let y = e; y < roi.h - e; y++) for (let x = e; x < roi.w - e; x++) roi.d[y * roi.w + x] = 0;
    return fracOn(roi);
  };
  rows = rows.filter(r => !r[2] || borderInk(r[2] === "L" ? r[0] : r[1]) > 0.08);
  rows.sort((p, q) => p[1][1] - q[1][1]);
  return { rows, size, bw };
}

/* ======================================================= marks =========== */
function fillRatio(bw, [cx, cy, s]) {
  const m = s * 0.24;
  const roi = sub(bw, trunc(cx - s / 2 + m), trunc(cy - s / 2 + m), trunc(cx + s / 2 - m), trunc(cy + s / 2 - m));
  return roi.d.length ? fracOn(roi) : 0;
}
function decide(lf, rf) {
  const lm = lf >= MARK, rm = rf >= MARK;
  if (lm && !rm) return ["L", null];
  if (rm && !lm) return ["R", null];
  if (!lm && !rm) {
    const hi = lf > rf ? "L" : "R";
    if (Math.max(lf, rf) >= MARK * 0.5 && Math.max(lf, rf) >= CLEAR * Math.max(Math.min(lf, rf), 0.004))
      return [hi, "Very light mark - guessed the darker box"];
    return [null, "No mark found in either box"];
  }
  const ls = lf >= SOLID, rs = rf >= SOLID;
  if (ls !== rs) return [ls ? "R" : "L", "Looks like a correction (one box scribbled out)"];
  const hi = Math.max(lf, rf), lo = Math.min(lf, rf), side = lf > rf ? "L" : "R";
  if (hi >= CLEAR * lo) return [side, "Stray mark in the other box - picked the stronger one"];
  return [side, "Both boxes marked - best guess only"];
}

/* ======================================================= OCR ============= */
class OcrPool {
  constructor(n) { this.n = n; this.workers = []; this.next = 0; }
  async init(paths) {
    for (let i = 0; i < this.n; i++) {
      const w = await Tesseract.createWorker("eng", 1, paths);
      this.workers.push({ w, chain: Promise.resolve() });
    }
  }
  run(img, psm, whitelist) {
    const slot = this.workers[this.next++ % this.workers.length];
    const job = slot.chain.then(async () => {
      await slot.w.setParameters({ tessedit_pageseg_mode: String(psm), tessedit_char_whitelist: whitelist || "" });
      return (await slot.w.recognize(img)).data;
    });
    slot.chain = job.catch(() => {});
    return job;
  }
  async terminate() { for (const s of this.workers) await s.w.terminate(); this.workers = []; }
}
let POOL = null;

async function ocr(g, psm = 7, whitelist = null) {
  const data = await POOL.run(toCanvas(g), psm, whitelist);
  const words = (data.words || []).filter(w => w.text.trim() && w.confidence >= 0);
  if (!words.length) return ["", 0];
  return [words.map(w => w.text).join(" "), words.reduce((s, w) => s + w.confidence, 0) / words.length];
}
async function ocrWords(g) {
  const data = await POOL.run(toCanvas(g), 11, null);
  return (data.words || []).filter(w => w.text.trim()).map(w => ({
    t: w.text.trim(), k: w.text.trim().toLowerCase().replace(/[^a-z]/g, ""),
    x: w.bbox.x0, y: w.bbox.y0, w: w.bbox.x1 - w.bbox.x0, h: w.bbox.y1 - w.bbox.y0,
  }));
}
const cleanForOcr = canvas => otsu(grayFromCanvas(canvas), false);

function matchTeam(text) {
  const t = text.toLowerCase().replace(/[^a-z ]/g, "").trim();
  if (!t) return null;
  const names = Object.keys(TEAMS).map(k => k.toLowerCase());
  const hit = closeMatches(t, names, 1, 0.55);
  return hit.length ? Object.keys(TEAMS).find(k => k.toLowerCase() === hit[0]) : null;
}
function splitMatchup(text) {
  const m = (" " + text + " ").match(/\s+(?:at|al|a1|af|vs\.?|v\.?|@)\s+/i);
  if (m) {
    const s = " " + text + " ";
    const a = matchTeam(s.slice(0, m.index)), h = matchTeam(s.slice(m.index + m[0].length));
    if (a && h && a !== h) return [a, h];
  }
  const toks = text.split(/\s+/).filter(Boolean);
  const names = Object.keys(TEAMS).map(k => k.toLowerCase());
  const orig = n => Object.keys(TEAMS).find(k => k.toLowerCase() === n);
  let best = [null, null], bestScore = 0;
  for (let i = 1; i < toks.length; i++) for (const skip of [0, 1]) {
    const rt = toks.slice(i + skip);
    if (!rt.length) continue;
    const left = toks.slice(0, i).join(" ").toLowerCase().replace(/[^a-z ]/g, "").trim();
    const right = rt.join(" ").toLowerCase().replace(/[^a-z ]/g, "").trim();
    const la = closeMatches(left, names, 1, 0.6), ra = closeMatches(right, names, 1, 0.6);
    if (la.length && ra.length && la[0] !== ra[0]) {
      const sc = ratio(left, la[0]) + ratio(right, ra[0]);
      if (sc > bestScore) { best = [orig(la[0]), orig(ra[0])]; bestScore = sc; }
    }
  }
  return best;
}
async function readMatchupRow(img, row, size) {
  const [[lx, ly], [rx, ry]] = row, y = (ly + ry) / 2;
  const [text] = await ocr(cleanForOcr(cropCanvas(img, lx + 0.6 * size, y - 0.75 * size, rx - 0.6 * size, y + 0.75 * size)), 7);
  const [away, home] = splitMatchup(text);
  const [tt] = await ocr(cleanForOcr(cropCanvas(img, rx + 0.8 * size, ry - 0.7 * size, rx + 7.0 * size, ry + 0.7 * size)), 7);
  const m = tt.toLowerCase().match(/(\d{1,2})\s*[:.]\s*(\d{2})\s*([ap])/);
  return { away, home, time: m ? `${parseInt(m[1], 10)}:${m[2]}${m[3]}` : null };
}
async function readDay(img, rows, i, size, spacing) {
  const [[lx, ly], [rx]] = rows[i], cy = ly - spacing;
  const [text] = await ocr(cleanForOcr(cropCanvas(img, lx - 0.8 * size, cy - 0.55 * spacing, rx - 1.2 * size, cy + 0.5 * spacing)), 7);
  // the day can be anywhere on the line; a stray mark in front must not hide it
  for (const tok of text.split(/\s+/)) {
    const w = tok.toLowerCase().replace(/[^a-z]/g, "");
    if (w.length < 5) continue;
    const hit = closeMatches(w, Object.keys(DAYS), 1, 0.6);
    if (hit.length) return DAYS[hit[0]];
  }
  return null;
}
async function readSchedule(img, det) {
  const { rows, size } = det, ys = rows.map(r => r[1][1]);
  const spacing = ys.length > 1 ? median(ys.slice(1).map((y, i) => y - ys[i])) : size * 1.6;
  const games = []; let day = null;
  for (let i = 0; i < rows.length; i++) {
    // a new day header; if unreadable, leave blank rather than carry over
    if (i === 0 || ys[i] - ys[i - 1] > 1.5 * spacing) day = await readDay(img, rows, i, size, spacing);
    games.push({ ...(await readMatchupRow(img, rows[i], size)), day });
  }
  return games;
}

/* ------------------------------------------------------- fill-in fields -- */
function stripUnderline(bw) {
  const k = Math.max(15, trunc(bw.w * 0.45));       // true underlines only, not a 4's crossbar
  return opening(bw, k, 1);
}
function prepField(canvas) {
  const g = grayFromCanvas(canvas);
  if (!g.d.length || fracBelow(g, 160) < 0.002) return null;
  let bw = otsu(g, true);
  bw = opening(subtract(bw, dilate(stripUnderline(bw), 3, 3)), 2, 2);
  const b = inkBox(bw);
  if (b.n < 12) return null;
  bw = sub(bw, b.x0 - 6 < 0 ? 0 : b.x0 - 6, b.y0 - 6 < 0 ? 0 : b.y0 - 6, b.x1 + 6, b.y1 + 6);
  bw = fixedThresh(resizeCubic(bw, 3), 127);
  return border(invert(bw), 30, 255);
}
async function ocrField(canvas, whitelist) { const g = prepField(canvas); return g ? ocr(g, 7, whitelist) : ["", 0]; }
function numberVariant(canvas, mode, scale) {
  let g = grayFromCanvas(canvas);
  if (!g.d.length || fracBelow(g, 160) < 0.002) return null;
  const bw = otsu(g, true), lines = dilate(stripUnderline(bw), 3, 3), ink = subtract(bw, lines);
  const b = inkBox(ink);
  if (b.n < 12) return null;
  const d = new Uint8Array(g.d); for (let i = 0; i < d.length; i++) if (lines.d[i]) d[i] = 255;
  g = sub({ w: g.w, h: g.h, d }, Math.max(0, b.x0 - 8), Math.max(0, b.y0 - 8), b.x1 + 8, b.y1 + 8);
  g = resizeCubic(g, scale);
  if (mode === "bin") g = otsu(g, false);
  return border(g, 30, 255);
}
// Six differently prepared reads must agree: Tesseract's own confidence is
// unreliable on small digits, and independent variants rarely agree on the
// same wrong answer. The bar here is all six, not the Python version's five:
// the browser build of Tesseract is more all-or-nothing, and on the verified
// Week 3 packet every correct read agreed 6/6 while the one wrong read (a
// scribbled-out digit before "35", read as "25") agreed 5/6.
async function readNumber(canvas, need = 6) {
  const jobs = [];
  for (const mode of ["bin", "gray"]) for (const scale of [1.5, 2, 3]) {
    const im = numberVariant(canvas, mode, scale);
    jobs.push(im ? ocr(im, 7, "0123456789").then(r => r[0].replace(/ /g, "")) : Promise.resolve(""));
  }
  const reads = await Promise.all(jobs), vals = reads.filter(Boolean);
  if (!vals.length) return [null, "", reads];
  const [top, n] = mostCommon(vals);
  if (n >= need && top[0] !== "0" && 10 <= +top && +top <= 150) return [+top, top, reads];
  return [null, top, reads];
}
function inkAmount(canvas) {
  const g = grayFromCanvas(canvas);
  if (!g.d.length) return 0;
  let bw = otsu(g, true);
  if (fracBelow(g, 160) < 0.002) return 0;
  bw = opening(subtract(bw, dilate(stripUnderline(bw), 3, 5)), 2, 2);
  return fracOn(bw);
}
const LABEL = new Set(["tiebreaker","total","points","scored","in","monday","night","football","games","game","mnf"]);
async function readFooter(img, det) {
  const W = img.width, H = img.height, size = det.size;
  const lastY = Math.max(...det.rows.map(r => r[1][1]));
  const foot = cropCanvas(img, 0, lastY + 0.9 * size, W, H);
  const words = await ocrWords(cleanForOcr(foot));
  const res = { footer: foot, name: "", nameConf: 0, nameInk: 0, tb: "", tbValue: null, tbInk: 0, tc: "", tcInk: 0, labels: true };
  const fuzzy = (key, cut) => words.filter(w => w.k && ratio(w.k, key) >= cut);
  const lowest = arr => [...arr].map((w, i) => [w, i]).sort((p, q) => q[0].y - p[0].y || p[1] - q[1]).map(p => p[0])[0] || null;

  // "Total Correct" is the steadiest anchor; "Name" sometimes reads "vame"
  const correctW = lowest(fuzzy("correct", 0.7));
  let totalW = null;
  if (correctW) totalW = maxBy(fuzzy("total", 0.7).filter(w => Math.abs(w.y - correctW.y) < 1.2 * correctW.h && w.x < correctW.x), w => w.x);
  const anchor = totalW || correctW;
  const nameW = anchor
    ? maxBy(fuzzy("name", 0.6).filter(w => Math.abs(w.y - anchor.y) < 1.5 * anchor.h && w.x < anchor.x), w => w.x)
    : (fuzzy("name", 0.75)[0] || null);
  // the tiebreaker label's wording changes between printings, so start
  // after whatever printed word ends the "Tiebreaker:" line
  const tbLine = lowest(fuzzy("tiebreaker", 0.7).filter(w => !anchor || w.y < anchor.y));
  let labelEnd = null;
  if (tbLine) {
    const cy = tbLine.y + tbLine.h / 2;
    const same = words.filter(w => Math.abs((w.y + w.h / 2) - cy) < tbLine.h && w.x >= tbLine.x && LABEL.has(w.k));
    labelEnd = maxBy(same, w => w.x + w.w) || tbLine;
  }
  if (!(nameW || totalW) && !labelEnd) { res.labels = false; return res; }

  const jobs = [];
  if (nameW || totalW) {
    const lh = (nameW || totalW).h;
    let nx0, ncy;
    if (nameW) { nx0 = nameW.x + nameW.w + 0.3 * lh; ncy = nameW.y + nameW.h / 2; }
    else { nx0 = totalW.x - 0.30 * W; ncy = totalW.y + totalW.h / 2; }
    const nx1 = totalW ? totalW.x - 0.8 * lh : nx0 + 0.32 * W;
    const nameImg = cropCanvas(foot, nx0, ncy - 2.6 * lh, nx1, ncy + 1.4 * lh);
    res.nameInk = inkAmount(nameImg);
    jobs.push(ocrField(nameImg).then(([t, c]) => { res.name = t; res.nameConf = c; }));
  } else res.nameMissing = true;
  if (labelEnd) {
    const lh = labelEnd.h, gcy = labelEnd.y + lh / 2;
    const tbImg = cropCanvas(foot, labelEnd.x + labelEnd.w + 0.2 * lh, gcy - 2.4 * lh, labelEnd.x + labelEnd.w + 0.13 * W, gcy + 1.2 * lh);
    res.tbInk = inkAmount(tbImg);
    jobs.push(readNumber(tbImg).then(([v, t, reads]) => { res.tbValue = v; res.tb = t; res.tbReads = reads; }));
  } else res.tbMissing = true;
  if (correctW) {
    const lh = correctW.h, ccy = correctW.y + lh / 2;
    const tcImg = cropCanvas(foot, correctW.x + correctW.w + 0.2 * lh, ccy - 2.4 * lh, correctW.x + correctW.w + 0.13 * W, ccy + 1.2 * lh);
    res.tcInk = inkAmount(tcImg);
    jobs.push(readNumber(tcImg, 3).then(([, t]) => { res.tc = t; }));
  }
  await Promise.all(jobs);
  return res;
}

/* ======================================================= names =========== */
const firstNameForms = n => NICKNAMES.find(g => g.has(n.toLowerCase())) || new Set([n.toLowerCase()]);
function resolveName(text, conf, roster) {
  const raw = text.replace(/\u00a9/g, "C").trim();
  let toks = raw.split(/\s+/).map(t => t.replace(/[^A-Za-z0-9]/g, "")).filter(Boolean);
  while (toks.length && !/[A-Za-z]{2}/.test(toks[0])) toks = toks.slice(1);
  if (!toks.length) return [null, false, `Couldn't read a name${raw ? ` (OCR saw ${pyRepr(raw)})` : ""}`];
  // OCR swaps lookalikes: "Vince 2" is "Vince Z" when that's a roster name
  const LOOK = { "2": "z", "5": "s", "0": "o", "1": "il", "8": "b", "6": "g", "7": "t" };
  const rset = new Set(roster.map(r => r.toLowerCase()));
  if (toks.length === 2 && /^\d$/.test(toks[1])) {
    for (const letter of (LOOK[toks[1]] || "")) if (rset.has(`${toks[0].toLowerCase()} ${letter}`)) { toks[1] = letter.toUpperCase(); break; }
  }
  let num = null, glued = false;
  if (toks.length > 1 && /^\d$/.test(toks[toks.length - 1])) num = toks.pop();
  else if (/^[A-Za-z]\d$/.test(toks[toks.length - 1]) && toks.length > 1) { const t = toks[toks.length - 1]; num = t[1]; glued = true; toks[toks.length - 1] = t[0]; }
  const label = n => !num ? n : glued ? `${n}${num}` : `${n} ${num}`;
  const squashed = new Map(roster.map(r => [r.replace(/ /g, "").toLowerCase(), r]));
  if (toks.length > 1 && /^[A-Za-z][lI|!]$/.test(toks[toks.length - 1]) && !num) {   // "Dave Bl" = "Dave B1"
    num = "1"; glued = true; toks[toks.length - 1] = toks[toks.length - 1][0];
  }
  const first = toks[0].toLowerCase(), initial = toks.length > 1 ? toks[1][0].toLowerCase() : "";
  if (toks.length === 1 && squashed.has(first))
    return [label(squashed.get(first)), conf >= 40, conf >= 40 ? null : `Low-confidence read (${pyRepr(raw)})`];

  const forms = firstNameForms(first);
  let pool = roster.filter(r => forms.has(r.split(" ")[0].toLowerCase()));
  if (pool.length) {
    const agrees = pool.filter(r => r.split(" ").length > 1 && r.split(" ")[1][0].toLowerCase() === initial);
    if (initial && agrees.length) pool = agrees;
    if (pool.length > 1) return [null, false, "Could be " + pool.join(" or ") + " - no last initial to tell them apart"];
    const exact = first === pool[0].split(" ")[0].toLowerCase();
    if (initial && agrees.length) return [label(pool[0]), true, null];
    if (!initial && exact && conf >= 40) return [label(pool[0]), true, null];
    return [label(pool[0]), false, `Best guess from a hard-to-read name (${pyRepr(raw)})`];
  }
  // no first-name match: clear winners only, since a wrong guess collides
  // with a real person's row
  const ranked = [];
  for (const r of roster) {
    const parts = r.split(" ");
    let sim = ratio(first, parts[0].toLowerCase());
    if (sim < 0.6) continue;                         // the initial may confirm a name, never invent one
    if (initial && parts.length > 1) sim += parts[1][0].toLowerCase() === initial ? 0.25 : -0.25;
    ranked.push([sim, r]);
  }
  ranked.sort((p, q) => q[0] - p[0] || (q[1] > p[1] ? 1 : q[1] < p[1] ? -1 : 0));
  if (ranked.length && ranked[0][0] >= 0.65 && (ranked.length === 1 || ranked[0][0] - ranked[1][0] >= 0.12))
    return [label(ranked[0][1]), false, `Best guess from a hard-to-read name (${pyRepr(raw)})`];
  return [null, false, `Couldn't match ${pyRepr(raw)} to anyone on the roster`];
}

/* ======================================================= workbook ======== */
const FILL = c => ({ type: "pattern", pattern: "solid", fgColor: { argb: "FF" + c } });
const YELLOW = FILL("FFFF00"), GREEN = FILL("92D050"), ORANGE = FILL("F4B183"), GREY = FILL("D9D9D9");
const THIN = { style: "thin", color: { argb: "FF000000" } };
const BOX = { left: THIN, right: THIN, top: THIN, bottom: THIN };
const colL = n => { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = trunc((n - 1) / 26); } return s; };

async function buildWorkbook(week, schedule, entries, flags, scheduleFlags) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(week ? `Week ${week}` : "Picks");
  const main = [], mon = [];
  schedule.forEach((g, i) => (g.day === "Mon" ? mon : main).push(i));
  const colOf = {}; let c = 2;
  for (const i of main) colOf[i] = c++;
  if (mon.length) c += 1;
  for (const i of mon) colOf[i] = c++;
  const ptsCol = c, winsCol = ptsCol + 2;
  const put = (r, ci, v, extra = {}) => {
    const cell = ws.getCell(r, ci);
    cell.value = v; cell.alignment = { horizontal: "center", vertical: "middle" }; cell.border = BOX;
    Object.assign(cell, extra);
    return cell;
  };
  put(1, 1, week ? `Week ${week}` : "Week", { font: { bold: true, size: 14 }, alignment: { vertical: "middle" } });
  put(3, 1, "Time", { alignment: { vertical: "middle" } });
  put(5, 1, "Winner", { alignment: { vertical: "middle" } });
  schedule.forEach((g, i) => {
    const a = TEAMS[g.away] || g.away || "?", h = TEAMS[g.home] || g.home || "?";
    const hc = put(1, colOf[i], `${a} / ${h}`);
    if (!(g.away in TEAMS && g.home in TEAMS)) { hc.fill = ORANGE; hc.note = "Couldn't read this matchup - check it on the sheet"; }
    put(3, colOf[i], [g.day, g.time].filter(Boolean).join(" "));
    put(5, colOf[i], null);
  });
  put(4, ptsCol, "Points"); put(5, ptsCol, null);
  put(1, winsCol, "Wins", { font: { bold: true, size: 14 } });
  entries.forEach((e, k) => {
    const r = 7 + k; e.xlRow = r;
    put(r, 1, e.name, { fill: YELLOW, font: { bold: true }, alignment: { vertical: "middle" } });
    e.picks.forEach((p, i) => put(r, colOf[i], p));
    put(r, ptsCol, e.points);
    const span = idx => { const a = colL(colOf[idx[0]]), b = colL(colOf[idx[idx.length - 1]]); return `SUMPRODUCT((${a}${r}:${b}${r}=${a}$5:${b}$5)*(${a}$5:${b}$5<>""))`; };
    let f = main.length ? span(main) : "0";
    if (mon.length) f += "+" + span(mon);
    put(r, winsCol, { formula: f }, { fill: GREEN, font: { bold: true } });
  });
  for (const fl of flags) {
    const e = fl.entry;
    const ci = fl.field === "Name" ? 1 : fl.field === "Tiebreaker" ? ptsCol : colOf[fl.game];
    const cell = ws.getCell(e.xlRow, ci);
    cell.fill = ORANGE; cell.note = `Page ${e.page}: ${fl.issue}`;
  }
  ws.getColumn(1).width = 18;
  for (let ci = 2; ci <= winsCol; ci++) ws.getColumn(ci).width = 10.5;
  ws.views = [{ state: "frozen", xSplit: 1, ySplit: 6 }];

  const rv = wb.addWorksheet("Review");
  ["Page", "Entry", "Field", "Read as", "Issue", "Sheet image"].forEach((h, j) => {
    const cell = rv.getCell(1, j + 1); cell.value = h; cell.font = { bold: true }; cell.fill = GREY; cell.border = BOX;
  });
  [7, 16, 12, 12, 44, 90].forEach((w, j) => { rv.getColumn(j + 1).width = w; });
  let r = 2;
  for (const s of scheduleFlags) {
    [s.page, "", "Matchup", s.read, s.issue].forEach((v, j) => { const cell = rv.getCell(r, j + 1); cell.value = v; cell.border = BOX; cell.alignment = { vertical: "top", wrapText: true }; });
    r++;
  }
  const order = flags.map((f, i) => [f, i]).sort((p, q) =>
    p[0].entry.page - q[0].entry.page || (p[0].game ?? -1) - (q[0].game ?? -1) || p[1] - q[1]).map(p => p[0]);
  for (const fl of order) {
    [fl.entry.page, fl.entry.name, fl.field, fl.read, fl.issue].forEach((v, j) => {
      const cell = rv.getCell(r, j + 1); cell.value = v; cell.border = BOX; cell.alignment = { vertical: "top", wrapText: true };
    });
    if (fl.img) {
      const id = wb.addImage({ base64: fl.img.data, extension: "png" });
      rv.addImage(id, { tl: { col: 5, row: r - 1 }, ext: { width: fl.img.w, height: fl.img.h } });
      rv.getRow(r).height = Math.max(30, fl.img.h * 0.76);
    }
    r++;
  }
  if (!flags.length && !scheduleFlags.length) rv.getCell(2, 1).value = "Nothing needed review.";
  rv.views = [{ state: "frozen", ySplit: 1 }];
  for (const s of [ws, rv]) s.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  return new Blob([await wb.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

/* ======================================================= the run ========= */
function consensus(schedules, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const g = {};
    for (const key of ["away", "home", "time", "day"]) {
      const vals = schedules.filter(s => i < s.length && s[i][key]).map(s => s[i][key]);
      g[key] = vals.length ? mostCommon(vals)[0] : null;
    }
    out.push(g);
  }
  return out;
}

async function convert(file, { pdfjsLib, roster, paths, workers = 3, status = () => {}, progress = () => {} }) {
  status("Opening the PDF");
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const N = pdf.numPages;
  status(`Found ${N} sheet${N === 1 ? "" : "s"} in the packet`);
  progress(4);
  status("Starting the text reader");
  POOL = new OcrPool(workers);
  await POOL.init(paths);
  progress(8);

  const pages = [];
  let keptForSchedule = 0;
  try {
    for (let p = 1; p <= N; p++) {
      const page = await pdf.getPage(p);
      const vp = page.getViewport({ scale: DPI / 72 });
      const img = document.createElement("canvas");
      img.width = Math.round(vp.width); img.height = Math.round(vp.height);
      await page.render({ canvasContext: img.getContext("2d"), viewport: vp }).promise;
      page.cleanup();
      const det = detectGames(grayFromCanvas(img));
      const rec = { page: p, n: det ? det.rows.length : 0, det, thumb: thumb(img, 600) };
      if (det) {
        const s = det.size;
        rec.size = s;
        rec.marks = det.rows.map(([lb, rb]) => {
          const [side, issue] = decide(fillRatio(det.bw, lb), fillRatio(det.bw, rb));
          const y = (lb[1] + rb[1]) / 2;
          return { side, issue, img: issue ? thumb(cropCanvas(img, lb[0] - 1.2 * s, y - 1.0 * s, rb[0] + 1.2 * s, y + 1.0 * s), 620) : null };
        });
        status(`Sheet ${p} of ${N}: ${det.rows.length} games found, reading the name and tiebreaker`);
        rec.ft = await readFooter(img, det);
        rec.footThumb = thumb(rec.ft.footer, 620);
        (global.__poolDebug = global.__poolDebug || []).push({ page: p, tbReads: rec.ft.tbReads, tb: rec.ft.tbValue });
        rec.ft.footer = null;
        if (p === 1) rec.title = cropCanvas(img, 0, 0, img.width, img.height * 0.09);
        if (!det.rows.some(r => r[2]) && keptForSchedule < 10) { rec.img = img; keptForSchedule++; }
        det.bw = null;
      } else status(`Sheet ${p} of ${N}: couldn't find the checkboxes`);
      pages.push(rec);
      progress(8 + 72 * p / N);
    }

    const [nGames] = mostCommon(pages.filter(p => p.det).map(p => p.n));
    if (nGames == null) throw new Error("Couldn't find any pick-sheet checkboxes in this PDF.");
    let good = pages.filter(p => p.img && p.n === nGames);
    const [common] = mostCommon(good.map(p => pyRound(p.size / 4)));
    good = good.filter(p => pyRound(p.size / 4) === common).slice(0, 6);
    status(`Reading the ${nGames} matchups from ${good.length} of the cleanest sheets`);
    const schedules = [];
    for (let k = 0; k < good.length; k++) { schedules.push(await readSchedule(good[k].img, good[k].det)); progress(80 + 12 * (k + 1) / good.length); }
    const schedule = consensus(schedules, nGames);
    for (const p of pages) p.img = null;
    schedule.forEach((g, i) => status(`Game ${i + 1}: ${TEAMS[g.away] || "???"} at ${TEAMS[g.home] || "???"}  ${[g.day, g.time].filter(Boolean).join(" ")}`));
    const scheduleFlags = schedule.map((g, i) => (g.away in TEAMS && g.home in TEAMS) ? null :
      { page: "-", read: `${g.away || "?"} / ${g.home || "?"}`, issue: `Couldn't read the teams for game ${i + 1} - fix the column header` }).filter(Boolean);

    let week = null;
    const wm = file.name.match(/week[\s_-]*(\d{1,2})/i);
    if (wm) week = wm[1];
    else if (pages[0] && pages[0].title) { const [t] = await ocr(cleanForOcr(pages[0].title), 7); const m = t.toLowerCase().match(/week\s*(\d{1,2})/); week = m ? m[1] : null; }

    status("Putting the picks, names and tiebreakers together");
    const entries = [], flags = [];
    for (const p of pages) {
      const e = { page: p.page, name: `?? (page ${p.page})`, picks: Array(nGames).fill(null), points: null };
      entries.push(e);
      if (!p.det || p.n !== nGames) {
        flags.push({ entry: e, field: "Name", read: "", img: p.thumb, issue: `Found ${p.n} games instead of ${nGames} - enter this sheet by hand` });
        continue;
      }
      p.marks.forEach((m, i) => {
        const g = schedule[i];
        const team = m.side === "L" ? g.away : m.side === "R" ? g.home : null;
        e.picks[i] = team ? (TEAMS[team] || team) : (m.side ? (m.side === "L" ? "Away" : "Home") : null);
        if (m.issue) flags.push({ entry: e, field: "Pick", game: i, img: m.img, read: e.picks[i] || "(blank)",
          issue: `${TEAMS[g.away] || "?"} / ${TEAMS[g.home] || "?"}: ${m.issue}` });
      });
      const ft = p.ft, foot = p.footThumb;
      e.footer = foot;
      if (!ft.labels) {
        for (const field of ["Name", "Tiebreaker"]) flags.push({ entry: e, field, read: "", img: foot, issue: "Couldn't locate the name/tiebreaker area - please enter by hand" });
        continue;
      }
      if (ft.nameMissing) flags.push({ entry: e, field: "Name", read: "", img: foot, issue: "Couldn't locate the name line - please enter by hand" });
      else {
        const [name, ok, note] = ft.nameInk > 0.004 ? resolveName(ft.name, ft.nameConf, roster) : [null, false, "Name looks blank"];
        if (name) e.name = name;
        if (!ok) flags.push({ entry: e, field: "Name", read: ft.name, img: foot, issue: note });
      }
      if (ft.tbMissing) { flags.push({ entry: e, field: "Tiebreaker", read: "", img: foot, issue: "Couldn't locate the tiebreaker line - please enter by hand" }); continue; }
      if (ft.tbValue != null) e.points = ft.tbValue;
      else {
        // a plausible-looking wrong number is worse than a blank orange cell
        let issue;
        if (ft.tbInk < 0.004) {
          issue = "Tiebreaker is blank";
          if (ft.tcInk >= 0.004) issue += ` - but something is written under Total Correct${ft.tc ? " (" + ft.tc + ")" : ""}; may be the tiebreaker`;
        } else issue = "Couldn't read the tiebreaker with confidence - please enter it";
        flags.push({ entry: e, field: "Tiebreaker", read: ft.tb || "", img: foot, issue });
      }
    }
    // repeat names are extra entries: first keeps the name, later ones numbered
    const groups = new Map();
    for (const e of entries) if (!e.name.startsWith("??")) { if (!groups.has(e.name)) groups.set(e.name, []); groups.get(e.name).push(e); }
    for (const [name, group] of groups) {
      if (group.length < 2) continue;
      const pg = group.map(g => g.page).join(", ");
      group.forEach((e, k) => {
        if (k) e.name = `${name} ${k + 1}`;
        flags.push({ entry: e, field: "Name", read: name, img: e.footer,
          issue: `'${name}' is on pages ${pg} - numbered as separate entries; change if one isn't a real extra entry` });
      });
    }
    progress(95);
    status("Building the spreadsheet");
    const blob = await buildWorkbook(week, schedule, entries, flags, scheduleFlags);
    const sheetsWithFlags = new Set(flags.map(f => f.entry.page)).size;
    const base = file.name.replace(/\.pdf$/i, "");
    progress(100);
    return { blob, filename: `${base}_results.xlsx`, sheets: entries.length,
             items: flags.length + scheduleFlags.length, sheetsWithFlags, week };
  } finally {
    await POOL.terminate();
    POOL = null;
  }
}

global.PoolEngine = { convert, _test: { ratio, closeMatches, resolveName, splitMatchup, decide, pyRound } };
})(window);
