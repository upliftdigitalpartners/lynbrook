-- Evergreen House: rent & bill tracker schema
-- Every row belongs to a household; only members of that household can read or write it.

create extension if not exists pgcrypto;

create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  claim_code text unique not null default encode(gen_random_bytes(6), 'hex'),
  created_at timestamptz not null default now()
);

create table if not exists public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  remind_days int not null default 3 check (remind_days between 0 and 14),
  remind_hour int not null default 9 check (remind_hour between 0 and 23),
  timezone text not null default 'America/New_York',
  created_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

create table if not exists public.units (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null,
  sort int not null default 0
);

create table if not exists public.bills (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  unit_id uuid references public.units(id) on delete set null,
  name text not null,
  label text,
  category text not null default 'Other',
  account_number text,
  due_day int check (due_day between 1 and 31),
  amount_type text not null default 'variable' check (amount_type in ('fixed', 'variable')),
  default_amount numeric(10,2),
  autopay boolean not null default false,
  pay_url text,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  bill_id uuid not null references public.bills(id) on delete cascade,
  period date not null, -- first day of the month this payment is for
  amount numeric(10,2),
  due_date date,
  paid_at timestamptz,
  method text,
  confirmation text,
  note text,
  receipt_path text,
  updated_at timestamptz not null default now(),
  unique (bill_id, period)
);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text unique not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.reminder_log (
  payment_key text not null, -- bill_id:period:kind
  user_id uuid not null,
  sent_at timestamptz not null default now(),
  primary key (payment_key, user_id)
);

create index if not exists bills_household_idx on public.bills(household_id);
create index if not exists payments_household_period_idx on public.payments(household_id, period);

-- Membership check used by every policy
create or replace function public.is_member(h uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from household_members where household_id = h and user_id = auth.uid());
$$;

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.units enable row level security;
alter table public.bills enable row level security;
alter table public.payments enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.reminder_log enable row level security;

drop policy if exists households_rw on public.households;
create policy households_rw on public.households for all
  using (public.is_member(id)) with check (public.is_member(id));

drop policy if exists members_read on public.household_members;
create policy members_read on public.household_members for select
  using (public.is_member(household_id));
drop policy if exists members_update_self on public.household_members;
create policy members_update_self on public.household_members for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists members_leave on public.household_members;
create policy members_leave on public.household_members for delete
  using (user_id = auth.uid());

drop policy if exists units_rw on public.units;
create policy units_rw on public.units for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));
drop policy if exists bills_rw on public.bills;
create policy bills_rw on public.bills for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));
drop policy if exists payments_rw on public.payments;
create policy payments_rw on public.payments for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));

drop policy if exists push_own on public.push_subscriptions;
create policy push_own on public.push_subscriptions for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- reminder_log: no policies, only the service role touches it.

-- Join a household with its house code (first person to join becomes owner).
create or replace function public.join_household(code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare h uuid; n int;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select id into h from households where claim_code = lower(trim(code));
  if h is null then raise exception 'That house code is not right'; end if;
  select count(*) into n from household_members where household_id = h;
  insert into household_members (household_id, user_id, role)
    values (h, auth.uid(), case when n = 0 then 'owner' else 'member' end)
    on conflict do nothing;
  return h;
end $$;

-- Owners can issue a new house code (invalidates the old one).
create or replace function public.rotate_house_code(h uuid)
returns text language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if not exists (select 1 from household_members where household_id = h and user_id = auth.uid() and role = 'owner') then
    raise exception 'Only the owner can change the house code';
  end if;
  c := encode(gen_random_bytes(6), 'hex');
  update households set claim_code = c where id = h;
  return c;
end $$;

revoke all on function public.join_household(text) from anon;
revoke all on function public.rotate_house_code(uuid) from anon;
grant execute on function public.join_household(text) to authenticated;
grant execute on function public.rotate_house_code(uuid) to authenticated;

-- Private bucket for bill photos and receipts: <household_id>/<file>
insert into storage.buckets (id, name, public)
  values ('receipts', 'receipts', false)
  on conflict (id) do nothing;

drop policy if exists receipts_rw on storage.objects;
create policy receipts_rw on storage.objects for all
  using (bucket_id = 'receipts' and public.is_member(((storage.foldername(name))[1])::uuid))
  with check (bucket_id = 'receipts' and public.is_member(((storage.foldername(name))[1])::uuid));
