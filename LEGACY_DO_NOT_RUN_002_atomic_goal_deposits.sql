-- Migration 002: atomic savings deposits and least-privilege goal updates.
-- APPLY ONLY AFTER schema_v2.sql ON A CLEAN TEST DATABASE.
-- Existing goals.current is used as the opening balance, including historical JSON deposits;
-- do not re-import legacy JSON deposits or you will double-count them.

create table if not exists public.goal_deposits (
  id bigint generated always as identity primary key,
  goal_id bigint not null references public.goals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  amount numeric(14,2) not null check (amount > 0),
  recorded_at timestamptz not null default now(),
  request_key uuid unique
);
create index if not exists idx_goal_deposits_owner_goal on public.goal_deposits(user_id,goal_id,recorded_at desc);
alter table public.goal_deposits enable row level security;
alter table public.goal_deposits force row level security;
drop policy if exists deposit_owner_read on public.goal_deposits;
create policy deposit_owner_read on public.goal_deposits for select to authenticated using (user_id = (select auth.uid()));

-- Client can see its own deposits, but cannot forge or edit deposits directly.
revoke all on public.goal_deposits from anon, authenticated;
grant select on public.goal_deposits to authenticated;

-- Client cannot change goal balances directly; edits to targets are allowed.
revoke update on public.goals from anon, authenticated;
grant update (name, target, months) on public.goals to authenticated;

create or replace function public.add_goal_deposit(p_goal_id bigint, p_amount numeric)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_balance numeric(14,2);
begin
  if v_uid is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 999999999999.99 or p_amount != round(p_amount, 2) then
    raise exception 'Invalid deposit amount' using errcode='22023';
  end if;
  -- The UPDATE locks the goal row: concurrent deposits cannot overwrite each other.
  update public.goals
  set current = current + p_amount
  where id = p_goal_id and user_id = v_uid
  returning current into v_balance;
  if not found then raise exception 'Goal not found' using errcode='P0002'; end if;
  insert into public.goal_deposits(goal_id,user_id,amount)
  values(p_goal_id,v_uid,p_amount);
  return v_balance;
end;
$$;
revoke all on function public.add_goal_deposit(bigint,numeric) from public, anon;
grant execute on function public.add_goal_deposit(bigint,numeric) to authenticated;

-- NOTE: privileged database owners can still update all columns; never expose service_role.
-- Legacy deposits JSON must be treated as historical only; new deposits are in goal_deposits.
