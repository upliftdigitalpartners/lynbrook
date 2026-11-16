-- Vacancy mode, tenant pay info

-- Turnover checklist for a unit between tenants: [{item, done}]
alter table public.units add column if not exists turnover jsonb;
alter table public.units add column if not exists vacant_since date;

-- How tenants should pay (shown on their private page)
alter table public.households add column if not exists pay_zelle text;
alter table public.households add column if not exists pay_note text;
