-- Doorstep: tenants say "I've paid", daily AI limits, and deleting your own account.

-- 1. "I've paid" notices from the tenant page. The landlord confirms or dismisses them.
create table if not exists public.rent_notices (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  rental_id uuid not null references public.rentals(id) on delete cascade,
  period date not null,
  amount numeric(10,2) not null check (amount > 0 and amount < 100000),
  method text,
  note text,
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'dismissed')),
  created_at timestamptz not null default now()
);
create index if not exists rent_notices_household on public.rent_notices (household_id, status);
alter table public.rent_notices enable row level security;
drop policy if exists rent_notices_rw on public.rent_notices;
create policy rent_notices_rw on public.rent_notices for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));

-- 2. Daily AI allowance per person (only the server touches this table).
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null default current_date,
  n int not null default 0,
  primary key (user_id, day)
);
alter table public.ai_usage enable row level security;
create or replace function public.bump_ai(p_user uuid, p_limit int)
returns boolean language plpgsql security definer set search_path = public as $$
declare used int;
begin
  insert into ai_usage (user_id, day, n) values (p_user, current_date, 1)
    on conflict (user_id, day) do update set n = ai_usage.n + 1
    returning n into used;
  return used <= p_limit;
end $$;
revoke all on function public.bump_ai(uuid, int) from public, anon, authenticated;

-- 3. Delete my account: leave shared properties, delete properties only you are in, then the login itself.
--    (The app removes the files of those properties first.)
create or replace function public.delete_my_account()
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'Not signed in'; end if;
  if exists (select 1 from auth.users where id = me and email = 'demo@doorstep.example') then raise exception 'The demo account can’t be deleted'; end if;
  delete from households h where exists (select 1 from household_members m where m.household_id = h.id and m.user_id = me)
    and not exists (select 1 from household_members m where m.household_id = h.id and m.user_id <> me);
  delete from household_members where user_id = me;
  delete from push_subscriptions where user_id = me;
  delete from auth.users where id = me;
end $$;
revoke all on function public.delete_my_account() from anon;
grant execute on function public.delete_my_account() to authenticated;

-- The demo's tenant notices are cleared by the nightly reset (households cascade).
