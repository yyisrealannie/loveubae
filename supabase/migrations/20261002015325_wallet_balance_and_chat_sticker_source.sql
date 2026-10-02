-- 对方红包金额以其当前余额为硬上限；Moments 自动评论只复用聊天中的“他的表情包”库。
create or replace function milk_private.wallet_tick() returns void
language plpgsql security definer set search_path = '' as $$
declare
  a record;
  t record;
  amount bigint;
  balance bigint;
  words text;
  special bigint[] := array[
    520, 950, 1314, 5200, 9500, 9520, 13140, 52000,
    66600, 88800, 95000, 99900, 121200, 131400,
    520000, 666600, 888800, 999900, 1314000
  ];
  affordable_special bigint[];
begin
  for a in select user_id from public.milk_wallet_accounts order by user_id limit 100
      for update skip locked loop
    perform milk_private.ensure_wallet(a.user_id);
    for t in select id, amount_cents from public.milk_wallet_transfers
      where user_id = a.user_id and sender = 'self' and status = 'pending' and available_at <= now()
      order by available_at limit 50 for update skip locked loop
      update public.milk_wallet_accounts set partner_cents = partner_cents + t.amount_cents, updated_at = now()
        where user_id = a.user_id;
      update public.milk_wallet_transfers set status = 'claimed', claimed_at = now() where id = t.id;
    end loop;

    select partner_cents into balance from public.milk_wallet_accounts
      where user_id = a.user_id and next_partner_at <= now() for update;
    if found and balance >= 100 then
      select coalesce(array_agg(value), '{}'::bigint[]) into affordable_special
        from unnest(special) as value where value <= balance;
      if cardinality(affordable_special) > 0 and random() < 0.16 then
        amount := affordable_special[1 + floor(random() * cardinality(affordable_special))::int];
      else
        amount := 100 + floor(random() * (balance - 99))::bigint;
      end if;

      select value into words from public.milk_moments_config cfg,
        lateral jsonb_array_elements_text(cfg.cards) as value
        where cfg.user_id = a.user_id order by random() limit 1;
      words := left(coalesce(nullif(words, ''), '给你的一点心意'), 280);
      update public.milk_wallet_accounts set partner_cents = partner_cents - amount,
        next_partner_at = now() + (2.5 + random() * 3.5) * interval '1 day', updated_at = now()
        where user_id = a.user_id and partner_cents >= amount;
      if found then
        insert into public.milk_wallet_transfers(user_id, sender, kind, amount_cents, caption)
        values(a.user_id, 'partner', case when random() < 0.65 then 'redpacket' else 'transfer' end, amount, words);
      end if;
    end if;
  end loop;
end;
$$;
revoke all on function milk_private.wallet_tick() from public, anon, authenticated;

-- 清掉旧的独立图库表情授权；照片授权保持不变。
update public.milk_moments_media
set allow_auto = false
where kind = 'sticker'
  and allow_auto
  and object_path not like user_id::text || '/chat-partner-%';

alter table public.milk_moments_media
  drop constraint if exists milk_moments_sticker_auto_source;
alter table public.milk_moments_media
  add constraint milk_moments_sticker_auto_source check (
    not allow_auto
    or kind = 'photo'
    or object_path like user_id::text || '/chat-partner-%'
  );

-- 加速每天一次的推送中转记录清理；未导入的待收消息不在清理范围内。
create index if not exists milk_push_messages_imported_at_idx
  on public.milk_push_messages(imported_at)
  where imported_at is not null;
