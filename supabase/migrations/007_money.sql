-- Mortgage breakdown and tax report settings

-- Per-payment mortgage split (from the monthly statement)
alter table public.payments add column if not exists principal numeric(10,2);
alter table public.payments add column if not exists interest numeric(10,2);
alter table public.payments add column if not exists escrow_part numeric(10,2);
alter table public.payments add column if not exists balance_after numeric(12,2);

-- Loan facts on the mortgage bill
alter table public.bills add column if not exists loan_balance numeric(12,2);
alter table public.bills add column if not exists loan_rate numeric(6,3);
alter table public.bills add column if not exists home_value numeric(12,2);

-- Tax report: share of the property used as a rental (100 = fully rented); places left out of the report
alter table public.households add column if not exists rental_pct int not null default 100 check (rental_pct between 0 and 100);
alter table public.units add column if not exists exclude_from_tax boolean not null default false;
update public.units set exclude_from_tax = true where name = 'Cedarcroft';
