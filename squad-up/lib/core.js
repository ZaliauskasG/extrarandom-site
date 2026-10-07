/* ============================================================================
   SQUAD UP — core logic
   Pure functions only. No database, no HTTP, no rendering. Everything here is
   directly testable, and the server is a thin shell around it.

   Times are stored as naive local strings ("2026-04-16T18:00") on purpose:
   the whole group shares one timezone, so there is nothing to convert, and
   naive strings can't drift the way UTC round-trips can.
   ========================================================================== */
const crypto = require("crypto");

const QUORUM = 3;              // responses needed before we suggest a switch
const NUDGE_HOUR = 10;         // local hour for the day-before finalize nudge

/* ---------- identity ---------- */

// A personal link is a bearer credential, so the token has to be
// unguessable -- never sequential, never derived from anything about
// the person.
function newToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function newId() {
  return crypto.randomBytes(9).toString("base64url");
}

/* ---------- time ---------- */

function pad(n) { return String(n).padStart(2, "0"); }

// "2026-04-16T18:00" -> "Thu Apr 16, 6:00pm"
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatWhen(s) {
  if (!s) return "";
  const [d, t] = String(s).split("T");
  const [y, mo, da] = d.split("-").map(Number);
  const dt = new Date(y, mo - 1, da);
  let [h, mi] = (t || "00:00").split(":").map(Number);
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  const time = mi ? `${h}:${pad(mi)}${ampm}` : `${h}${ampm}`;
  return `${DAYS[dt.getDay()]} ${MONTHS[mo - 1]} ${da}, ${time}`;
}

function dateOf(s) { return String(s || "").split("T")[0]; }

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

function isPast(startsAt, now) {
  return String(startsAt) < toLocalStamp(now);
}

function toLocalStamp(now) {
  const d = now || new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
         `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---------- tallies ---------- */

// Only approved options are ever visible to non-creators, so tallies are
// always computed over the approved set.
function visibleOptions(options, viewerIsCreator) {
  return options.filter(o =>
    o.status === "approved" || (viewerIsCreator && o.status === "pending"));
}

function tally(options, responses) {
  const counts = {};
  options.forEach(o => { counts[o.id] = []; });
  responses.forEach(r => {
    (r.option_ids || []).forEach(id => {
      if (counts[id]) counts[id].push(r.person_id);
    });
  });
  return counts;
}

function countOut(responses) {
  return responses.filter(r => r.can_make_it === false).length;
}

/* ---------- the switch suggestion ----------
   Deliberately a suggestion, not an automatic swap: RSVPs trickle in over
   days, so auto-switching on every lead change would make the plan
   flip-flop. The creator confirms; nothing moves on its own. */
function switchSuggestion(activity, options, responses, quorum) {
  const q = quorum == null ? QUORUM : quorum;
  if (activity.canceled_at) return null;
  if (responses.length < q) return null;

  const approved = options.filter(o => o.status === "approved");
  const locked = approved.find(o => o.id === activity.locked_option_id);
  if (!locked) return null;

  const counts = tally(approved, responses);
  const lockedCount = (counts[locked.id] || []).length;

  let best = null, bestCount = -1;
  approved.forEach(o => {
    const c = (counts[o.id] || []).length;
    if (c > bestCount) { best = o; bestCount = c; }
  });

  if (!best || best.id === locked.id) return null;
  if (bestCount <= lockedCount) return null;

  return {
    from: locked, to: best,
    fromCount: lockedCount, toCount: bestCount
  };
}

/* ---------- day-before finalize nudge ----------
   Fires once per activity, at NUDGE_HOUR the day before whatever is
   currently locked. Silence changes nothing -- consistent with the rest of
   the app, where not responding never breaks a plan. */
function needsFinalizeNudge(activity, options, now) {
  if (activity.canceled_at) return false;
  if (activity.finalize_nudge_sent_at) return false;
  const locked = options.find(o => o.id === activity.locked_option_id);
  if (!locked) return false;

  const d = now || new Date();
  if (d.getHours() < NUDGE_HOUR) return false;

  const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return dateOf(locked.starts_at) === addDays(today, 1);
}

/* ---------- permissions ---------- */
function isCreator(person, activity) {
  return !!person && !!activity && person.id === activity.creator_id;
}

/* ---------- phone numbers ----------
   Stored as +<digits>. US numbers can be typed any common way; anything
   starting with + is taken as international. Returns null for blank and
   false for something that can't be a phone number. */
function normalizePhone(input) {
  const raw = String(input == null ? "" : input).trim();
  if (!raw) return null;
  const d = raw.replace(/\D/g, "");
  if (raw.startsWith("+")) return d.length >= 8 && d.length <= 15 ? "+" + d : false;
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return false;
}
function formatPhone(p) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(String(p || ""));
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : String(p || "");
}
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/* ---------- text-message replies ----------
   What someone texted back, boiled down to one of:
   yes | no | both | pick (with n) | stop | start | help | unknown */
function parseReply(text) {
  const t = String(text || "").trim().toLowerCase().replace(/[!.?,"']+/g, "").replace(/\s+/g, " ");
  if (/^(stop|stopall|unsubscribe|cancel|end|quit|optout|opt out)$/.test(t)) return { kind: "stop" };
  if (/^(start|unstop|resume|opt in|optin)$/.test(t)) return { kind: "start" };
  if (/^(help|info|\?)$/.test(t)) return { kind: "help" };
  if (/^\d$/.test(t)) return { kind: "pick", n: +t };
  if (/^(both|all|either|both work|all of them|any)$/.test(t)) return { kind: "both" };
  if (/^(y|ya|yes|yeah|yea|yep|yup|sure|ok|okay|in|im in|i m in|count me in|absolutely|definitely|works|add|add it)( please)?$/.test(t))
    return { kind: "yes" };
  if (/^(n|no|nope|nah|out|im out|cant|can not|cannot|cant make it|not this time|pass)$/.test(t))
    return { kind: "no" };
  return { kind: "unknown" };
}

/* ---------- names and lifecycle ---------- */

// "Pickleball" + "Josh's place" -> "Pickleball at Josh's place". Cards clamp
// it with CSS; emails and the plan's own page show it whole.
const LOCATION_MAX = 80;
function fullTitle(a) {
  if (!a) return "";
  const loc = String(a.location || "").trim();
  return loc ? `${a.title} at ${loc}` : a.title;
}

// A plan stays on the main page through the whole day it happens, and moves
// to Past Plans the morning after.
function isOver(startsAt, now) {
  if (!startsAt) return false;
  return dateOf(startsAt) < dateOf(toLocalStamp(now));
}

// Past Plans holds anything that's happened or was deleted.
function isPastPlan(activity, lockedOption, now) {
  return !!activity.canceled_at || isOver(lockedOption && lockedOption.starts_at, now);
}

/* ---------- "Let's do this sometime" ----------
   An idea with no time attached. Anyone can add their name, anyone can turn
   it into a real activity, and it never notifies anybody on its own.

   These use real instants (ISO timestamps), not the naive local strings the
   activity times use -- "four months after the last person joined" and "a
   week since the last nudge" are durations, not wall-clock times. */
const IDEA_TTL_DAYS = 120;          // about four months
const IDEA_NUDGE_COOLDOWN_DAYS = 7; // one "someone should schedule this" a week
const DAY_MS = 24 * 60 * 60 * 1000;

// The clock restarts whenever someone new joins, so an idea people keep
// signing on to stays up, and one everyone forgot about fades on its own.
function ideaExpiresAt(idea) {
  const from = new Date(idea.last_joined_at || idea.created_at).getTime();
  return new Date(from + IDEA_TTL_DAYS * DAY_MS);
}

function isIdeaLive(idea, now) {
  if (!idea || idea.archived_at) return false;
  return (now || new Date()).getTime() < ideaExpiresAt(idea).getTime();
}

// When the next nudge is allowed, or null if one can go out right now.
function ideaNudgeAvailableAt(idea, now) {
  if (!idea.last_nudge_at) return null;
  const next = new Date(new Date(idea.last_nudge_at).getTime()
    + IDEA_NUDGE_COOLDOWN_DAYS * DAY_MS);
  return (now || new Date()).getTime() >= next.getTime() ? null : next;
}

// Most-wanted first; ties go to whichever got a new name most recently.
function sortIdeas(ideas) {
  return ideas.slice().sort((x, y) =>
    (y.members || []).length - (x.members || []).length ||
    String(y.last_joined_at || y.created_at)
      .localeCompare(String(x.last_joined_at || x.created_at)));
}

// "Tue Oct 6" -- for dates that are real instants rather than local strings
function formatDay(d) {
  const dt = new Date(d);
  return `${DAYS[dt.getDay()]} ${MONTHS[dt.getMonth()]} ${dt.getDate()}`;
}

module.exports = {
  QUORUM, NUDGE_HOUR, IDEA_TTL_DAYS, IDEA_NUDGE_COOLDOWN_DAYS,
  newToken, newId,
  formatWhen, formatDay, dateOf, addDays, isPast, toLocalStamp,
  visibleOptions, tally, countOut,
  switchSuggestion, needsFinalizeNudge, isCreator,
  LOCATION_MAX, fullTitle, isOver, isPastPlan,
  normalizePhone, formatPhone, EMAIL_RE, parseReply,
  ideaExpiresAt, isIdeaLive, ideaNudgeAvailableAt, sortIdeas
};
