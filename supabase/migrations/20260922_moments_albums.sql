alter table public.milk_moments_media
  add column if not exists album_name text not null default '未分类';

alter table public.milk_moments_media
  drop constraint if exists milk_moments_media_album_name_check;

alter table public.milk_moments_media
  add constraint milk_moments_media_album_name_check
  check (char_length(btrim(album_name)) between 1 and 40);

create index if not exists milk_moments_media_user_album_created_idx
  on public.milk_moments_media (user_id, album_name, created_at desc);
