alter table public.chat_backups enable row level security;

revoke all on table public.chat_backups from public, anon, authenticated;
grant select on table public.chat_backups to service_role;
