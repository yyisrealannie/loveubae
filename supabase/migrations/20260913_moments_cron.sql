-- Supabase 数据库内部运行：不部署公开 Edge Function，也不暴露定时任务给客户端。
create extension if not exists pg_cron with schema pg_catalog;

create or replace function public.milk_moments_tick()
returns void language plpgsql security definer set search_path = '' as $$
declare
  cfg record;
  p record;
  c record;
  line text;
  picture uuid;
  local_time timestamp;
  this_monday date;
  used integer;
  responses integer;
  tick_now timestamptz := clock_timestamp();
begin
  local_time := timezone('Europe/London', tick_now);
  this_monday := date_trunc('week', local_time)::date;
  for cfg in select * from public.milk_moments_config where enabled and jsonb_array_length(cards) > 0 limit 100 loop
    for p in select * from public.milk_moments_posts
      where user_id = cfg.user_id and author = 'self' and not partner_comment_done order by created_at limit 30
    loop
      if p.partner_comment_due_at is null then
        update public.milk_moments_posts set partner_comment_due_at = tick_now + (2 + random() * 6) * interval '1 minute'
          where id = p.id and partner_comment_due_at is null;
      elsif p.partner_comment_due_at <= tick_now then
        select value into line from jsonb_array_elements_text(cfg.cards) as value order by random() limit 1;
        if line is null then continue; end if;
        picture := null;
        if random() < 0.2 then
          select id into picture from public.milk_moments_media
            where user_id = cfg.user_id and kind = 'sticker' and allow_auto order by random() limit 1;
        end if;
        insert into public.milk_moments_comments(user_id,post_id,author,body,media_id)
          values(cfg.user_id,p.id,'partner',case when picture is null then left(line,1000) else '' end,picture);
        update public.milk_moments_posts set partner_comment_done = true where id = p.id;
      end if;
    end loop;

    for c in select * from public.milk_moments_comments
      where user_id = cfg.user_id and author = 'self' and answered_at is null order by created_at limit 60
    loop
      if c.due_at is null then
        update public.milk_moments_comments set due_at = tick_now + (2 + random() * 6) * interval '1 minute'
          where id = c.id and due_at is null;
      elsif c.due_at <= tick_now then
        select count(*) into responses from public.milk_moments_comments where post_id = c.post_id and author = 'partner';
        if responses < 10 then
          select value into line from jsonb_array_elements_text(cfg.cards) as value order by random() limit 1;
          if line is null then continue; end if;
          picture := null;
          if random() < 0.2 then
            select id into picture from public.milk_moments_media
              where user_id = cfg.user_id and kind = 'sticker' and allow_auto order by random() limit 1;
          end if;
          insert into public.milk_moments_comments(user_id,post_id,author,body,media_id,reply_to)
            values(cfg.user_id,c.post_id,'partner',case when picture is null then left(line,1000) else '' end,picture,c.id)
            on conflict do nothing;
        end if;
        update public.milk_moments_comments set answered_at = tick_now where id = c.id;
      end if;
    end loop;

    if cfg.next_post_at > tick_now or extract(hour from local_time) < 10 or extract(hour from local_time) >= 22 then continue; end if;
    used := case when cfg.week_start = this_monday then cfg.week_count else 0 end;
    if used >= 2 or (cfg.last_post_at is not null and cfg.last_post_at > tick_now - interval '48 hours') then
      update public.milk_moments_config set week_start = this_monday, week_count = used,
        next_post_at = tick_now + (10 + random() * 10) * interval '1 hour' where user_id = cfg.user_id;
      continue;
    end if;
    if random() < (case when used = 0 then 0.82 else 0.28 end) then
      select value into line from jsonb_array_elements_text(cfg.cards) as value order by random() limit 1;
      if line is null then continue; end if;
      if jsonb_array_length(cfg.cards) > 1 and random() < 0.3 then
        line := left(line || E'\n' || (select value from jsonb_array_elements_text(cfg.cards) as value order by random() limit 1), 2000);
      end if;
      picture := null;
      if random() < 0.4 then
        select id into picture from public.milk_moments_media
          where user_id = cfg.user_id and kind = 'photo' and allow_auto order by random() limit 1;
      end if;
      insert into public.milk_moments_posts(user_id,author,body,media_id)
        values(cfg.user_id,'partner',left(line,2000),picture);
      update public.milk_moments_config set last_post_at = tick_now, week_start = this_monday, week_count = used + 1,
        next_post_at = tick_now + (case when used = 0 then 48 else 72 end + random() * 24) * interval '1 hour'
        where user_id = cfg.user_id;
    else
      update public.milk_moments_config set week_start = this_monday, week_count = used,
        next_post_at = tick_now + (10 + random() * 10) * interval '1 hour' where user_id = cfg.user_id;
    end if;
  end loop;
end;
$$;
revoke all on function public.milk_moments_tick() from public, anon, authenticated;

select cron.schedule('loveubae-moments', '* * * * *', 'select public.milk_moments_tick();')
where not exists (select 1 from cron.job where jobname = 'loveubae-moments');
