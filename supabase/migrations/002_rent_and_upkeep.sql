-- Rent collection and home upkeep

create table if not exists public.rentals (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  unit_id uuid references public.units(id) on delete set null,
  tenant_name text,
  phone text,
  email text,
  rent_amount numeric(10,2),
  due_day int not null default 1 check (due_day between 1 and 31),
  grace_days int not null default 5 check (grace_days between 0 and 31),
  late_fee numeric(10,2),
  deposit numeric(10,2),
  lease_start date,
  lease_end date,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.rent_payments (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  rental_id uuid not null references public.rentals(id) on delete cascade,
  period date not null,
  amount_due numeric(10,2),
  amount_received numeric(10,2),
  received_at timestamptz,
  method text,
  note text,
  updated_at timestamptz not null default now(),
  unique (rental_id, period)
);

create table if not exists public.maintenance_tasks (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  unit_id uuid references public.units(id) on delete set null,
  title text not null,
  category text not null default 'Other',
  interval_months int check (interval_months between 1 and 120), -- null = one-time job
  next_due date,
  last_done date,
  vendor text,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.maintenance_log (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  task_id uuid references public.maintenance_tasks(id) on delete set null,
  unit_id uuid references public.units(id) on delete set null,
  title text not null,
  done_on date not null default current_date,
  cost numeric(10,2),
  vendor text,
  notes text,
  receipt_path text,
  created_at timestamptz not null default now()
);

create index if not exists rentals_household_idx on public.rentals(household_id);
create index if not exists rent_payments_household_period_idx on public.rent_payments(household_id, period);
create index if not exists maint_tasks_household_idx on public.maintenance_tasks(household_id);
create index if not exists maint_log_household_idx on public.maintenance_log(household_id, done_on);

alter table public.rentals enable row level security;
alter table public.rent_payments enable row level security;
alter table public.maintenance_tasks enable row level security;
alter table public.maintenance_log enable row level security;

drop policy if exists rentals_rw on public.rentals;
create policy rentals_rw on public.rentals for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));
drop policy if exists rent_payments_rw on public.rent_payments;
create policy rent_payments_rw on public.rent_payments for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));
drop policy if exists maint_tasks_rw on public.maintenance_tasks;
create policy maint_tasks_rw on public.maintenance_tasks for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));
drop policy if exists maint_log_rw on public.maintenance_log;
create policy maint_log_rw on public.maintenance_log for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));
