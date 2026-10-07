/* ============================================================================
   SQUAD UP — notifications
   Email and text messages behind one interface. Each person is reached one
   way: by text if texting is switched on and they have a phone number,
   otherwise by email. People who asked for no messages get none.
   ========================================================================== */
const crypto = require("crypto");

// Render sets RENDER_EXTERNAL_URL on every web service, so links are right
// out of the box; SQUAD_BASE_URL only matters if you add a custom domain.
const BASE = (process.env.SQUAD_BASE_URL || process.env.HANG_BASE_URL ||
  (process.env.RENDER_EXTERNAL_URL && process.env.RENDER_EXTERNAL_URL + "/squadup") ||
  "http://localhost:" + (process.env.PORT || 3000) + "/squadup").replace(/\/+$/, "");

function link(person, suffix) {
  return `${BASE}/p/${person.personal_token}${suffix || ""}`;
}
const stopLink = person => `${BASE}/stop?t=${encodeURIComponent(person.personal_token)}`;

// Every link that goes to someone already signed up carries their key, so
// tapping it from an email lands them signed in.
function activityLink(activityId, person, extra) {
  const q = person ? `?t=${encodeURIComponent(person.personal_token)}` : "";
  return `${BASE}/a/${activityId}${q}${person && extra ? "&" + extra : ""}`;
}

// One-tap answers from an email. The link opens a tiny page that saves the
// answer and drops you on the plan. A plain GET never changes anything, so
// mail scanners that pre-open links can't answer for you.
// `what` is "opt:<optionId>", "all", "no", or "approve:<optionId>".
function replyLink(activityId, person, what) {
  return `${BASE}/r/${activityId}?t=${encodeURIComponent(person.personal_token)}` +
         `&do=${encodeURIComponent(what)}`;
}

/* ---------- email body ---------- */
const escHtml = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function renderText(msg, fallbackUrl, stopUrl) {
  const acts = (msg.actions || []).map(a => `${a.label}: ${a.url}`).join("\n");
  return `${msg.body}\n\n${acts ? acts + "\n\n" : ""}Open it: ${msg.url || fallbackUrl}` +
    (stopUrl ? `\n\nDon't want these? Stop all Squad Up messages: ${stopUrl}` : "");
}

function renderHtml(msg, fallbackUrl, stopUrl) {
  const btn = (a, main) => `<a href="${escHtml(a.url)}" style="display:inline-block;margin:0 8px 10px 0;` +
    `padding:11px 20px;border-radius:999px;font-weight:700;text-decoration:none;font-size:15px;` +
    (main ? "background:#1FA9C9;color:#ffffff;" : "background:#ffffff;color:#3B4553;border:2px solid #D5DDE7;") +
    `">${escHtml(a.label)}</a>`;
  const acts = (msg.actions || []).map(a => btn(a, !a.quiet)).join("");
  return `<!doctype html><html><body style="margin:0;background:#F4F8FB;padding:24px 12px;` +
    `font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#3B4553">` +
    `<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:22px;padding:24px 22px;` +
    `box-shadow:0 6px 20px rgba(40,90,140,.12)">` +
    `<div style="font-weight:800;font-size:13px;letter-spacing:.04em;color:#7D8899;margin-bottom:10px">SQUAD UP</div>` +
    `<div style="font-weight:800;font-size:20px;line-height:1.25;margin-bottom:8px">${escHtml(msg.subject)}</div>` +
    `<div style="font-size:16px;line-height:1.5;margin-bottom:18px">${escHtml(msg.body)}</div>` +
    (acts ? `<div>${acts}</div>` : "") +
    `<div style="margin-top:8px"><a href="${escHtml(msg.url || fallbackUrl)}" ` +
    `style="color:#1FA9C9;font-weight:700;font-size:15px">Open Squad Up</a></div>` +
    `</div>` +
    (stopUrl ? `<div style="max-width:480px;margin:14px auto 0;text-align:center;font-size:12px;color:#9AA4B2">` +
      `Don't want these? <a href="${escHtml(stopUrl)}" style="color:#9AA4B2">Stop all Squad Up messages</a></div>` : "") +
    `</body></html>`;
}

/* ---------- text message body ----------
   Short: the news, how to answer by reply, and the link. Actions carry a
   `reply` word ("YES", "1", "BOTH", "ADD"...) that the inbound handler
   understands. First contact with someone also says how to opt out. */
function renderSms(msg, fallbackUrl) {
  const head = msg.sms || `${msg.subject}. ${msg.body}`;
  const codes = (msg.actions || []).filter(a => a.reply);
  let hint = "";
  if (codes.length) {
    const parts = codes.map(a => a.replyLabel ? `${a.reply} for ${a.replyLabel}` : a.reply);
    hint = "Reply " + (parts.length > 1
      ? parts.slice(0, -1).join(", ") + " or " + parts[parts.length - 1] : parts[0]) + ".";
  }
  return [head, hint, msg.url || fallbackUrl,
          msg.firstContact ? "Reply STOP to opt out." : ""].filter(Boolean).join("\n");
}

/* ---------- backends ---------- */

const consoleBackend = {
  kind: "console",
  async send(person, msg) {
    console.log(`  [notify:${person.email || person.phone}] ${msg.subject} -- ${msg.body}` +
      (msg.actions && msg.actions.length ? ` [${msg.actions.map(a => a.label).join(" | ")}]` : ""));
    return { ok: true, backend: "console" };
  }
};

const resendBackend = (apiKey, from) => ({
  kind: "email",
  async send(person, msg) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from, to: [person.email], subject: msg.subject,
        text: renderText(msg, link(person), stopLink(person)),
        html: renderHtml(msg, link(person), stopLink(person))
      })
    });
    if (!res.ok) throw new Error("resend " + res.status + " " + await res.text());
    return { ok: true, backend: "email" };
  }
});

// `from` is your Twilio number (+1...) or a Messaging Service id (MG...).
const twilioBackend = (sid, token, from) => ({
  kind: "sms",
  async send(person, msg) {
    const form = new URLSearchParams({ To: person.phone, Body: renderSms(msg, link(person)) });
    form.set(/^MG/.test(from) ? "MessagingServiceSid" : "From", from);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        "Authorization": "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form.toString()
    });
    if (!res.ok) throw new Error("twilio " + res.status + " " + await res.text());
    return { ok: true, backend: "sms" };
  }
});

// Twilio signs every webhook it sends; this is how we know a "yes" really
// came from Twilio and not from someone posting to the URL.
function twilioSignature(authToken, url, params) {
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join("");
  return crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}
function twilioSignatureOk(authToken, url, params, given) {
  if (!authToken || !given) return false;
  const want = Buffer.from(twilioSignature(authToken, url, params));
  const got = Buffer.from(String(given));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

function makeNotifier() {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.SQUAD_FROM_EMAIL || process.env.HANG_FROM_EMAIL || "squadup@extrarandom.com";
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN, num = process.env.TWILIO_FROM;
  const backends = {
    email: key ? resendBackend(key, from) : consoleBackend,
    sms: sid && tok && num ? twilioBackend(sid, tok, num) : null
  };
  return {
    backends,
    get kind() { return backends.email.kind + (backends.sms ? " + sms" : ""); },
    // how this person is reached, or null if they can't (or asked not to) be
    channelFor(person) {
      if (!person || person.opted_out_at) return null;
      if (backends.sms && person.phone) return "sms";
      if (person.email) return "email";
      return null;
    },
    async send(person, msg) {
      const ch = this.channelFor(person);
      if (!ch) throw new Error("no way to reach this person");
      return backends[ch].send(person, msg);
    }
  };
}

/* ---------- send limits ----------
   A safety net against runaway sending: a bug that loops, someone mashing a
   button, or someone typing a friend's email into the join form over and
   over. Counted over a rolling 24 hours, per channel, from a log in the
   database, so a restart doesn't reset them. An in-memory count runs
   alongside as a backstop in case the database can't be reached.
   Every number can be changed with an environment variable. */
const num = (v, d) => (v != null && v !== "" && !isNaN(+v) ? +v : d);
const LIMITS = {
  email: {
    perPerson: num(process.env.SQUAD_EMAIL_PER_PERSON_DAY, 15),   // to any one person
    links:     num(process.env.SQUAD_LINK_EMAILS_PER_DAY, 3),     // "here's your link" to one person
    total:     num(process.env.SQUAD_EMAIL_PER_DAY, 95)           // everything (Resend free tier is 100/day)
  },
  sms: {
    perPerson: num(process.env.SQUAD_SMS_PER_PERSON_DAY, 5),
    links:     num(process.env.SQUAD_LINK_SMS_PER_DAY, 2),
    total:     num(process.env.SQUAD_SMS_PER_DAY, 50)
  }
};
const DAY_MS = 24 * 60 * 60 * 1000;

function makeGuard(db, limits) {
  const L = limits || LIMITS;
  const recent = [];          // backstop: { at, person_id, channel, kind }
  const memCount = (ch, f) => {
    const since = Date.now() - DAY_MS;
    while (recent.length && recent[0].at < since) recent.shift();
    return recent.filter(r => r.channel === ch && (!f || f(r))).length;
  };
  return {
    limits: L,
    // null if it may go out, otherwise a short reason
    async check(person, channel, kind) {
      const lim = L[channel] || L.email;
      const sinceIso = new Date(Date.now() - DAY_MS).toISOString();
      let total, mine, links;
      try {
        [total, mine, links] = await Promise.all([
          db.countSends({ channel, sinceIso }),
          db.countSends({ channel, sinceIso, person_id: person.id }),
          kind === "link" ? db.countSends({ channel, sinceIso, person_id: person.id, kind }) : 0
        ]);
      } catch (e) {
        console.error("send log unreadable, using in-memory counts:", e.message);
        total = 0; mine = 0; links = 0;
      }
      total = Math.max(total, memCount(channel));
      mine = Math.max(mine, memCount(channel, r => r.person_id === person.id));
      if (kind === "link") links = Math.max(links, memCount(channel, r => r.person_id === person.id && r.kind === "link"));
      if (total >= lim.total) return `daily ${channel} limit reached (${lim.total})`;
      if (mine >= lim.perPerson) return `daily limit for this person reached (${lim.perPerson})`;
      if (kind === "link" && links >= lim.links) return `link re-sends for this person capped (${lim.links}/day)`;
      return null;
    },
    // `ask` = { activity_id, option_ids } when the message asked a question
    async record(person, channel, kind, ask) {
      recent.push({ at: Date.now(), person_id: person.id, channel, kind: kind || null });
      try {
        await db.logSend({ person_id: person.id, channel, kind,
          activity_id: ask ? ask.activity_id : null,
          ask_options: ask && ask.option_ids && ask.option_ids.length ? ask.option_ids.join(",") : null });
      }
      catch (e) { console.error("send log write failed:", e.message); }
    }
  };
}

let activeGuard = null;
function useGuard(g) { activeGuard = g; }
const channelOf = backend => (backend.kind === "sms" ? "sms" : "email");

/* ---------- fan-out ----------
   Never throws: one bad address must not take down the request that
   triggered it, and definitely must not stop the other recipients.
   Returns the ids it reached; .held counts anyone the limits held back. */
async function notifyAll(backend, people, buildMsg, opts) {
  const skip = (opts && opts.skipPersonId) || null;
  const kind = (opts && opts.kind) || null;
  const guard = opts && opts.guard !== undefined ? opts.guard : activeGuard;
  const sent = [];
  sent.held = 0;
  sent.unreachable = 0;
  for (const p of people) {
    if (!p || p.id === skip) continue;
    const channel = backend.channelFor ? backend.channelFor(p) : (p.opted_out_at ? null : channelOf(backend));
    if (!channel) { sent.unreachable++; continue; }   // opted out, or no address we can use
    try {
      if (guard) {
        const why = await guard.check(p, channel, kind);
        if (why) {
          sent.held++;
          console.warn(`held back (${why}): ${p.email || p.id}`);
          continue;
        }
      }
      const msg = buildMsg(p);
      await backend.send(p, { ...msg, url: msg.url || link(p) });
      if (guard) await guard.record(p, channel, kind, msg.ask);
      sent.push(p.id);
    } catch (e) {
      console.error("notify failed for " + (p.email || p.id) + ":", e.message);
    }
  }
  return sent;
}

module.exports = { makeNotifier, notifyAll, makeGuard, useGuard, LIMITS, link, activityLink, replyLink, BASE,
                   renderText, renderHtml, renderSms, stopLink, twilioSignature, twilioSignatureOk,
                   consoleBackend, resendBackend, twilioBackend };
