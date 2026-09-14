-- 安全增量同步：新表与旧整包备份并存，永不清除旧记录。
create table if not exists public.milk_safe_messages (
  user_id uuid not null references auth.users(id) on delete cascade,
  message_key text not null check (length(message_key) between 1 and 150),
  message jsonb not null,
  media_path text,
  created_at timestamptz not null default now(),
  primary key (user_id, message_key)
);
create index if not exists milk_safe_messages_time on public.milk_safe_messages(user_id,created_at,message_key);
create table if not exists public.milk_safe_profiles (
  revision uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null check (length(device_id) between 1 and 100),
  profile jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists milk_safe_profiles_time on public.milk_safe_profiles(user_id,created_at desc);
alter table public.milk_safe_messages enable row level security;
alter table public.milk_safe_profiles enable row level security;
create policy milk_safe_messages_read on public.milk_safe_messages for select to authenticated
  using (user_id=(select auth.uid()));
create policy milk_safe_messages_append on public.milk_safe_messages for insert to authenticated
  with check (user_id=(select auth.uid()) and (media_path is null or media_path like (select auth.uid())::text || '/%'));
create policy milk_safe_profiles_read on public.milk_safe_profiles for select to authenticated
  using (user_id=(select auth.uid()));
create policy milk_safe_profiles_append on public.milk_safe_profiles for insert to authenticated
  with check (user_id=(select auth.uid()));
revoke all on public.milk_safe_messages,public.milk_safe_profiles from anon,authenticated;
grant select,insert on public.milk_safe_messages,public.milk_safe_profiles to authenticated;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('milk-chat-media','milk-chat-media',false,8388608,array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do update set public=false,file_size_limit=8388608,
  allowed_mime_types=array['image/jpeg','image/png','image/webp','image/gif'];
create policy milk_chat_media_read on storage.objects for select to authenticated
  using (bucket_id='milk-chat-media' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy milk_chat_media_write on storage.objects for insert to authenticated
  with check (bucket_id='milk-chat-media' and (storage.foldername(name))[1]=(select auth.uid())::text);
