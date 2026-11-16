-- Tenant features: private tenant page, deposits & move-out, lease history, inspections, repair requests

alter table public.rentals add column if not exists portal_token text unique default encode(gen_random_bytes(12), 'hex');
update public.rentals set portal_token = encode(gen_random_bytes(12), 'hex') where portal_token is null;
alter table public.rentals add column if not exists deposit_held_at text;
alter table public.rentals add column if not exists deposit_received_on date;
alter table public.rentals add column if not exists move_out_on date;
alter table public.rentals add column if not exists deposit_returned_on date;
alter table public.rentals add column if not exists deposit_returned_amount numeric(10,2);
alter table public.rentals add column if not exists deposit_deductions text;

create table if not exists public.lease_history (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  rental_id uuid references public.rentals(id) on delete cascade,
  tenant_name text,
  lease_start date,
  lease_end date,
  rent_amount numeric(10,2),
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.inspections (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  rental_id uuid references public.rentals(id) on delete set null,
  unit_id uuid references public.units(id) on delete set null,
  kind text not null default 'Move-in',
  done_on date not null default current_date,
  items jsonb not null default '[]'::jsonb, -- [{room, condition, note, photos: [path]}]
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.repair_requests (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  rental_id uuid references public.rentals(id) on delete set null,
  unit_id uuid references public.units(id) on delete set null,
  title text not null,
  details text,
  urgency text not null default 'normal',
  photo_path text,
  status text not null default 'new' check (status in ('new', 'scheduled', 'done', 'closed')),
  reply text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists lease_history_household_idx on public.lease_history(household_id);
create index if not exists inspections_household_idx on public.inspections(household_id);
create index if not exists repair_requests_household_idx on public.repair_requests(household_id, created_at desc);

alter table public.lease_history enable row level security;
alter table public.inspections enable row level security;
alter table public.repair_requests enable row level security;
drop policy if exists lease_history_rw on public.lease_history;
create policy lease_history_rw on public.lease_history for all using (public.is_member(household_id)) with check (public.is_member(household_id));
drop policy if exists inspections_rw on public.inspections;
create policy inspections_rw on public.inspections for all using (public.is_member(household_id)) with check (public.is_member(household_id));
drop policy if exists repair_requests_rw on public.repair_requests;
create policy repair_requests_rw on public.repair_requests for all using (public.is_member(household_id)) with check (public.is_member(household_id));
