create table if not exists public.milk_server_secrets (
  name text primary key,
  secret_value text not null,
  updated_at timestamptz not null default now()
);

alter table public.milk_server_secrets enable row level security;

revoke all on table public.milk_server_secrets from public, anon, authenticated;
grant select on table public.milk_server_secrets to service_role;
