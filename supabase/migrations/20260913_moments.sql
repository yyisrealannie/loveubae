-- 爱你多一天: 所有内容按登录用户隔离；后台身份只由 Edge Function 的 service key 写入。
create table if not exists public.milk_moments_config (
  user_id uuid primary key references auth.users(id) on delete cascade,
  partner_name text not null default '他',
  cards jsonb not null default '[]'::jsonb,
  enabled boolean not null default true,
  next_post_at timestamptz not null default (now() + interval '2 days'),
  last_post_at timestamptz,
  week_start date,
  week_count integer not null default 0,
  updated_at timestamptz not null default now()
);
create table if not exists public.milk_moments_media (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  object_path text not null unique,
  kind text not null check (kind in ('photo','sticker')),
  allow_auto boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists public.milk_moments_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  author text not null check (author in ('self','partner')),
  body text not null default '' check (length(body) <= 2000),
  media_id uuid references public.milk_moments_media(id) on delete set null,
  liked boolean not null default false,
  partner_comment_due_at timestamptz,
  partner_comment_done boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists public.milk_moments_comments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  post_id uuid not null references public.milk_moments_posts(id) on delete cascade,
  author text not null check (author in ('self','partner')),
  body text not null default '' check (length(body) <= 1000),
  media_id uuid references public.milk_moments_media(id) on delete set null,
  reply_to uuid references public.milk_moments_comments(id) on delete set null,
  due_at timestamptz,
  answered_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists milk_moments_one_reply on public.milk_moments_comments(reply_to) where author = 'partner' and reply_to is not null;
create index if not exists milk_moments_posts_user_time on public.milk_moments_posts(user_id,created_at desc);
create index if not exists milk_moments_comments_post_time on public.milk_moments_comments(post_id,created_at);
create index if not exists milk_moments_comments_due on public.milk_moments_comments(due_at) where author = 'self' and answered_at is null;
create index if not exists milk_moments_config_due on public.milk_moments_config(next_post_at) where enabled;
create index if not exists milk_moments_media_user on public.milk_moments_media(user_id,kind);

alter table public.milk_moments_config enable row level security;
alter table public.milk_moments_media enable row level security;
alter table public.milk_moments_posts enable row level security;
alter table public.milk_moments_comments enable row level security;

create policy moments_config_read on public.milk_moments_config for select to authenticated using (user_id = (select auth.uid()));
create policy moments_config_create on public.milk_moments_config for insert to authenticated with check (user_id = (select auth.uid()) and week_count = 0 and last_post_at is null);
create policy moments_config_edit on public.milk_moments_config for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy moments_media_read on public.milk_moments_media for select to authenticated using (user_id = (select auth.uid()));
create policy moments_media_create on public.milk_moments_media for insert to authenticated with check (user_id = (select auth.uid()) and object_path like (select auth.uid())::text || '/%');
create policy moments_media_edit on public.milk_moments_media for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()) and object_path like (select auth.uid())::text || '/%');
create policy moments_media_delete on public.milk_moments_media for delete to authenticated using (user_id = (select auth.uid()));
create policy moments_posts_read on public.milk_moments_posts for select to authenticated using (user_id = (select auth.uid()));
create policy moments_posts_create on public.milk_moments_posts for insert to authenticated with check (user_id = (select auth.uid()) and author = 'self' and partner_comment_due_at is null and not partner_comment_done);
create policy moments_posts_like on public.milk_moments_posts for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy moments_comments_read on public.milk_moments_comments for select to authenticated using (user_id = (select auth.uid()));
create policy moments_comments_create on public.milk_moments_comments for insert to authenticated with check (
  user_id = (select auth.uid()) and author = 'self' and due_at is null and answered_at is null
  and exists (select 1 from public.milk_moments_posts p where p.id = post_id and p.user_id = (select auth.uid()))
);
create policy moments_comments_edit on public.milk_moments_comments for update to authenticated using (user_id = (select auth.uid()) and author = 'self') with check (user_id = (select auth.uid()) and author = 'self');
create policy moments_comments_delete on public.milk_moments_comments for delete to authenticated using (user_id = (select auth.uid()) and author = 'self');

revoke all on public.milk_moments_config, public.milk_moments_media, public.milk_moments_posts, public.milk_moments_comments from anon, authenticated;
grant select, insert on public.milk_moments_config to authenticated;
grant update (partner_name, cards, enabled, updated_at) on public.milk_moments_config to authenticated;
grant select, insert, delete on public.milk_moments_media to authenticated;
grant update (allow_auto) on public.milk_moments_media to authenticated;
grant select, insert on public.milk_moments_posts to authenticated;
grant update (liked) on public.milk_moments_posts to authenticated;
grant select, insert, delete on public.milk_moments_comments to authenticated;
grant update (body, media_id) on public.milk_moments_comments to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('milk-moments','milk-moments',false,8388608,array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do update set public = false, file_size_limit = 8388608,
allowed_mime_types = array['image/jpeg','image/png','image/webp','image/gif'];
create policy moments_storage_read on storage.objects for select to authenticated
  using (bucket_id = 'milk-moments' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy moments_storage_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'milk-moments' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy moments_storage_remove on storage.objects for delete to authenticated
  using (bucket_id = 'milk-moments' and (storage.foldername(name))[1] = (select auth.uid())::text);
