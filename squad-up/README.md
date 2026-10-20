# Squad Up

Standing invitations for a group of friends. Someone posts an activity with a
time and a fallback; whoever follows that category hears about it and taps once
to say they're in. Nobody installs anything and nobody has a password.

Opens from `extrarandom.com/squad-up/`; the server runs on Render.

---

## How identity works

There are no passwords. Joining creates a person with one permanent private URL:

```
<render-address>/squadup/p/{personal_token}
```

That link **is** the login, and it's a bearer credential: anyone holding it
can act as that person. **Log out of all other devices** on the home page
replaces it (this browser stays logged in), for the rare case one leaks.
Tokens are 24 random bytes, never sequential or guessable.

**Browsers remember people.** Opening your link (or a log-in link) sets one
cookie, `squadup`, holding your key: HttpOnly, SameSite=Lax, Secure on https,
good for a year and renewed on every visit. After that, any Squad Up link
opened in that browser knows who you are, so shared links never need a key
in them. Pages also take the key out of the address bar, so copying the
address shares the public link. **Log out** is at the bottom of every page.
The cookie only stands in for the key on JSON requests, so a form on another
site can't borrow it.

### The welcome screen

The front door (`/squadup`) and every shared plan or poll link start here
for anyone not recognized. Joining is the main box; the other two open
underneath it:

- **Join Squad Up** (shown first): name, phone and/or email, the text
  consent box and the Terms box. This makes an account; anything they did
  as a guest in that browser moves into it (their guest row becomes the
  account). A phone or email already on Squad Up just sends that person
  their log-in link, no error. **Email-only accounts confirm their address**:
  the only thing sent is a "Confirm your email" link, and nothing else goes
  to them until they tap it (their page says so, with **Send it again**). With
  a phone number, nothing needs confirming (phone checks come later).
- **Continue as a guest**: just a name. Guests are people with no phone or
  email, so they get no messages, ever. They can answer plans (times, or
  can't make it) and polls, and their home shows every upcoming plan and
  open poll, and the "Let's do this sometime" ideas (they can add their name
  to those). They can't post plans, ideas or invites.
- **I already have an account**: phone or email, and we send a log-in link
  (`/squadup/in/...`, signed, good for a week). The screen says the same
  thing whether or not the account exists. The link also carries what they
  did as a guest in that browser, so it moves into their account even if the
  email opens in a different browser. `/squadup/login`, also linked from the
  header for guests and visitors, opens straight to this.

### One name per person

Nobody in the squad shares a full name with anyone else, member or guest,
ignoring capitals. Every way a name is made goes through one check
(`nameMatches` in the server; when there are several squads, that's the one
place to scope it), and the database refuses a duplicate as a backstop.

- **Continue as a guest** with a name that's a guest anywhere in the squad:
  "Are you Kayla?" **Yes** picks up that guest and their answers; **No** asks
  for a last initial. A member's name offers a log-in link instead. A one-word
  name close to others ("Kayla" when there's a "Kayla M.") asks "Is one of
  these you?", with **None of these** to carry on.
- **Joining** with a guest's name (or a close one): "Did you already answer
  some plans as a guest?" Yes turns that guest into the account, answers and
  all. A member's name is refused, asking for a last initial.
- **Renaming yourself** to a guest's name asks if it's you, and merges them in.
- **The organizer filling in** a name that's already a guest is offered that
  guest; a member's name is turned away (they answer for themselves).
- **On start-up**, older data is brought under the rule: name-only poll
  answers get guests of their own; guests sharing a name fold into the one
  member with that name (someone who answered as a guest, then joined), or
  into the oldest guest; two members sharing a name get a number on the newer
  one. Safe to run every time; it does nothing once tidy.

Guests show in **navy italics** everywhere their names appear, with a small
key, so it's clear who won't get a text or email.

Members are never shown the welcome screen: the cookie takes them straight
to the plan or poll. `SQUAD_LINK_SECRET` signs log-in links (it falls back to
`SUPABASE_SERVICE_KEY`, so nothing new is needed on Render).

## Times and the plan

Every activity carries a required first-choice time and an optional backup.
The first choice is locked the moment it's posted, so it reads as a real plan
rather than an open poll. From there:

- Anyone can tap which times work for them. Multiple times is fine.
- **Can't make any** is a soft out. It doesn't reopen the plan or notify
  anyone. One person being busy shouldn't renegotiate the night for everybody.
- **Suggest another time** is the deliberate escalation. It creates a
  *pending* option only the creator sees. If they add it, everyone gets asked;
  if they dismiss it, nobody is notified, including the person who proposed it.
- When a different time pulls ahead (and at least 3 people have answered), the
  creator gets a one-tap prompt to move it. Nothing switches on its own —
  RSVPs arrive over days and auto-switching would make plans flip-flop.
- **24 hours before**, everyone who's in for the plan's time gets a reminder
  ("Tomorrow: Climbing, Thu 6pm. You said you're in."), and the organizer gets
  one with where everyone landed. A plan made less than a day ahead skips it.
- The creator can call the whole thing off, with an optional reason, and
  chooses whether everyone is told.

### What gets sent, and when

Only two things go out on their own: **a new plan (or Find-a-time poll) in a
category you follow**, and **the reminder 24 hours before** a plan you're in.
Everything else waits for someone to press a button:

- **The organizer's changes** (a new day or place, making another time the
  plan, adding a suggested time, deleting the plan) each ask first, in a small
  box under the button: e.g. **Save and tell everyone** / **Just save** /
  Cancel. Renames, notes, categories and a new time on the same day never
  send anything.
- **Invites**: the picker shows how each person will hear ("text" or "email"
  on their name), and the button says what goes out ("Send 2 invites" —
  "Sends 1 text and 1 email now").
- **Suggest a time** sends the organizer a note when the suggester taps
  **Send to Gin**. Replying ADD (by text) or tapping **Add it** in that email
  adds the time and asks everyone, as the message says.
- Log-in links, the email confirmation, and replies to texts go out when
  someone asks for them.

**Time zones.** Times are wall-clock strings (`2030-04-18T18:00`) in the
plan's own zone, stored on the plan (`squad_activities.timezone`). New plans
use the squad's home zone (`SQUAD_TIMEZONE`, default `America/New_York`). The
form only asks when the phone making the plan is somewhere else ("Times are
in Eastern Time / Mountain Time (your phone)"). "Already happened", "today"
and the day-before reminder are all worked out in the plan's zone, never from
the server's own clock (Render runs on UTC). Someone viewing from another
zone sees their own time next to it ("6pm (4pm your time)"), and messages add
the zone's short name when it isn't home time ("9am MST"). Polls and ideas
use the home zone.

**Add to calendar** on every upcoming plan: **Apple / Outlook** downloads a
calendar file (`/squadup/a/<id>/cal.ics`), **Google** opens Google Calendar
filled in. Plans have no end time, so calendars get two hours. Times go out
as real instants, so phones put them in the right place wherever they are.

**Link previews.** Every page carries preview tags, so a link pasted into a
text or chat shows "Gin invited you: Climbing", the time, and the Squad Up
picture (`og.png`, served at `/squadup/og.png`). iMessage shows these; some
Android texting apps don't show previews at all.

## Categories

Tags are made up as you go — when posting, pick an existing one or name a new
one. **A new category starts with only its maker following it**, so its
first plans message nobody else. For a month it's marked **New** on everyone
else's page (a "New categories" note above the chips, and a New badge on the
chip), and its plans and polls still show on their home page so nobody misses
them. Tapping the chip turns it on. After a month it's like any category they
don't follow.

Every category gets a color automatically from its name (`lib/colors.js`), so
nobody picks one and the same name is always the same color. Names that sound
alike share a color family:

| Family | Color | Matches names like |
|---|---|---|
| Dining | red | brunch, BBQ, ramen, coffee, potluck |
| Party | gold | parties, birthdays, karaoke, bars, breweries, happy hour |
| Active | green | climbing, pickleball, gym, running, surfing, biking |
| Creative | teal | painting, pottery, crafts, museums, books |
| Entertainment | blue | movies, concerts, comedy, festivals, theme parks |
| Games | purple | board games, trivia, poker, escape rooms |
| Travel / Outdoors | orange | trips, hiking, camping, beach, kayaking, fishing |
| Community | pink | family, volunteering, church, kids |

Anything unrecognized gets a steady color from the gaps between those
families. To move a word to a different family, edit the lists at the top of
`lib/colors.js`.

## Let's do this sometime

Below the scheduled activities is a list of things people want to do with no
date attached — "Beach day", "Kayaking", "That new ramen place".

- **Anyone can add one** (a title, a category, an optional note). Whoever adds
  it is automatically in.
- **Everyone sees the whole list**, whatever categories they follow, guests
  included. The point is to pull people slightly outside their usual lanes.
- **Nobody is ever notified** about an idea being posted, joined, or left.
  It just sits on the home page as a reminder.
- **Edit** (only for whoever added it) changes the title, category or note,
  or deletes the idea. Who's in stays the same, and nobody is notified.
- **I'm in / You're in** adds or removes your name. Guests can do this too.
  You can leave any time; when the last person leaves, the idea comes off the
  list.
- **Pick a time** — anyone, on the list or not, can turn it into a real
  activity. The new-activity form opens pre-filled with the title, category
  and note. Once it's posted, the idea comes off the list, and everyone who
  was on it is emailed along with the category's usual followers — even
  people who don't follow that category, since they said they wanted this.
  Guests on it can't be messaged: the form says so ("let them know
  yourself"), and they go on the plan with no times yet, ready for the
  organizer to fill in under **Fill in for others**.
- **Fading out:** an idea leaves the list four months after the last time
  someone new joined it. Each new name restarts the clock, so ideas people keep
  signing on to stay up and forgotten ones disappear quietly. The card shows the
  date once it's within a month.

Ideas live in their own two tables (`ideas`, `idea_members`) rather than as
activities without times, so none of the RSVP, switch-suggestion or
day-before logic has to know they exist.

## Find a time

**+ New plan** asks first: **I know when** (one time plus a backup, as
before) or **Find a time**, for when you don't know yet.

Find a time: tap any number of days on a calendar, each with an optional
time (and **+ time** for a second time the same day). Squad Up makes a link
(`/squadup/f/<id>`) to send to anyone.

- **No account needed to answer.** The welcome screen asks for a name
  first; then they tap every date that works. Their browser remembers them,
  so they can come back and change their answers.
- **Coming back on another phone or tab:** typing a name that's already a
  guest asks "Are you Sebastian?" (see One name per person). Anyone can do
  this, which is fine for friends.
- **Fill in for others** (organizer): for people who answer by text or in
  person. Type a name and **+ Add**, or tap a guest's name, and a bar says
  "Filling in for Sebastian" while you tap their dates; **Done** goes back to
  your own. Nothing waits on the network: **+ Add** (or Enter) opens
  the bar at once while the name is checked in the background, and taps save
  behind the scenes, one person after another, so you can add a whole list in
  a row. Same on plans. Works on guests only; people with an account change their own
  (`/api/poll-guest`).
- Long name lists fold to "and 3 more"; tap it to see everyone, tap
  **show less** to fold back. Same on plan pages.
- **Squad Up members** who open it from their own link are recognized
  automatically, and it shows on their home page under **Finding a time**.
- Everyone sees who can make each date. The date most people can make is
  marked **Most people**.
- **Each date has two answers: This works, or If need be.** "If need be"
  counts half when picking the leader, and shows separately ("+1 if need
  be"). Only outright yeses are marked in when it becomes a plan.
- **Category:** every poll has one, like a plan. Followers see it on their
  home page and get a message when it's posted.
- **Edit** (organizer): change the name, place, category, note, and every
  date. Moving a date's day or time keeps everyone's answers on it, so a
  half-hour nudge doesn't wipe votes. Removing a date drops its answers.
  Edits don't message anyone. Delete the vote from the same page.
- **Invite** (organizer): the same box as plans: pick people on Squad Up
  (category fans first), or copy the public link to send anyone. Invited
  members get a message and see it on their home page as "Your turn".
  The one-message rule and daily invite limits apply (poll and plan invites
  count together). When it becomes a plan, everyone invited to vote is
  invited to the plan too.
- **Make it the plan** (on any date, or **Make the leader the plan**) opens
  the usual plan form, filled in: that date as the plan (6pm if the date had
  no time) and the next most popular date as the backup. Post it, and:
  - Squad Up members who answered get the plan on their page and a message
    saying it's set.
  - Anyone who said that date works, or "if need be", is already marked in
    for it (and for the backup, if they said that works too).
  - The poll link then points to the plan, and voting closes.
- Guests carry over the same way, including names the organizer filled in
  and older name-only answers: each becomes a guest on the plan (no
  messages, ever), so their names show on it.
- "Let's do this sometime" ideas can use it too: **Pick a time** offers the
  same choice, and the idea comes off the list when the poll becomes a plan.

Limits: 40 dates and 150 answers per poll; names up to 40 characters.
Polls whose dates have all passed drop off the home page.

## Inviting someone new

Every plan and poll has a public link (`/squadup/a/{id}`, `/squadup/f/{id}`)
under **Send a link to anyone** in its Invite box. You send it yourself, from
your own phone or a group chat. Whoever opens it gets the welcome screen:
answer as a guest, or join with their own number or email. Squad Up never
texts or emails a number or address someone else typed in.

## Running it

```bash
npm install
npm start          # http://localhost:3000/squadup
npm test           # full lifecycle over real HTTP
python3 test_browser.py   # clicks through it in a real browser (needs Playwright)
```

With no environment variables set it stores everything in a local JSON file and
prints notifications to the console, so it runs with no external services.

## How it fits on extrarandom.com

extrarandom.com is GitHub Pages, which only serves static files, so this
folder lives there for two reasons: Pages serves its `index.html` as the
"door" at `extrarandom.com/squad-up/`, and Render runs the actual server
from the same folder. The homepage's TOOLS entry stays `file: "squad-up/"`.

The door page shows a "Waking up…" bubble while it pings the server (the free
tier naps after ~15 idle minutes), then hops over. Edit the one `APP` line at
the top of `index.html` once you know the Render address.

## Deploying to Render

**New → Web Service**, point at the `extrarandom-site` repo:

| Setting | Value |
|---|---|
| Root Directory | `squad-up` |
| Environment | Node |
| Build command | `npm install` |
| Start command | `npm start` |

Then set:

| Variable | What it does |
|---|---|
| `SUPABASE_URL` | switches storage from the JSON file to Supabase |
| `SUPABASE_SERVICE_KEY` | service key — server-side only, never the anon key |
| `RESEND_API_KEY` | switches notifications from console to real email |
| `SQUAD_FROM_EMAIL` | the from address (default `squadup@extrarandom.com`) |
| `SQUAD_BASE_URL` | optional — emailed links default to Render's own address; set this only if you add a custom domain |
| `CRON_SECRET` | guards `/squadup/cron/nudge` if you point a scheduler at it |

The old `HANG_FROM_EMAIL`, `HANG_BASE_URL` and `HANG_DB_FILE` names still work
if they're already set on Render.

Run `schema.sql` in the Supabase SQL editor once before first boot. It's safe
to run again later: every statement is `create ... if not exists`, so
re-running it after an update only adds what's new.

**Updating to v1.1:** run `schema.sql`, upload the new files, wait for Render
to restart, then run `schema.sql` once more. The first run adds the new
columns the code needs; the restart tidies any shared names; the second run
can then add the one-name rule (if it was skipped the first time, the SQL
editor shows a notice saying so).

**Tables.** Everything is prefixed `squad_` so it groups together in a
Supabase project shared with other extrarandom apps: `squad_people`,
`squad_tags`, `squad_subscriptions`, `squad_activities`,
`squad_activity_options`, `squad_responses`, `squad_ideas`,
`squad_idea_members`, `squad_invites`, `squad_sends`.

**Already ran the old Hang schema?** Run `rename_from_hang.sql` first. It
renames the old tables (keeping their data), then run `schema.sql`.

### The day-before reminder and sleeping instances

Render's free tier spins a service down when idle, and a sleeping process
fires no timers. So the reminder check runs on three triggers: an hourly interval while
awake, an opportunistic check on any incoming request (throttled to once every
ten minutes), and `GET /squadup/cron/nudge?key=$CRON_SECRET` for a real
scheduler. The same sweep archives "sometime" ideas past their four months
(they're already hidden from pages the moment they expire; the sweep just
tidies the table). The check looks for plans starting in the next 24 hours
rather than an exact minute, so a late run still catches them. Your
cron-job.org job hitting `/squadup/cron/nudge` every hour or so is plenty.

If the group uses the app most days, the request-triggered sweep is enough on
its own. If you want certainty, point any free scheduler (Render Cron, or
cron-job.org) at that URL once an hour.

**Row-level security is on for every `squad_` table, with no policies.** That
blocks the publishable ("anon") key completely, which matters because other
extrarandom pages put that key in public HTML, and `squad_people.personal_token`
is a login credential. The server uses the secret service key, which bypasses
RLS. Never put the service key in browser code.

## Places, editing, and Past Plans

**Editing the time:** a new time on the same day is a quiet tweak: everyone's
answers stay and nobody is messaged. Moving it to a different day clears the
answers for the old day. Changing the day or the place asks the organizer
whether to tell everyone (and, for a new day, ask them again).

- **Where (optional).** A plan can have a place, and it reads as part of the
  title: "Pickleball at Josh's place". Cards cut long titles to two lines;
  the plan page and emails show it whole.
- **The poster is in.** Whoever posts a plan is marked available for both
  times they set.
- **Edit.** The creator gets an Edit button on the plan. Changing the time,
  backup or place emails everyone who's in (and clears answers for a time that
  moved). Renames, notes and category changes save quietly. Delete lives at
  the bottom of the edit page.
- **Past Plans.** A plan stays on the home page through the day it happens,
  then moves to Past Plans, along with deleted plans. Past Plans shows everyone's,
  not just your categories, and each one has **Do it again**.

## Invites

Anyone signed in can invite people to a plan from the bottom of its page.
The picker lists everyone with a Squad Up link (names only, never emails),
with people into that plan's category first. Invited people get an email
with one-tap answers, see the plan on their home page, and hear about
changes, whatever categories they follow. The **Invited** list shows who's
been asked, with ✓ for in and ✗ for can't make it. Inviting someone twice
sends nothing. One person can send at most 40 invites a day
(`SQUAD_INVITES_PER_DAY`).

### Fill in for others

On plans and polls, the organizer has **Fill in for others**, for people who
answer by text or in person: type a name and **+ Add**, or tap a guest's
name. A bar says "Filling in for Sebastian" while you tap their times (or
Can't make it); **Done** goes back to your own. Guests only: people with an
account change their own (`/api/plan-guest`, `/api/poll-guest`).

### People added before October 2026

Before links replaced it, a friend could add someone by email or phone.
Those people (`confirmed_at` empty) still get **one message until they opt
in**: nothing else reaches them until they say they're in on a plan, tap
**Get Squad Up messages** on their page, follow a category, or text START.
Saying no, or just opening a link, doesn't opt anyone in.
`/api/invite-new` and `/api/poll-invite-new` now refuse (410).

## Stopping messages

Every email has a "Stop all Squad Up messages" link at the bottom, and
texting STOP does the same. Someone who stops gets nothing at all: no
invites, no updates, no reminders. Their page still works and shows a way
to turn messages back on (or text START).

## Texting (Twilio)

Off until these are set on Render and `SQUAD_SMS_LIVE=on`. Once on, anyone with a phone number is
texted instead of emailed.

| Variable | What |
|---|---|
| `TWILIO_ACCOUNT_SID` | from the Twilio console (starts with `AC`) |
| `TWILIO_AUTH_TOKEN` | from the Twilio console; also used to check incoming texts really came from Twilio. Keep it secret |
| `TWILIO_FROM` | your Twilio number (`+1...`) or a Messaging Service id (`MG...`) |
| `SQUAD_SMS_LIVE` | `on` to actually send texts. Until then (while carrier registration is pending) everyone is reached by email, phone boxes say "(Coming Soon)", and an email is required. Numbers are still saved |
| `SQUAD_SMS_TEST_NUMBERS` | optional test mode: comma-separated numbers that get texts; everyone else stays on email. Use it while Twilio is on a trial or waiting on registration, then delete it to text everyone |

Trial Twilio accounts can only text numbers you've verified in Twilio, so
set `SQUAD_SMS_TEST_NUMBERS` to those numbers while testing.

Then in Twilio, set the number's (or Messaging Service's) incoming-message
webhook to `POST https://<render-address>/squadup/sms/inbound`.

People can text back `YES`, `NO`, a number (`1`, `2`) to pick a time, `BOTH`,
`ADD` (the organizer, to accept a suggested time), `STOP`/`START`, or `HELP`.
A reply answers the last thing Squad Up asked that person, within two weeks.
Texts from numbers we don't know get no reply. Replies count toward the
daily text limits.

US numbers need A2P 10DLC registration in Twilio before texts are
delivered; since September 2023 Twilio blocks texts from unregistered US
local numbers (error 30034). Twilio walks you through it, and it takes a few
days.

### Registering for 10DLC (consent, Terms, Privacy)

Carriers review how people agree to texts. What the app does, so the
registration can describe it truthfully:

- **The only way in is the web form** (`/squadup/join`, or **Get updates**
  on the welcome screen any shared link opens): the person types their own
  number. The text box reads "Text me about Squad Up plans I'm invited to
  (invites, times, confirmations, reminders). From Extrarandom. Msg frequency
  varies; msg & data rates may apply. Reply HELP for help, STOP to opt out."
  It and the Terms box are never pre-checked. A phone number is only saved
  with the text box ticked. The first text then names the program and says
  how often, how to get help and how to stop.
- **Nobody can add someone else's number.** Invites to new people are a link
  the inviter sends themselves.
- **Pages**: `/squadup/terms` and `/squadup/privacy` (text in `lib/legal.js`,
  contact address `SQUAD_CONTACT_EMAIL`, default `GinZ@Extrarandom.com`).
  Every page has a Terms / Privacy / Contact footer.
- **Switch**: `SQUAD_FIRST_TEXT=off` stops texting anyone who hasn't opted in
  (only people added before October 2026 can be in that state).
- **Sign-up brakes**: 5 phone sign-ups per address per hour and 30 a day
  (`SQUAD_PHONE_SIGNUPS_PER_IP_HOUR`, `SQUAD_PHONE_SIGNUPS_PER_DAY`), so the
  form can't be used to text strangers' numbers.
- **STOP / HELP / START**: set Twilio's replies under Messaging > Services >
  Opt-Out Management to the wording in `lib/legal.js` (`STOP_REPLY`,
  `HELP_REPLY`, `START_REPLY`). When Twilio answers one of these it tells us
  (`OptOutType`), and the app skips its own reply so nobody gets two.

**Render's free plan sleeps** after about 15 idle minutes, and waking takes
longer than Twilio waits for a reply, so a texted answer after a quiet
stretch can be lost. Point a scheduler (cron-job.org) at
`https://<render-address>/health` every 10 minutes, or use a paid Render
instance.

## Send limits

Every email goes through one checkpoint that counts what went out in the
last 24 hours, logged in `squad_sends` so a restart doesn't reset it, with an
in-memory count as a backstop if the database is unreachable. Anything over
a limit is skipped, logged on Render, and never retried. Texts get their own,
lower limits for when SMS is turned on.

| Limit | Default | Variable |
|---|---|---|
| Emails to any one person | 15/day | `SQUAD_EMAIL_PER_PERSON_DAY` |
| "Here's your link" emails to one person | 3/day | `SQUAD_LINK_EMAILS_PER_DAY` |
| All emails combined | 95/day (Resend free tier is 100) | `SQUAD_EMAIL_PER_DAY` |
| Texts to any one person | 5/day | `SQUAD_SMS_PER_PERSON_DAY` |
| All texts combined | 50/day | `SQUAD_SMS_PER_DAY` |
| Invites sent by one person | 40/day | `SQUAD_INVITES_PER_DAY` |
| Brand-new people one person can add | 10/day | `SQUAD_NEW_PEOPLE_PER_DAY` |


## Answering from email

Every email to someone already signed up carries their key in its links, so
they land signed in. Emails that ask a question have buttons:

| Email | Buttons |
|---|---|
| New plan | each time "works", "Both work" (if two), "Can't make it" |
| Time moved / backup changed | the new time(s), "Can't make it" |
| New time added | that time "works" |
| Someone suggested a time (to the creator) | "Add it" |
| Day-before reminder (to the creator) | "Edit the plan" |

A button opens `/squadup/r/<plan>?t=<key>&do=<answer>`, a tiny page that saves
the answer and shows the plan with a "Saved" note. Opening the URL alone
changes nothing; the save happens in the page's script. That way mail
scanners that pre-open links can't answer for anyone. Text-message replies,
when SMS is turned on, will map onto these same answers.

## Layout

```
lib/core.js     tallies, switch suggestions, time zones, the day-before timing, idea expiry — pure, no I/O
lib/db.js       storage; JSON-file adapter for dev, Supabase for production
lib/notify.js   one send interface; console and email now, SMS later
lib/colors.js   category name -> color family
lib/theme.js    the stylesheet (glossy bubbles; color comes from --h/--l)
lib/views.js    server-rendered pages
server/index.js routes, permissions, notification fan-out, the nudge job
schema.sql      Supabase tables (squad_ prefix, RLS on)
rename_from_hang.sql   one-time rename if the old Hang tables exist
test_squad.js   83 checks across the whole lifecycle
test_browser.py 30 checks clicking through it in Chromium
```

All the decisions live in `core.js` as pure functions, which is why the tests
can cover things like "a better-attended time doesn't switch on its own"
without standing up a database.

## SMS later

`lib/notify.js` has one `send(person, msg)` interface with the Twilio backend
stubbed in the same shape. Turning on texts means filling in that backend and
adding a per-person channel preference — no call sites change.

Worth knowing before that work starts: WhatsApp and Instagram both look like
free alternatives and aren't. WhatsApp only makes messages free inside a
24-hour window the *recipient* opened, which a "climbing on Thursday"
announcement falls outside of, and it needs a Business Solution Provider on
top. Instagram's messaging API needs a Business account, a Meta app, and App
Review, and unofficial bulk-DM tooling is a common cause of account
suspensions. Plain SMS through Twilio is cheaper and far less work than either.

## Deliberately not built

- No public discovery or stranger matching — this is a closed group
- No native app
- No capacity limits or waitlists
- No approval on new categories; anyone can make one
- No per-person time zone setting: each plan has a zone, and each phone shows
  its own time next to it

## Small settings

- `SQUAD_WITH` (default `Gin`): the header reads "Squad Up with Gin". Later
  this can become one per squad ("with The Smiths").
- `SQUAD_TIMEZONE` (default `America/New_York`): the squad's home time zone.
  No `TZ` setting is needed on Render; the app never uses the server's clock
  zone.
- **Your account** (bottom of the home page): **Edit your info**, **Log out
  of all other devices**, and **Delete my account**. Deleting asks first and
  lists what it takes with it: upcoming plans and open polls they're
  organizing are called off (everyone in is told), their ideas come off the
  list, and their answers and votes go. Past plans stay, without their name.
- **Edit your info**: name, phone
  and email can be changed. A new phone number needs the same "Text me" box
  as signing up, and a phone or email already used by someone else is refused.
