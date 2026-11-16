-- Zelle rent import
alter table public.rentals add column if not exists payer_names text; -- other names this tenant pays under, comma-separated
alter table public.email_imports add column if not exists rental_id uuid references public.rentals(id) on delete set null;
alter table public.email_imports add column if not exists payer text;
alter table public.rent_payments add column if not exists source text;

drop policy if exists email_imports_update on public.email_imports;
create policy email_imports_update on public.email_imports for update
  using (public.is_member(household_id)) with check (public.is_member(household_id));
