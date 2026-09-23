-- Allow signed-in owners to rename and recategorize their own private media.
-- The existing moments_media_edit RLS policy still restricts updates to auth.uid().
grant update (album_name) on table public.milk_moments_media to authenticated;
