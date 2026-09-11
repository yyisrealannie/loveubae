create table if not exists public.milk_sync (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.milk_sync enable row level security;

drop policy if exists "Users can read their own milk backup" on public.milk_sync;
create policy "Users can read their own milk backup"
on public.milk_sync for select
using (auth.uid() = user_id);

drop policy if exists "Users can insert their own milk backup" on public.milk_sync;
create policy "Users can insert their own milk backup"
on public.milk_sync for insert
with check (auth.uid() = user_id);

drop policy if exists "Users can update their own milk backup" on public.milk_sync;
create policy "Users can update their own milk backup"
on public.milk_sync for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

grant usage on schema public to authenticated;
grant select, insert, update on public.milk_sync to authenticated;

create table if not exists public.milk_push_subscriptions (
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null,
  subscription jsonb not null,
  partner_name text not null default '对方',
  privacy_mode text not null default 'full' check (privacy_mode in ('full', 'generic', 'off')),
  reply_pool jsonb not null default '[]'::jsonb,
  active_until timestamptz not null,
  next_push_at timestamptz not null,
  push_interval_minutes integer not null default 5 check (push_interval_minutes between 1 and 120),
  updated_at timestamptz not null default now(),
  primary key (user_id, endpoint)
);

alter table public.milk_push_subscriptions
add column if not exists push_interval_minutes integer not null default 5;

create table if not exists public.milk_push_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  body text not null,
  sent_at timestamptz not null default now(),
  imported_at timestamptz
);

alter table public.milk_push_subscriptions enable row level security;
alter table public.milk_push_messages enable row level security;

drop policy if exists "Users manage their own push subscription" on public.milk_push_subscriptions;
create policy "Users manage their own push subscription"
on public.milk_push_subscriptions for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users read their own pushed messages" on public.milk_push_messages;
create policy "Users read their own pushed messages"
on public.milk_push_messages for select
using (auth.uid() = user_id);

drop policy if exists "Users update their own pushed messages" on public.milk_push_messages;
create policy "Users update their own pushed messages"
on public.milk_push_messages for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

grant select, insert, update, delete on public.milk_push_subscriptions to authenticated;
grant select, update on public.milk_push_messages to authenticated;
