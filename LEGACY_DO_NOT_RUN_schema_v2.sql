-- Masar 2.0 starter schema. Run on a NEW Supabase project; back up old data before migrating.
create extension if not exists pgcrypto;
create table if not exists public.profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 name text not null check(length(trim(name)) between 1 and 120),
 currency text not null default 'ر.س' check(currency in ('ر.س','د.إ','د.ك','$')),
 onboarded boolean not null default false,
 created_at timestamptz not null default now()
);
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = '' as $$
begin
 insert into public.profiles(id,name,currency) values(new.id,
 left(coalesce(nullif(trim(new.raw_user_meta_data->>'name'),''),split_part(coalesce(new.email,''),'@',1),'مستخدم'),120),
 case when new.raw_user_meta_data->>'currency' in ('ر.س','د.إ','د.ك','$') then new.raw_user_meta_data->>'currency' else 'ر.س' end)
 on conflict(id) do nothing; return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();
create table if not exists public.income (
 id bigint generated always as identity primary key,
 user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 name text not null check(length(trim(name)) between 1 and 160),
 amount numeric(14,2) not null check(amount>0),
 recurrence text not null check(recurrence in ('monthly','limited','irregular')),
 months integer check(months is null or months>0),
 day integer check(day is null or day between 1 and 31),
 created_month_idx integer not null,
 revisions jsonb not null default '[]'::jsonb check(jsonb_typeof(revisions)='array'),
 created_at timestamptz not null default now(),
 check(recurrence<>'limited' or months is not null)
);
create table if not exists public.expenses (
 id bigint generated always as identity primary key,
 user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 name text not null check(length(trim(name)) between 1 and 160),
 amount numeric(14,2) not null check(amount>0),
 category text not null check(category in ('سكن','فواتير','تسوق','ترفيه','التزامات','أخرى')),
 type text not null check(type in ('fixed','variable')),
 duration integer not null check(duration>0),
 start_month_idx integer not null,
 revisions jsonb not null default '[]'::jsonb check(jsonb_typeof(revisions)='array'),
 created_at timestamptz not null default now()
);
create table if not exists public.goals (
 id bigint generated always as identity primary key,
 user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 name text not null check(length(trim(name)) between 1 and 160),
 target numeric(14,2) not null check(target>0),
 current numeric(14,2) not null default 0 check(current>=0),
 months integer not null check(months>0),
 start_month_idx integer not null,
 deposits jsonb not null default '[]'::jsonb check(jsonb_typeof(deposits)='array'),
 created_at timestamptz not null default now()
);
-- Budgets: monthly allocation by category; month index = Gregorian year * 12 + month - 1.
create table if not exists public.budgets (
 id bigint generated always as identity primary key,
 user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 month_idx integer not null,
 category text not null check(length(trim(category)) between 1 and 80),
 planned numeric(14,2) not null check(planned>=0),
 unique(user_id,month_idx,category)
);
-- Single actual ledger is necessary for real budget balances and imported transactions.
create table if not exists public.transactions (
 id bigint generated always as identity primary key,
 user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 occurred_at timestamptz not null,
 amount numeric(14,2) not null check(amount>0),
 direction text not null check(direction in ('income','expense','transfer')),
 category text,
 merchant text,
 source text not null default 'manual' check(source in ('manual','shared_sms','bank_api')),
 external_fingerprint text,
 review_status text not null default 'confirmed' check(review_status in ('pending','confirmed','ignored')),
 created_at timestamptz not null default now(),
 unique(user_id,source,external_fingerprint)
);
create table if not exists public.vehicles (
 id bigint generated always as identity primary key,
 user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 name text not null check(length(trim(name)) between 1 and 100),
 current_odometer integer not null default 0 check(current_odometer>=0),
 oil_interval_km integer not null default 5000 check(oil_interval_km>0),
 last_oil_change_km integer not null default 0 check(last_oil_change_km>=0),
 check(current_odometer>=last_oil_change_km)
);
create table if not exists public.fuel_logs (
 id bigint generated always as identity primary key,
 user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 vehicle_id bigint not null references public.vehicles(id) on delete cascade,
 odometer integer not null check(odometer>=0),
 amount numeric(14,2) not null check(amount>0),
 liters numeric(12,3) check(liters is null or liters>0),
 filled_at timestamptz not null default now(),
 unique(vehicle_id,odometer)
);
-- Important: a referenced vehicle MUST belong to this user, including via forged REST requests.
create or replace function public.fuel_vehicle_guard() returns trigger language plpgsql security invoker set search_path = '' as $$
begin
 if not exists(select 1 from public.vehicles where id=new.vehicle_id and user_id=new.user_id) then
  raise exception 'vehicle does not belong to user';
 end if;
 return new;
end $$;
drop trigger if exists fuel_guard on public.fuel_logs;
create trigger fuel_guard before insert or update on public.fuel_logs for each row execute function public.fuel_vehicle_guard();
-- Reject spoofed owners on all ordinary tables, including update and delete.
do $$ declare tbl text; begin
 foreach tbl in array array['profiles','income','expenses','goals','budgets','transactions','vehicles','fuel_logs'] loop
  execute format('alter table public.%I enable row level security',tbl);
  execute format('alter table public.%I force row level security',tbl);
  execute format('drop policy if exists own_select on public.%I',tbl);
  execute format('drop policy if exists own_insert on public.%I',tbl);
  execute format('drop policy if exists own_update on public.%I',tbl);
  execute format('drop policy if exists own_delete on public.%I',tbl);
  if tbl='profiles' then
   execute format('create policy own_select on public.%I for select to authenticated using(id=(select auth.uid()))',tbl);
   execute format('create policy own_insert on public.%I for insert to authenticated with check(id=(select auth.uid()))',tbl);
   execute format('create policy own_update on public.%I for update to authenticated using(id=(select auth.uid())) with check(id=(select auth.uid()))',tbl);
  else
   execute format('create policy own_select on public.%I for select to authenticated using(user_id=(select auth.uid()))',tbl);
   execute format('create policy own_insert on public.%I for insert to authenticated with check(user_id=(select auth.uid()))',tbl);
   execute format('create policy own_update on public.%I for update to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()))',tbl);
   execute format('create policy own_delete on public.%I for delete to authenticated using(user_id=(select auth.uid()))',tbl);
  end if;
 end loop;
end $$;
create index if not exists idx_transactions_owner_time on public.transactions(user_id,occurred_at desc);
create index if not exists idx_fuel_owner_vehicle on public.fuel_logs(user_id,vehicle_id,odometer desc);
create index if not exists idx_budgets_owner_month on public.budgets(user_id,month_idx);
create index if not exists idx_income_owner on public.income(user_id);
create index if not exists idx_expenses_owner on public.expenses(user_id);
create index if not exists idx_goals_owner on public.goals(user_id);
-- Shared debt and family permissions require tightly controlled state-changing RPCs.
-- See architecture.md: do not enable client CRUD for those sensitive flows prematurely.
