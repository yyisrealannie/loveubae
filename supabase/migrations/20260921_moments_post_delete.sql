-- 登录用户可删除属于自己账号的动态；关联评论由外键级联删除。
grant delete on public.milk_moments_posts to authenticated;

drop policy if exists moments_posts_delete on public.milk_moments_posts;
create policy moments_posts_delete
on public.milk_moments_posts
for delete
to authenticated
using (user_id = (select auth.uid()));
