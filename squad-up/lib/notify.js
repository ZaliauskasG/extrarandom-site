/* ============================================================================
   SQUAD UP — notifications
   One interface, swappable backends. Email ships first; the Twilio path is
   stubbed in the same shape so turning on SMS later is a config change and a
   per-person preference, not a rewrite of every call site.
   ========================================================================== */

const BASE = process.env.SQUAD_BASE_URL || process.env.HANG_BASE_URL || "https://extrarandom.com/squadup";

function link(person, suffix) {
  return `${BASE}/p/${person.personal_token}${suffix || ""}`;
}

/* ---------- backends ---------- */

const consoleBackend = {
  kind: "console",
  async send(person, msg) {
    console.log(`  [notify:${person.email}] ${msg.subject} -- ${msg.body}`);
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
        text: `${msg.body}\n\n${msg.url || link(person)}`
      })
    });
    if (!res.ok) throw new Error("resend " + res.status + " " + await res.text());
    return { ok: true, backend: "email" };
  }
});

// Not wired up yet -- present so the shape is settled and switching a person
// to SMS later is a preference flag, not a refactor.
const twilioBackend = () => ({
  kind: "sms",
  async send() { throw new Error("SMS backend not configured yet"); }
});

function makeNotifier() {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.SQUAD_FROM_EMAIL || process.env.HANG_FROM_EMAIL || "squadup@extrarandom.com";
  if (key) return resendBackend(key, from);
  return consoleBackend;
}

/* ---------- fan-out ----------
   Never throws: one bad address must not take down the request that
   triggered it, and definitely must not stop the other recipients. */
async function notifyAll(backend, people, buildMsg, opts) {
  const skip = (opts && opts.skipPersonId) || null;
  const sent = [];
  for (const p of people) {
    if (!p || p.id === skip) continue;
    try {
      const msg = buildMsg(p);
      await backend.send(p, { ...msg, url: msg.url || link(p) });
      sent.push(p.id);
    } catch (e) {
      console.error("notify failed for " + (p.email || p.id) + ":", e.message);
    }
  }
  return sent;
}

module.exports = { makeNotifier, notifyAll, link, BASE,
                   consoleBackend, resendBackend, twilioBackend };
