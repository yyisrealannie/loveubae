create table if not exists public.milk_sync (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.milk_sync enable row level security;

create policy "Users can read their own milk backup"
on public.milk_sync for select
using (auth.uid() = user_id);

create policy "Users can insert their own milk backup"
on public.milk_sync for insert
with check (auth.uid() = user_id);

create policy "Users can update their own milk backup"
on public.milk_sync for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
