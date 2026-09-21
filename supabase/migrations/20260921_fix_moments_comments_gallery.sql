-- 修复评论 INSERT 策略的自引用递归，并为私密图库增加用户可编辑名称。
alter table public.milk_moments_media
  add column if not exists display_name text;

alter table public.milk_moments_media
  drop constraint if exists milk_moments_media_display_name_length;
alter table public.milk_moments_media
  add constraint milk_moments_media_display_name_length
  check (display_name is null or char_length(display_name) between 1 and 80);

grant update (display_name) on public.milk_moments_media to authenticated;

create index if not exists milk_moments_comments_user_id_idx
  on public.milk_moments_comments(user_id);
create index if not exists milk_moments_comments_media_id_idx
  on public.milk_moments_comments(media_id);
create index if not exists milk_moments_posts_media_id_idx
  on public.milk_moments_posts(media_id);

drop policy if exists moments_comments_create on public.milk_moments_comments;
create policy moments_comments_create
on public.milk_moments_comments
for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and author = 'self'
  and due_at is null
  and answered_at is null
  and reply_to is null
  and exists (
    select 1 from public.milk_moments_posts p
    where p.id = post_id and p.user_id = (select auth.uid())
  )
  and (
    media_id is null
    or exists (
      select 1 from public.milk_moments_media m
      where m.id = media_id and m.user_id = (select auth.uid())
    )
  )
);
