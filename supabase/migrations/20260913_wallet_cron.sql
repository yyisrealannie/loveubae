-- 私有数据库任务：自动领取、每月零点到账、偶尔以对方身份发红包。
create extension if not exists pg_cron with schema pg_catalog;
create or replace function milk_private.wallet_tick() returns void
language plpgsql security definer set search_path = '' as $$
declare a record; t record; amount bigint; words text; special bigint[] := array[
  520,5200,52000,1314,13140,131400,88800,66600,99900,121200,950,9500,9520,95000
];
begin
  for a in select user_id from public.milk_wallet_accounts order by user_id limit 100
      for update skip locked loop
    perform milk_private.ensure_wallet(a.user_id);
    for t in select id,amount_cents from public.milk_wallet_transfers
      where user_id=a.user_id and sender='self' and status='pending' and available_at<=now()
      order by available_at limit 50 for update skip locked loop
      update public.milk_wallet_accounts set partner_cents=partner_cents+t.amount_cents,updated_at=now()
        where user_id=a.user_id;
      update public.milk_wallet_transfers set status='claimed',claimed_at=now() where id=t.id;
    end loop;

    if exists (select 1 from public.milk_wallet_accounts
      where user_id=a.user_id and next_partner_at<=now() and partner_cents>=100) then
      if random()<0.16 then
        amount := special[1+floor(random()*array_length(special,1))::int];
      else
        amount := 100+floor(random()*19900)::bigint;
      end if;
      select value into words from public.milk_moments_config cfg,
        lateral jsonb_array_elements_text(cfg.cards) as value
        where cfg.user_id=a.user_id order by random() limit 1;
      words := left(coalesce(nullif(words,''),'给你的一点心意'),280);
      update public.milk_wallet_accounts set partner_cents=partner_cents-amount,
        next_partner_at=now()+(2.5+random()*3.5)*interval '1 day',updated_at=now()
        where user_id=a.user_id and partner_cents>=amount;
      if found then
        insert into public.milk_wallet_transfers(user_id,sender,kind,amount_cents,caption)
        values(a.user_id,'partner',case when random()<0.65 then 'redpacket' else 'transfer' end,amount,words);
      else
        update public.milk_wallet_accounts set next_partner_at=now()+interval '1 day' where user_id=a.user_id;
      end if;
    end if;
  end loop;
end;
$$;
revoke all on function milk_private.wallet_tick() from public,anon,authenticated;
select cron.schedule('loveubae-wallet','* * * * *','select milk_private.wallet_tick();')
where not exists (select 1 from cron.job where jobname='loveubae-wallet');
