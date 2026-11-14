// Shared timing helpers for the tutorial videos. Each video defines
// window.DURATION, window.POSTER and draw(t); render(t) here does the rest.
// centered on its top line, then scaled (for .zoom and .note)
const CENTER = z => `translateY(-50%) scale(${z || 1})`;
const $ = id => document.getElementById(id);
const clamp = x => Math.max(0, Math.min(1, x));
const prog = (t, a, b) => clamp((t - a) / (b - a));
const ease = x => { x = clamp(x); return x < .5 ? 4*x*x*x : 1 - Math.pow(-2*x + 2, 3) / 2; };
const out = x => { x = clamp(x); return 1 - Math.pow(1 - x, 3); };
const back = x => { x = clamp(x); const c = 1.70158, c3 = c + 1; return 1 + c3 * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
// fade and slide up in; extra transform (like a zoom) goes after
function rise(el, k, d, extra) {
  el.style.opacity = out(k); el.style.transform = `translateY(${(1 - out(k)) * (d == null ? 24 : d)}px) ${extra || ""}`;
}
// in at a, out at b (each fade takes f seconds)
function shown(t, a, b, f) { f = f || .35; return Math.min(out(prog(t, a, a + f)), 1 - ease(prog(t, b - f, b))); }
// a caption: in at a, out at b (b omitted = stays)
function caption(id, t, a, b) {
  const el = $(id), k = b == null ? out(prog(t, a, a + .4)) : shown(t, a, b, .4);
  const up = b != null && t > b - .4 ? -14 * ease(prog(t, b - .4, b)) : (1 - out(prog(t, a, a + .4))) * 20;
  el.style.opacity = k; el.style.transform = `translateY(calc(-50% + ${up}px))`;
}
// one tap: veil in, press, change, veil out. Returns nothing; el gets pressed.
// plain = just the ring, no dimming around it
function tap(t, at, el, plain) {
  const veil = Math.min(ease(prog(t, at - .7, at - .35)), 1 - ease(prog(t, at + .45, at + .8)));
  const press = t >= at && t < at + .22 ? Math.sin(prog(t, at, at + .22) * Math.PI) : 0;
  el.style.filter = press ? `brightness(${1 - .12 * press})` : "";
  el.style.scale = 1 - .07 * press;
  if (veil <= 0) return;
  const r = el.getBoundingClientRect(), pad = 14, sp = $("spot");
  if (!plain) {
    sp.style.opacity = veil;
    sp.style.left = (r.left - pad) + "px"; sp.style.top = (r.top - pad) + "px";
    sp.style.width = (r.width + pad * 2) + "px"; sp.style.height = (r.height + pad * 2) + "px";
    sp.style.borderRadius = (Math.min(r.width, r.height) / 2 + pad) + "px";
  }
  const u = prog(t, at + .05, at + .6), rp = $("ripple");
  if (u > 0 && u < 1) {
    const d = Math.max(r.width, r.height) * (0.4 + 1.1 * out(u));
    rp.style.opacity = (1 - u) * (plain ? 1 : veil);
    rp.style.borderColor = plain ? "rgba(59,69,83,.55)" : ""; rp.style.boxShadow = plain ? "none" : ""; rp.style.width = rp.style.height = d + "px";
    rp.style.left = (r.left + r.width / 2 - d / 2) + "px"; rp.style.top = (r.top + r.height / 2 - d / 2) + "px";
  }
}
// a spotlight that rests on each element in turn and glides between them:
// steps = [[el, from, to], ...]; it fades in before the first, out after the last
function spotlight(t, steps) {
  const a = steps[0][1], z = steps[steps.length - 1][2];
  const veil = Math.min(ease(prog(t, a - .35, a)), 1 - ease(prog(t, z, z + .35)));
  if (veil <= 0) return;
  let r = steps[0][0].getBoundingClientRect();
  for (let i = 0; i < steps.length; i++) {
    const [el, from, to] = steps[i];
    if (t >= from) r = el.getBoundingClientRect();
    if (i + 1 < steps.length && t > to && t < steps[i + 1][1]) {
      const b = steps[i + 1][0].getBoundingClientRect(), k = ease(prog(t, to, steps[i + 1][1]));
      r = { left: r.left + (b.left - r.left) * k, top: r.top + (b.top - r.top) * k,
            width: r.width + (b.width - r.width) * k, height: r.height + (b.height - r.height) * k };
    }
  }
  const pad = 14, sp = $("spot");
  sp.style.opacity = veil;
  sp.style.left = (r.left - pad) + "px"; sp.style.top = (r.top - pad) + "px";
  sp.style.width = (r.width + pad * 2) + "px"; sp.style.height = (r.height + pad * 2) + "px";
  sp.style.borderRadius = "34px";
}
// the logo's five dots pop in one by one
function dots(sel, t, a) {
  document.querySelectorAll(sel + " i").forEach((d, i) => {
    const k = prog(t, a + i * .06, a + .3 + i * .06);
    d.style.transform = `scale(${back(k)})`; d.style.opacity = clamp(k * 3);
  });
}
// The last half second fades back to just the question, the way each video
// starts, so it loops without a jump. Videos add END_FADE to their length.
const END_FADE = .6;
window.render = function (t) {
  $("spot").style.opacity = 0; $("ripple").style.opacity = 0;
  draw(t);
  const k = 1 - ease(prog(t, window.DURATION - END_FADE, window.DURATION - .1));
  if (k < 1) document.querySelectorAll("body > :not(#glow):not(.q):not(.qbrand):not(script)").forEach(el =>
    el.style.opacity = (parseFloat(el.style.opacity) || 0) * k);
  return true;
};
window.ready = document.fonts.ready;
