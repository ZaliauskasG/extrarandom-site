-- Pick Sheet Converter: roster storage. Run once in Supabase > SQL Editor.
create extension if not exists pgcrypto with schema extensions;

create table if not exists pool_roster (
  id bigint generated always as identity primary key,
  name text not null,
  position int not null default 0
);
alter table pool_roster enable row level security;
drop policy if exists "anyone can read the roster" on pool_roster;
create policy "anyone can read the roster" on pool_roster for select using (true);
-- no insert/update/delete policies: changes only go through save_pool_roster

create table if not exists pool_settings (key text primary key, value text not null);
alter table pool_settings enable row level security;   -- no policies: invisible to visitors

insert into pool_settings (key, value)
values ('roster_passcode_hash', extensions.crypt('Nathan', extensions.gen_salt('bf')))
on conflict (key) do update set value = excluded.value;

create or replace function save_pool_roster(passcode text, names text[])
returns int language plpgsql security definer set search_path = public, extensions as $$
declare h text;
begin
  select value into h from pool_settings where key = 'roster_passcode_hash';
  if h is null or crypt(passcode, h) <> h then
    raise exception 'Wrong password';
  end if;
  delete from pool_roster where true;
  insert into pool_roster (name, position)
    select trim(n), ord from unnest(names) with ordinality as t(n, ord) where trim(n) <> '';
  return (select count(*) from pool_roster);
end $$;
revoke all on function save_pool_roster(text, text[]) from public;
grant execute on function save_pool_roster(text, text[]) to anon;

-- starting list (same as NFL_Regulars.txt)
delete from pool_roster where true;
insert into pool_roster (name, position) select n, ord from unnest(array[
 'Chrissy C','Vince Z','Schelle B','Gin Z','Aryvelle Z','Sabrina S','Mike M','Steve N','Pam B','Angelo B',
 'Chris T','Eli E','Melanie G','Todd H','Dave B','Adrian L','Michael C','Carlton N','Linda G','Bill G',
 'John R','Kim R','Phil T','Andrea M','John M','Elizabeth M','Luke C','Tresa C','Jessica O','Bob C',
 'Jade C','Joey C','Amanda D','Jacoah J','Andrea J','Noah J','Sawyer J','Andy T','Floyd C','Nathan R',
 'Caylin R','Lee R']) with ordinality as t(n, ord);
