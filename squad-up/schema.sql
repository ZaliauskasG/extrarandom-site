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
