-- SQUAD UP — Supabase schema
-- Every table is prefixed squad_ so they group together in the table list.
-- Safe to run again: everything is create-if-not-exists.
-- Times are naive local strings (no timezone): the group shares one, so
-- there is nothing to convert and nothing to drift.

create table if not exists squad_people (
  id            text primary key,
  name          text not null,
  email         text not null,
  phone         text,
  personal_token text not null unique,
  created_at    timestamptz not null default now()
);
create unique index if not exists squad_people_email_lower on squad_people (lower(email));
-- added later (all safe to re-run):
-- people can be invited by phone alone, so email is optional
alter table squad_people alter column email drop not null;
alter table squad_people add column if not exists invited_by   text references squad_people(id) on delete set null;
alter table squad_people add column if not exists confirmed_at timestamptz;  -- null = invited, hasn't answered yet
alter table squad_people add column if not exists opted_out_at timestamptz;  -- asked for no messages at all
alter table squad_people add column if not exists invite_sent_at timestamptz; -- their one invite went out; nothing more until they opt in
-- people invited before this column existed already had their invite
update squad_people set invite_sent_at = created_at
  where confirmed_at is null and invited_by is not null and invite_sent_at is null;
-- everyone who signed up themselves counts as confirmed
-- (guests, who gave just a name, never count: they get no messages)
update squad_people set confirmed_at = created_at where confirmed_at is null and invited_by is null
  and (email is not null or phone is not null);
-- phone numbers are stored as +<digits> so a texted reply can be matched
update squad_people set phone = null where phone is not null and btrim(phone) = '';
update squad_people set phone = case
    when length(regexp_replace(phone, '\D', '', 'g')) = 10 then '+1' || regexp_replace(phone, '\D', '', 'g')
    when length(regexp_replace(phone, '\D', '', 'g')) = 11 and regexp_replace(phone, '\D', '', 'g') like '1%'
      then '+' || regexp_replace(phone, '\D', '', 'g')
    else phone end
  where phone is not null and phone !~ '^\+[0-9]+$';
create index if not exists squad_people_phone on squad_people (phone);
create index if not exists squad_people_invited_by on squad_people (invited_by, created_at);

create table if not exists squad_tags (
  id         text primary key,
  name       text not null,
  created_by text references squad_people(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists squad_tags_name_lower on squad_tags (lower(name));

create table if not exists squad_subscriptions (
  person_id text not null references squad_people(id) on delete cascade,
  tag_id    text not null references squad_tags(id)   on delete cascade,
  primary key (person_id, tag_id)
);

create table if not exists squad_activities (
  id               text primary key,
  creator_id       text not null references squad_people(id) on delete cascade,
  title            text not null,
  tag_id           text not null references squad_tags(id) on delete restrict,
  note             text,
  locked_option_id text,
  canceled_at      timestamptz,
  canceled_reason  text,
  finalize_nudge_sent_at timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists squad_activities_tag on squad_activities (tag_id);
-- added later; harmless if it's already there
alter table squad_activities add column if not exists location text;

create table if not exists squad_activity_options (
  id          text primary key,
  activity_id text not null references squad_activities(id) on delete cascade,
  starts_at   text not null,                    -- "2026-04-16T18:00", local
  label       text,
  kind        text not null default 'suggested',-- primary | backup | suggested
  status      text not null default 'pending',  -- approved | pending
  proposed_by text references squad_people(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists squad_options_activity on squad_activity_options (activity_id);

create table if not exists squad_responses (
  activity_id text not null references squad_activities(id) on delete cascade,
  person_id   text not null references squad_people(id)     on delete cascade,
  option_ids  text[] not null default '{}',
  can_make_it boolean not null default true,
  created_at  timestamptz not null default now(),
  primary key (activity_id, person_id)
);

-- "Let's do this sometime": an activity people want to do, with no time yet.
-- Visible to everyone regardless of category, never notifies on its own.
create table if not exists squad_ideas (
  id                    text primary key,
  creator_id            text not null references squad_people(id) on delete cascade,
  title                 text not null,
  tag_id                text not null references squad_tags(id) on delete restrict,
  note                  text,
  created_at            timestamptz not null default now(),
  last_joined_at        timestamptz not null default now(), -- expiry clock restarts here
  last_nudge_at         timestamptz,                        -- one nudge a week
  last_nudge_by         text references squad_people(id) on delete set null,
  archived_at           timestamptz,                        -- expired, emptied, or scheduled
  converted_activity_id text references squad_activities(id) on delete set null
);
create index if not exists squad_ideas_live on squad_ideas (archived_at);

create table if not exists squad_idea_members (
  idea_id   text not null references squad_ideas(id)  on delete cascade,
  person_id text not null references squad_people(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (idea_id, person_id)
);

-- Invites: someone personally asked this person to a plan. They get the
-- plan's updates from then on, whatever categories they follow.
create table if not exists squad_invites (
  activity_id text not null references squad_activities(id) on delete cascade,
  person_id   text not null references squad_people(id)     on delete cascade,
  invited_by  text references squad_people(id) on delete set null,
  invited_at  timestamptz not null default now(),
  primary key (activity_id, person_id)
);
create index if not exists squad_invites_by on squad_invites (invited_by, invited_at);

-- Every email/text that goes out, so daily limits survive restarts.
-- Rows older than a week are deleted by the hourly sweep.
create table if not exists squad_sends (
  id        text primary key,
  person_id text references squad_people(id) on delete cascade,
  channel   text not null,          -- email | sms
  kind      text,                   -- link | invite | ... (null = general)
  sent_at   timestamptz not null default now()
);
create index if not exists squad_sends_when on squad_sends (channel, sent_at);
create index if not exists squad_sends_person on squad_sends (person_id, sent_at);
-- which plan a message asked about, so a texted "yes" knows what it's for
alter table squad_sends add column if not exists activity_id text;
alter table squad_sends add column if not exists ask_options text;  -- the times it asked about, in reply order

-- "Find a time": the organizer offers several dates, anyone with the link
-- answers with just a name, and the organizer turns the winner into a plan.
create table if not exists squad_polls (
  id           text primary key,
  creator_id   text not null references squad_people(id) on delete cascade,
  title        text not null,
  location     text,
  note         text,
  idea_id      text references squad_ideas(id) on delete set null,  -- started from "Let's do this sometime"
  created_at   timestamptz not null default now(),
  finalized_at timestamptz,                                         -- turned into a plan
  activity_id  text references squad_activities(id) on delete set null,
  canceled_at  timestamptz
);
create table if not exists squad_poll_options (
  id         text primary key,
  poll_id    text not null references squad_polls(id) on delete cascade,
  day        text not null,      -- "2026-10-24", local
  time       text,               -- "19:00", or null for any time that day
  created_at timestamptz not null default now()
);
create index if not exists squad_poll_options_poll on squad_poll_options (poll_id);
create table if not exists squad_poll_votes (
  id         text primary key,
  poll_id    text not null references squad_polls(id) on delete cascade,
  name       text not null,
  person_id  text references squad_people(id) on delete set null,  -- null = a guest with just a name
  voter_key  text not null,      -- lets a guest's phone change their own answers; never shown
  option_ids text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists squad_poll_votes_poll on squad_poll_votes (poll_id);
create index if not exists squad_poll_votes_person on squad_poll_votes (person_id);
-- one answer per guest name, and one per Squad Up member, in each poll
create unique index if not exists squad_poll_votes_guest_name on squad_poll_votes (poll_id, lower(name)) where person_id is null;
create unique index if not exists squad_poll_votes_member on squad_poll_votes (poll_id, person_id) where person_id is not null;
-- added later (safe to re-run): "if need be" answers, and a category per poll
alter table squad_poll_votes add column if not exists maybe_ids text[] not null default '{}';
alter table squad_polls add column if not exists tag_id text references squad_tags(id) on delete set null;
-- people the organizer asked to vote; it shows on their home page
create table if not exists squad_poll_invites (
  poll_id    text not null references squad_polls(id) on delete cascade,
  person_id  text not null references squad_people(id) on delete cascade,
  invited_by text references squad_people(id) on delete set null,
  invited_at timestamptz not null default now(),
  primary key (poll_id, person_id)
);
create index if not exists squad_poll_invites_by on squad_poll_invites (invited_by, invited_at);

-- Row-level security ON, with no policies: the browser-facing publishable
-- ("anon") key can read and write nothing here. That matters because the
-- same Supabase project serves other extrarandom pages whose publishable key
-- is public, and squad_people.personal_token is a login credential. The
-- Squad Up server uses the secret service key, which bypasses RLS.
alter table squad_people           enable row level security;
alter table squad_tags             enable row level security;
alter table squad_subscriptions    enable row level security;
alter table squad_activities       enable row level security;
alter table squad_activity_options enable row level security;
alter table squad_responses        enable row level security;
alter table squad_ideas            enable row level security;
alter table squad_idea_members     enable row level security;
alter table squad_invites          enable row level security;
alter table squad_sends            enable row level security;
alter table squad_polls            enable row level security;
alter table squad_poll_options     enable row level security;
alter table squad_poll_votes       enable row level security;
alter table squad_poll_invites     enable row level security;
