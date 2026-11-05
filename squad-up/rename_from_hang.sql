-- ONLY if you already ran the old Hang schema.sql in Supabase.
-- Renames those tables to the squad_ names, keeping any data in them, and
-- locks them down. If you never ran the Hang schema, skip this file and just
-- run schema.sql.
--
-- Check first: the old names (people, tags, activities...) are generic. If
-- another app in the same Supabase project has a table with one of these
-- names, rename only the ones that belong to Hang.

alter table if exists people           rename to squad_people;
alter table if exists tags             rename to squad_tags;
alter table if exists subscriptions    rename to squad_subscriptions;
alter table if exists activities       rename to squad_activities;
alter table if exists activity_options rename to squad_activity_options;
alter table if exists responses        rename to squad_responses;
alter table if exists ideas            rename to squad_ideas;
alter table if exists idea_members     rename to squad_idea_members;

alter index if exists people_email_lower rename to squad_people_email_lower;
alter index if exists tags_name_lower    rename to squad_tags_name_lower;
alter index if exists activities_tag     rename to squad_activities_tag;
alter index if exists options_activity   rename to squad_options_activity;
alter index if exists ideas_live         rename to squad_ideas_live;

-- constraint names (primary keys, unique tokens, foreign keys) get the prefix too
do $$
declare r record;
begin
  for r in select c.conname, t.relname from pg_constraint c
           join pg_class t on t.oid = c.conrelid
           where t.relname like 'squad\_%' and c.conname not like 'squad\_%'
  loop
    execute format('alter table %I rename constraint %I to %I', r.relname, r.conname, 'squad_' || r.conname);
  end loop;
end $$;

-- then run schema.sql: it creates anything missing and turns on
-- row-level security for every squad_ table
