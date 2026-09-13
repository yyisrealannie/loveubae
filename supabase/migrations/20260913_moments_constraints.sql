alter table public.milk_moments_config add constraint milk_moments_cards_array
  check (jsonb_typeof(cards) = 'array' and jsonb_array_length(cards) <= 500);
alter table public.milk_moments_config add constraint milk_moments_week_count
  check (week_count between 0 and 2);

drop policy moments_posts_create on public.milk_moments_posts;
create policy moments_posts_create on public.milk_moments_posts for insert to authenticated with check (
  user_id = (select auth.uid()) and author = 'self'
  and partner_comment_due_at is null and not partner_comment_done
  and (media_id is null or exists (select 1 from public.milk_moments_media m where m.id = media_id and m.user_id = (select auth.uid())))
);
drop policy moments_comments_create on public.milk_moments_comments;
create policy moments_comments_create on public.milk_moments_comments for insert to authenticated with check (
  user_id = (select auth.uid()) and author = 'self' and due_at is null and answered_at is null
  and exists (select 1 from public.milk_moments_posts p where p.id = post_id and p.user_id = (select auth.uid()))
  and (media_id is null or exists (select 1 from public.milk_moments_media m where m.id = media_id and m.user_id = (select auth.uid())))
  and (reply_to is null or exists (select 1 from public.milk_moments_comments c where c.id = reply_to and c.post_id = post_id and c.user_id = (select auth.uid())))
);
