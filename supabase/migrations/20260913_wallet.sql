-- 虚拟红包余额：所有金额均为“分”，不接入任何真实支付。
create schema if not exists milk_private;

create table if not exists public.milk_wallet_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  self_cents bigint not null default 100000000 check (self_cents >= 0),
  partner_cents bigint not null default 100000000 check (partner_cents >= 0),
  allowance_month date not null default date_trunc('month', timezone('Europe/London',now()))::date,
  next_partner_at timestamptz not null default (now() + interval '2 days'),
  updated_at timestamptz not null default now()
);
create table if not exists public.milk_wallet_transfers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sender text not null check (sender in ('self','partner')),
  kind text not null check (kind in ('redpacket','transfer')),
  amount_cents bigint not null check (amount_cents between 1 and 10000000000),
  caption text not null default '' check (length(caption) <= 280),
  status text not null default 'pending' check (status in ('pending','claimed')),
  available_at timestamptz,
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists milk_wallet_transfers_user_date on public.milk_wallet_transfers(user_id,created_at desc);
create index if not exists milk_wallet_transfers_due on public.milk_wallet_transfers(available_at)
  where sender = 'self' and status = 'pending';
create table if not exists public.milk_wallet_adjustments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  side text not null check (side in ('self','partner')),
  delta_cents bigint not null check (delta_cents <> 0),
  created_at timestamptz not null default now()
);
create index if not exists milk_wallet_adjustments_user_date on public.milk_wallet_adjustments(user_id,created_at desc);

alter table public.milk_wallet_accounts enable row level security;
alter table public.milk_wallet_transfers enable row level security;
alter table public.milk_wallet_adjustments enable row level security;
create policy wallet_account_read on public.milk_wallet_accounts for select to authenticated using (user_id = (select auth.uid()));
create policy wallet_transfer_read on public.milk_wallet_transfers for select to authenticated using (user_id = (select auth.uid()));
create policy wallet_adjustment_read on public.milk_wallet_adjustments for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.milk_wallet_accounts,public.milk_wallet_transfers,public.milk_wallet_adjustments from anon,authenticated;
grant select on public.milk_wallet_accounts,public.milk_wallet_transfers,public.milk_wallet_adjustments to authenticated;

-- 私有 schema 不在 Data API 的 exposed schemas；所有入账只能经由受控 RPC 或数据库定时器。
create or replace function milk_private.ensure_wallet(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare old_month date; new_month date; elapsed integer;
begin
  if p_user is null or (auth.uid() is not null and auth.uid() <> p_user) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  insert into public.milk_wallet_accounts(user_id) values(p_user) on conflict (user_id) do nothing;
  select allowance_month into old_month from public.milk_wallet_accounts where user_id=p_user for update;
  new_month := date_trunc('month',timezone('Europe/London',now()))::date;
  elapsed := (extract(year from new_month)::int - extract(year from old_month)::int)*12
           + extract(month from new_month)::int - extract(month from old_month)::int;
  if elapsed > 0 then
    update public.milk_wallet_accounts set self_cents=self_cents+elapsed*1000000::bigint,
      partner_cents=partner_cents+elapsed*1000000::bigint,allowance_month=new_month,updated_at=now()
      where user_id=p_user;
  end if;
end;
$$;

create or replace function milk_private.wallet_snapshot() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); account record;
begin
  if uid is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  perform milk_private.ensure_wallet(uid);
  select * into account from public.milk_wallet_accounts where user_id=uid;
  return jsonb_build_object('self_cents',account.self_cents,'partner_cents',account.partner_cents,
    'allowance_month',account.allowance_month);
end;
$$;

create or replace function milk_private.wallet_send(p_amount_cents bigint,p_kind text,p_caption text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); transfer_id uuid;
begin
  if uid is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if p_amount_cents is null or p_amount_cents < 1 or p_amount_cents > 10000000000
     or p_kind not in ('redpacket','transfer') or p_kind is null
     or length(coalesce(p_caption,'')) > 280 then raise exception 'Invalid amount or caption'; end if;
  perform milk_private.ensure_wallet(uid);
  update public.milk_wallet_accounts set self_cents=self_cents-p_amount_cents,updated_at=now()
    where user_id=uid and self_cents>=p_amount_cents;
  if not found then raise exception '余额不足'; end if;
  insert into public.milk_wallet_transfers(user_id,sender,kind,amount_cents,caption,available_at)
  values(uid,'self',p_kind,p_amount_cents,coalesce(p_caption,''),now()+random()*interval '2 minutes') returning id into transfer_id;
  return transfer_id;
end;
$$;

create or replace function milk_private.wallet_claim(p_transfer_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); t record;
begin
  if uid is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  perform milk_private.ensure_wallet(uid);
  select * into t from public.milk_wallet_transfers where id=p_transfer_id and user_id=uid for update;
  if not found or t.sender <> 'partner' then raise exception '红包不存在或不能领取' using errcode = '42501'; end if;
  if t.status='claimed' then return false; end if;
  update public.milk_wallet_transfers set status='claimed',claimed_at=now() where id=t.id;
  update public.milk_wallet_accounts set self_cents=self_cents+t.amount_cents,updated_at=now() where user_id=uid;
  return true;
end;
$$;

create or replace function milk_private.wallet_adjust(p_side text,p_delta_cents bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); a record;
begin
  if uid is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if p_side is null or p_side not in ('self','partner') or p_delta_cents is null
     or p_delta_cents=0 or abs(p_delta_cents)>100000000000 then raise exception 'Invalid adjustment'; end if;
  perform milk_private.ensure_wallet(uid);
  if p_side='self' then
    update public.milk_wallet_accounts set self_cents=self_cents+p_delta_cents,updated_at=now()
      where user_id=uid and self_cents+p_delta_cents>=0;
  else
    update public.milk_wallet_accounts set partner_cents=partner_cents+p_delta_cents,updated_at=now()
      where user_id=uid and partner_cents+p_delta_cents>=0;
  end if;
  if not found then raise exception '余额不能小于零'; end if;
  insert into public.milk_wallet_adjustments(user_id,side,delta_cents) values(uid,p_side,p_delta_cents);
  select * into a from public.milk_wallet_accounts where user_id=uid;
  return jsonb_build_object('self_cents',a.self_cents,'partner_cents',a.partner_cents);
end;
$$;

create or replace function public.milk_wallet_snapshot() returns jsonb
language sql security invoker set search_path = '' as $$ select milk_private.wallet_snapshot(); $$;
create or replace function public.milk_wallet_send(p_amount_cents bigint,p_kind text,p_caption text) returns uuid
language sql security invoker set search_path = '' as $$ select milk_private.wallet_send(p_amount_cents,p_kind,p_caption); $$;
create or replace function public.milk_wallet_claim(p_transfer_id uuid) returns boolean
language sql security invoker set search_path = '' as $$ select milk_private.wallet_claim(p_transfer_id); $$;
create or replace function public.milk_wallet_adjust(p_side text,p_delta_cents bigint) returns jsonb
language sql security invoker set search_path = '' as $$ select milk_private.wallet_adjust(p_side,p_delta_cents); $$;

revoke all on schema milk_private from public,anon;
grant usage on schema milk_private to authenticated;
revoke all on all functions in schema milk_private from public,anon,authenticated;
revoke all on function public.milk_wallet_snapshot(),public.milk_wallet_send(bigint,text,text),
  public.milk_wallet_claim(uuid),public.milk_wallet_adjust(text,bigint) from public,anon,authenticated;
grant execute on function milk_private.wallet_snapshot(),
  milk_private.wallet_send(bigint,text,text),milk_private.wallet_claim(uuid),milk_private.wallet_adjust(text,bigint) to authenticated;
grant execute on function public.milk_wallet_snapshot(),public.milk_wallet_send(bigint,text,text),
  public.milk_wallet_claim(uuid),public.milk_wallet_adjust(text,bigint) to authenticated;
