/* ============================================================================
   SQUAD UP — legal text and the wording of consent messages
   One place for the words that carriers and reviewers read: the Terms, the
   Privacy Policy, and the texts that confirm someone opted in. Keep these in
   step with what the app really does.
   ========================================================================== */
const OPERATOR = "Extrarandom";
// "Squad Up with Gin" -- the squad this copy of the app is for
const SQUAD_WITH = process.env.SQUAD_WITH || "Gin";
const SITE = "extrarandom.com";
const CONTACT = process.env.SQUAD_CONTACT_EMAIL || "GinZ@Extrarandom.com";
const UPDATED = "October 19, 2026";
const PER_DAY = Number(process.env.SQUAD_SMS_PER_PERSON_DAY) || 5;

// the short disclosure every opt-in text carries
const DISCLOSE = `Msg frequency varies. Msg&data rates may apply. Reply HELP for help, STOP to cancel.`;

// sent when someone opts in on the web (no plan attached)
const WELCOME_SMS = `Welcome to Squad Up by ${OPERATOR}! Texts about plans you're invited to or follow. ${DISCLOSE}`;
// sent first thing in the reply to someone's first YES
const WELCOME_YES = `Welcome to Squad Up by ${OPERATOR}! Texts about your plans. ${DISCLOSE}`;
// carriers want the first text to say how to stop and that rates apply
const FIRST_TEXT_TAIL = "Reply STOP to opt out. Msg&data rates may apply.";

const helpSms = page =>
  `Squad Up by ${OPERATOR}: reply YES or NO to the last plan we sent, or the number of a time. ` +
  `Your page: ${page} Help: ${CONTACT}. Msg&data rates may apply. Reply STOP to opt out.`;
const backSms = page =>
  `Squad Up by ${OPERATOR}: you're back on. ${DISCLOSE} ${page}`;

// What the carrier-level STOP / HELP / START replies should say. Twilio sends
// these itself once they're set under Messaging > Services > Opt-Out Management.
const STOP_REPLY = `Squad Up by ${OPERATOR}: You're unsubscribed and won't get any more texts. Reply START to rejoin.`;
const HELP_REPLY = `Squad Up by ${OPERATOR}: plan invites and replies from friends. Help: ${CONTACT} or squadup.${SITE}. Msg&data rates may apply. Reply STOP to opt out.`;
const START_REPLY = WELCOME_SMS;

const TERMS_URL = "/squadup/terms";
const PRIVACY_URL = "/squadup/privacy";

/* ---------- pages (body HTML; views.js wraps them) ---------- */
function termsBody() {
  return `
<h1>Terms of Service</h1>
<p class="muted">Squad Up text and email messaging · Last updated ${UPDATED}</p>

<h2>Who we are</h2>
<p>Squad Up is a plan-making app run by ${OPERATOR} (${SITE}). It helps a group of friends pick a time, say who's in, and get a nudge. These terms cover using Squad Up and its text (SMS) and email messages.</p>

<h2>The messaging program</h2>
<p><b>Program name:</b> Squad Up.</p>
<p><b>What you get:</b> messages about plans among friends: invitations, requests for the times that work for you, confirmations, changes, and reminders, and replies to texts you send us. Nothing else. We send no ads or promotions.</p>
<p><b>How people join:</b> only by entering their own mobile number on our web form (at squadup.${SITE}, or on the page for a plan a friend sent them) and checking the box to receive texts, which is never pre-checked. Other people can't add your number. If you opted out, you can text START to rejoin.</p>
<p><b>How often:</b> message frequency varies with the plans you're part of. Limited to ${PER_DAY} messages a day, and usually far fewer.</p>
<p><b>Cost:</b> Message and data rates may apply, depending on your mobile plan. We don't charge for Squad Up.</p>
<p><b>Help:</b> reply <b>HELP</b> to any text, or email ${CONTACT}.</p>
<p><b>Stop:</b> reply <b>STOP</b> to any text and you won't get more. You can also use the "Stop all messages" link in any email, or the button on your page. Reply <b>START</b> to turn texts back on.</p>
<p>Consent to receive texts is not a condition of using Squad Up. You can use email instead, or continue as a guest with just your name and get no messages at all.</p>
<p>Carriers and ${OPERATOR} are not liable for delayed or undelivered messages.</p>

<h2>Inviting other people</h2>
<p>To invite someone new, you send them the link to a plan yourself. They can answer as a guest with just a name, or join with their own number or email. You can also invite people who already joined Squad Up; they get a message about it. Don't use Squad Up for ads, promotions, or anything unlawful. We limit how many invites one person can send each day, and we may remove anyone who misuses Squad Up.</p>

<h2>Your link</h2>
<p>There are no passwords. Your personal link is your account, so anyone who has it can act as you. Keep it private. If it gets out, use "Log out of all other devices" on your page. Opening your link, or a log-in link we send you, keeps that browser logged in until you log out.</p>

<h2>Using Squad Up</h2>
<p>Squad Up is provided as is, with no promises that it will always be available or error-free. Check plans with the people involved before relying on them. We may change or end Squad Up, or these terms, at any time. Changes apply once posted here. Please don't misuse the service or try to break it. To the extent the law allows, ${OPERATOR} isn't liable for losses that come from using Squad Up.</p>

<h2>Your information</h2>
<p>How we handle your information is in our <a href="${PRIVACY_URL}">Privacy Policy</a>.</p>

<h2>Contact</h2>
<p>Questions, help, or requests: ${CONTACT}</p>`;
}

function privacyBody() {
  return `
<h1>Privacy Policy</h1>
<p class="muted">Squad Up · Last updated ${UPDATED}</p>

<h2>What we collect</h2>
<p>Your name, and the email address and/or mobile number you gave us. The plans, polls and categories you create, follow, or answer, and your answers. A record of when we sent you a message. Your mobile number's opt-in or opt-out status, and when you opted in. If you continue as a guest, just your name and answers, and the organizer of a plan can add a guest by name for someone who answered them in person. If you sign up with an email address only, we email you a link to confirm it before sending anything else. (Before October 2026, a friend could invite someone by email, so a few email addresses came from the friend who invited them.)</p>
<p>We use one cookie, to keep you logged in (or remember your guest name) on that browser for up to a year. Logging out removes it. We don't use ads or analytics trackers. Our pages load a font from Google Fonts, and our host keeps ordinary server logs (such as IP addresses and the pages requested).</p>

<h2>How we use it</h2>
<p>To run Squad Up: show plans to the people involved, send the messages described in our <a href="${TERMS_URL}">Terms</a>, and keep the service safe and within its daily limits. Other people on a plan can see your name and whether you're in.</p>

<h2>Text messaging data</h2>
<p><b>We do not sell or share your SMS opt-in data or personal information with third parties for marketing purposes.</b> Your phone number and consent are used only to send you Squad Up messages. Text messaging originator opt-in data and consent will not be shared with any third parties.</p>

<h2>Who helps us run Squad Up</h2>
<p>Service providers handle information only to run Squad Up for us: Render (hosting), Supabase (database), Twilio (text messages), Resend (email), and Google Fonts. We may also disclose information if the law requires it.</p>

<h2>Your choices</h2>
<p>Reply <b>STOP</b> to any text, or use "Stop all messages" in any email or on your page, to stop messages. You can correct your information with "Edit your info" on your page, and delete your account with "Delete my account" there. Deleting your account removes your answers, votes and ideas and cancels upcoming plans you were organizing. You can also email ${CONTACT} and we'll do it for you. To make a browser forget you, use Log out at the bottom of any page, or "Log out of all other devices" on your page.</p>

<h2>Keeping it</h2>
<p>We keep your information while you use Squad Up and delete it when you delete your account or ask us to. Past plans you organized stay so they still make sense for the people in them, without your name.</p>

<h2>Security</h2>
<p>Your personal link works like a password, so anyone with it can see your page. Keep it private. We store data with reputable providers and limit access, but no service is perfectly secure.</p>

<h2>Age</h2>
<p>Squad Up isn't meant for anyone under 18, and we don't knowingly collect information from anyone under 18.</p>

<h2>Changes and contact</h2>
<p>We'll post changes here. Questions: ${CONTACT}</p>`;
}

module.exports = {
  OPERATOR, SQUAD_WITH, SITE, CONTACT, PER_DAY, DISCLOSE, WELCOME_SMS, WELCOME_YES, FIRST_TEXT_TAIL,
  helpSms, backSms, STOP_REPLY, HELP_REPLY, START_REPLY, TERMS_URL, PRIVACY_URL,
  termsBody, privacyBody
};
