-- House records: documents, appliances, contractors; non-monthly bills (property tax, insurance)

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  title text not null,
  category text not null default 'Other',
  unit_id uuid references public.units(id) on delete set null,
  file_path text,
  file_type text,
  expires_on date,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.appliances (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  unit_id uuid references public.units(id) on delete set null,
  kind text not null default 'Other',
  name text not null,
  brand text,
  model text,
  serial text,
  installed_on date,
  warranty_until date,
  life_years int check (life_years between 1 and 100),
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.contractors (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null,
  trade text,
  phone text,
  email text,
  notes text,
  created_at timestamptz not null default now()
);

-- Bills that aren't monthly: due only in the listed months (1-12). Null = every month.
alter table public.bills add column if not exists due_months int[];
-- Paid by the mortgage company from escrow: tracked for reference, not counted as money out
alter table public.bills add column if not exists escrow boolean not null default false;

create index if not exists documents_household_idx on public.documents(household_id);
create index if not exists appliances_household_idx on public.appliances(household_id);
create index if not exists contractors_household_idx on public.contractors(household_id);

alter table public.documents enable row level security;
alter table public.appliances enable row level security;
alter table public.contractors enable row level security;
drop policy if exists documents_rw on public.documents;
create policy documents_rw on public.documents for all using (public.is_member(household_id)) with check (public.is_member(household_id));
drop policy if exists appliances_rw on public.appliances;
create policy appliances_rw on public.appliances for all using (public.is_member(household_id)) with check (public.is_member(household_id));
drop policy if exists contractors_rw on public.contractors;
create policy contractors_rw on public.contractors for all using (public.is_member(household_id)) with check (public.is_member(household_id));
