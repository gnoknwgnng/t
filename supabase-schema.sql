-- PostCraft AI Supabase Schema
-- Run this script in Supabase SQL Editor (SQL Editor -> New Query -> Run)
--
-- DESIGN NOTE: user_id is stored as nullable TEXT (not UUID NOT NULL REFERENCES auth.users).
-- The app identifies users by LinkedIn memberId. Derived UUIDs are NOT used as FKs because
-- the app does not create Supabase Auth users — doing so would fail with an FK violation.
-- RLS policies use the linkedin_member_id column for ownership checks instead of auth.uid().

-- Every person who has ever signed in with LinkedIn gets exactly one row here, keyed by
-- their stable LinkedIn member id (the same id used as user_id everywhere else). This is
-- the registry of "all users" — separate from `accounts`, which is about connected
-- LinkedIn publishing credentials specifically. telegram_chat_id links this profile to a
-- specific Telegram chat so scheduled-post confirmations reach the right person and only
-- that person.
create table if not exists public.postcraft_profiles (
  id text primary key,                    -- LinkedIn member id
  email text,
  display_name text,
  profile_picture text,
  telegram_chat_id text,
  telegram_link_code text,
  telegram_link_code_expires_at timestamptz,
  created_at timestamptz not null default now(),
  last_login_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists postcraft_profiles_telegram_chat_id_unique
  on public.postcraft_profiles (telegram_chat_id)
  where telegram_chat_id is not null;

alter table public.postcraft_profiles disable row level security;

create table if not exists public.accounts (
  id text primary key,
  user_id text,                          -- nullable, no FK to auth.users
  platform text not null default 'linkedin' check (platform = 'linkedin'),
  display_name text not null,
  access_token text not null,
  author_urn text not null,
  linkedin_member_id text,
  email text,
  profile_picture text,
  auth_type text not null default 'oauth',
  status text not null default 'connected',
  token_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists accounts_user_id_idx on public.accounts (user_id);
create index if not exists accounts_linkedin_member_id_idx on public.accounts (linkedin_member_id);

create unique index if not exists accounts_linkedin_member_id_unique
  on public.accounts (linkedin_member_id)
  where linkedin_member_id is not null;

create table if not exists public.schedules (
  id text primary key,
  user_id text,                          -- nullable, no FK to auth.users
  platform text not null default 'linkedin' check (platform = 'linkedin'),
  account_id text not null references public.accounts(id) on delete cascade,
  company_name text not null,
  website text,
  industry text not null,
  services jsonb not null default '[]'::jsonb,
  country_code text not null default 'US',
  mode text not null default 'rotation',
  categories jsonb not null default '["tech", "science", "dental"]'::jsonb,
  posts_per_week integer not null check (posts_per_week between 1 and 10),
  preferred_hour integer not null default 10 check (preferred_hour between 0 and 23),
  start_date timestamptz not null,
  end_date timestamptz not null,
  active boolean not null default true,
  created_at timestamptz not null default now()

);

create index if not exists schedules_user_id_idx on public.schedules (user_id);
create index if not exists schedules_account_idx on public.schedules (account_id);

create table if not exists public.queue_items (
  id text primary key,
  user_id text,                          -- nullable, no FK to auth.users
  schedule_id text not null references public.schedules(id) on delete cascade,
  account_id text not null references public.accounts(id) on delete cascade,
  platform text not null default 'linkedin' check (platform = 'linkedin'),
  status text not null default 'scheduled' check (status in ('scheduled', 'publishing', 'pending_confirmation', 'published', 'failed')),
  scheduled_for timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  published_at timestamptz,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  provider_id text,
  provider_response jsonb,
  error text,
  error_status integer
);

create index if not exists queue_items_user_id_idx on public.queue_items (user_id);
create index if not exists queue_items_account_idx on public.queue_items (account_id);
create index if not exists queue_items_schedule_time_idx on public.queue_items (status, scheduled_for);

-- Row Level Security (RLS)
-- Because there is no Supabase Auth session, RLS is disabled by default so the
-- service-role key can read/write freely. Enable and customise these policies
-- if you add Supabase Auth sign-in in the future.
alter table public.accounts disable row level security;
alter table public.schedules disable row level security;
alter table public.queue_items disable row level security;

-- ---------------------------------------------------------------------------
-- Migration for databases created before the `postcraft_profiles` table and the
-- `pending_confirmation` queue status existed (safe to re-run any time —
-- every statement below is idempotent).
-- ---------------------------------------------------------------------------
alter table public.queue_items drop constraint if exists queue_items_status_check;
alter table public.queue_items add constraint queue_items_status_check
  check (status in ('scheduled', 'publishing', 'pending_confirmation', 'published', 'failed'));
