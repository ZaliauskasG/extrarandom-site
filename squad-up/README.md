# Squad Up

Standing invitations for a group of friends. Someone posts an activity with a
time and a fallback; whoever follows that category hears about it and taps once
to say they're in. Nobody installs anything and nobody has a password.

Opens from `extrarandom.com/squad-up/`; the server runs on Render.

---

## How identity works

There are no accounts in the usual sense. Signing up creates a person and hands
back one permanent private URL:

```
<render-address>/squadup/p/{personal_token}
```

That link **is** the login. It isn't a session, a cookie, or anything tied to a
device or IP, so a VPN, a new phone, or cleared browser data don't affect it.
The flip side: it's a bearer credential, so anyone holding it can act as that
person. That's a fine trade for a private friend-group tool (Calendly and Doodle
links work the same way), and there's a "Replace this link" button for the rare
case one leaks.

Tokens are 24 random bytes. Never sequential, never guessable.

If someone signs up with an email that already exists, the existing link is
**emailed to that address** rather than shown on screen — otherwise typing a
friend's address would hand you their identity.

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
- **10am the day before**, the creator gets a single summary of where everyone
  landed and can change it or leave it. No reply means no change.
- The creator can call the whole thing off, with an optional reason. Everyone
  who follows the category or already responded gets told.

Times are stored as naive local strings (`2030-04-18T18:00`). The whole group
shares one timezone, so there's nothing to convert and nothing to drift.

## Categories

Tags are made up as you go — when posting, pick an existing one or name a new
one. A brand-new category **subscribes everyone by default**, because
otherwise its first activity would notify nobody. People prune from their own
page afterward.

Every category gets a color automatically from its name (`lib/colors.js`), so
nobody picks one and the same name is always the same color. Names that sound
alike share a color family:

| Family | Color | Matches names like |
|---|---|---|
| Sports & active | red | climbing, paintball, pickleball, running, gym |
| Food | orange | brunch, BBQ, ramen, coffee, potluck |
| Drinks | gold | breweries, wine, happy hour |
| Outdoors | green | hiking, camping, parks, biking |
| Water | aqua | beach, kayaking, pool, fishing, springs |
| Trips | blue | road trips, getaways, theme parks |
| Games | violet | board games, trivia, poker, escape rooms |
| Shows & arts | purple | concerts, movies, comedy, museums, pottery |
| Social | pink | parties, karaoke, birthdays, dancing |

Anything unrecognized gets a steady color from the gaps between those
families. To move a word to a different family, edit the lists at the top of
`lib/colors.js`.

## Let's do this sometime

Below the scheduled activities is a list of things people want to do with no
date attached — "Beach day", "Kayaking", "That new ramen place".

- **Anyone can add one** (a title, a category, an optional note). Whoever adds
  it is automatically in.
- **Everyone sees the whole list**, whatever categories they follow. The point
  is to nudge people slightly outside their usual lanes.
- **Nobody is ever notified** about an idea being posted, joined, or left.
  It's just there whenever someone opens the app.
- **I'm in / You're in** adds or removes your name. You can leave any time;
  when the last person leaves, the idea comes off the list.
- **Someone should schedule this** — anyone on the list can email everyone
  else on that list. Once per idea per week, whoever sends it, so it can't
  turn into a notification stream.
- **Pick a time** — anyone, on the list or not, can turn it into a real
  activity. The new-activity form opens pre-filled with the title, category
  and note. Once it's posted, the idea comes off the list, and everyone who
  was on it is emailed along with the category's usual followers — even
  people who don't follow that category, since they said they wanted this.
- **Fading out:** an idea leaves the list four months after the last time
  someone new joined it. Each new name restarts the clock, so ideas people keep
  signing on to stay up and forgotten ones disappear quietly. The card shows the
  date once it's within a month.

Ideas live in their own two tables (`ideas`, `idea_members`) rather than as
activities without times, so none of the RSVP, switch-suggestion or
day-before logic has to know they exist.

## Inviting someone new

Every activity has its own shareable link (`/squadup/a/{id}`) — that's what gets
pasted into a group chat. Anyone can open it and see the whole thing: times,
who's in, the details. No wall. Tapping **I'm in** is what asks for a name and
email, and that one step signs them up, subscribes them to that one category
(not everything), records their RSVP, and emails them their personal link.

There's also `/squadup/join` for adding someone ahead of any particular activity.

---

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

**Tables.** Everything is prefixed `squad_` so it groups together in a
Supabase project shared with other extrarandom apps: `squad_people`,
`squad_tags`, `squad_subscriptions`, `squad_activities`,
`squad_activity_options`, `squad_responses`, `squad_ideas`,
`squad_idea_members`, `squad_invites`, `squad_sends`.

**Already ran the old Hang schema?** Run `rename_from_hang.sql` first. It
renames the old tables (keeping their data), then run `schema.sql`.

### The day-before nudge and sleeping instances

Render's free tier spins a service down when idle, and a sleeping process
fires no timers. So the nudge runs on three triggers: an hourly interval while
awake, an opportunistic check on any incoming request (throttled to once every
ten minutes), and `GET /squadup/cron/nudge?key=$CRON_SECRET` for a real
scheduler. The same sweep archives "sometime" ideas past their four months
(they're already hidden from pages the moment they expire; the sweep just
tidies the table). The check is time-of-day based rather than exact-minute, so a late
run still catches whatever is pending that day.

If the group uses the app most days, the request-triggered sweep is enough on
its own. If you want certainty, point any free scheduler (Render Cron, or
cron-job.org) at that URL once an hour.

**Row-level security is on for every `squad_` table, with no policies.** That
blocks the publishable ("anon") key completely, which matters because other
extrarandom pages put that key in public HTML, and `squad_people.personal_token`
is a login credential. The server uses the secret service key, which bypasses
RLS. Never put the service key in browser code.

## Places, editing, and Past Plans

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

The idea nudge keeps its own once-a-week rule on top of these.

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
lib/core.js     tallies, switch suggestions, nudge timing, idea expiry — pure, no I/O
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
- No per-user timezones
