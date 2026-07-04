-- ============================================================
-- nyx — Supabase schema
-- Run this once in the Supabase SQL Editor.
--
-- IMPORTANT: Disable email confirmation first:
--   Authentication → Settings → Email Auth → Confirm email → OFF
-- ============================================================

-- User wallets (self-custody Canton parties)
create table if not exists public.wallets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users not null,
  party_id    text not null,
  name        text not null,
  created_at  timestamptz default now()
);

alter table public.wallets enable row level security;

-- Users can only see and manage their own wallets
create policy "own wallets" on public.wallets
  for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Login / wallet-connect audit log
create table if not exists public.login_events (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users not null,
  wallet_party_id text,
  created_at      timestamptz default now()
);

alter table public.login_events enable row level security;

create policy "own events" on public.login_events
  for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);
