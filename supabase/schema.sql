-- ============================================================
-- Team Allied — BD Command Center
-- Run this once in Supabase → SQL Editor → New query → Run.
-- ============================================================

-- 1. WHO IS ALLOWED IN -------------------------------------------------
-- Nothing works until an email is in this table. Google Sign-In gets you
-- to the door; this table decides whether the door opens.
create table if not exists public.members (
  email text primary key,
  name  text,
  role  text not null default 'rep' check (role in ('rep','manager','admin')),
  added_at timestamptz not null default now()
);

-- >>> EDIT THESE, then run. Add your reps here. <<<
insert into public.members (email, name, role) values
  ('michael@teamallied.co', 'Michael Tabayoyon', 'admin')
on conflict (email) do nothing;

-- helper: is the person calling this query on the list?
create or replace function public.is_member()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.members
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email',''))
  );
$$;


-- 2. ACCOUNTS ----------------------------------------------------------
-- One row per account. The whole account (incl. its buildings, shutoffs,
-- contacts, vulnerabilities) lives in `payload` as JSON. Writes are scoped
-- to a single account, so two reps working different accounts never
-- clobber each other.
create table if not exists public.accounts (
  id          text primary key,
  payload     jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

create index if not exists accounts_updated_idx on public.accounts (updated_at desc);
create index if not exists accounts_stage_idx   on public.accounts ((payload ->> 'stage'));

alter table public.accounts enable row level security;

drop policy if exists accounts_rw on public.accounts;
create policy accounts_rw on public.accounts
  for all to authenticated
  using (public.is_member())
  with check (public.is_member());

-- stamp who touched it, and when
create or replace function public.stamp_row()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.jwt() ->> 'email', new.updated_by);
  return new;
end; $$;

drop trigger if exists accounts_stamp on public.accounts;
create trigger accounts_stamp before insert or update on public.accounts
  for each row execute function public.stamp_row();


-- 3. WEEKLY ACTIVITY ---------------------------------------------------
-- Per rep, per week. Each rep only sees and writes their own numbers.
create table if not exists public.weeks (
  email      text not null,
  week       date not null,
  payload    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (email, week)
);

alter table public.weeks enable row level security;

drop policy if exists weeks_own on public.weeks;
create policy weeks_own on public.weeks
  for all to authenticated
  using (public.is_member() and lower(email) = lower(auth.jwt() ->> 'email'))
  with check (public.is_member() and lower(email) = lower(auth.jwt() ->> 'email'));

-- managers can read the whole team's numbers
drop policy if exists weeks_manager_read on public.weeks;
create policy weeks_manager_read on public.weeks
  for select to authenticated
  using (exists (
    select 1 from public.members m
    where lower(m.email) = lower(auth.jwt() ->> 'email')
      and m.role in ('manager','admin')
  ));


-- 4. MEMBERS TABLE POLICIES -------------------------------------------
alter table public.members enable row level security;

drop policy if exists members_read on public.members;
create policy members_read on public.members
  for select to authenticated using (public.is_member());

drop policy if exists members_admin on public.members;
create policy members_admin on public.members
  for all to authenticated
  using (exists (select 1 from public.members m
                 where lower(m.email) = lower(auth.jwt() ->> 'email') and m.role = 'admin'))
  with check (exists (select 1 from public.members m
                 where lower(m.email) = lower(auth.jwt() ->> 'email') and m.role = 'admin'));


-- 5. PHOTO STORAGE -----------------------------------------------------
-- Shutoff photos, mechanical rooms, damage. Private bucket — images are
-- served through short-lived signed URLs, never public links.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('arp-photos', 'arp-photos', false, 10485760,
        array['image/jpeg','image/png','image/webp','image/heic'])
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists arp_photos_rw on storage.objects;
create policy arp_photos_rw on storage.objects
  for all to authenticated
  using (bucket_id = 'arp-photos' and public.is_member())
  with check (bucket_id = 'arp-photos' and public.is_member());


-- ============================================================
-- Done. Now: Authentication → Providers → enable Google.
-- Then add your GitHub Pages URL under Authentication → URL Configuration.
-- ============================================================
