-- Gmail bill import

-- Per-household secret the Apps Script uses to send emails in. Readable by members only (households RLS).
alter table public.households add column if not exists import_token text unique default encode(gen_random_bytes(18), 'hex');
update public.households set import_token = encode(gen_random_bytes(18), 'hex') where import_token is null;

-- Where a payment's amount/paid status came from: null/'manual' = typed in the app, 'email' = imported
alter table public.payments add column if not exists source text;

create table if not exists public.email_imports (
  message_id text not null,
  household_id uuid not null references public.households(id) on delete cascade,
  bill_id uuid references public.bills(id) on delete set null,
  provider text,
  kind text,            -- bill | payment | other
  amount numeric(10,2),
  due_date date,
  status text not null, -- applied | kept_manual | already_paid | unmatched | ignored
  detail text,
  subject text,
  received_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (household_id, message_id)
);
create index if not exists email_imports_household_idx on public.email_imports(household_id, created_at desc);

alter table public.email_imports enable row level security;
drop policy if exists email_imports_read on public.email_imports;
create policy email_imports_read on public.email_imports for select using (public.is_member(household_id));
drop policy if exists email_imports_delete on public.email_imports;
create policy email_imports_delete on public.email_imports for delete using (public.is_member(household_id));

-- Owners can issue a new import token (the old script stops working)
create or replace function public.rotate_import_token(h uuid)
returns text language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if not public.is_member(h) then raise exception 'Not allowed'; end if;
  c := encode(gen_random_bytes(18), 'hex');
  update households set import_token = c where id = h;
  return c;
end $$;
revoke all on function public.rotate_import_token(uuid) from anon;
grant execute on function public.rotate_import_token(uuid) to authenticated;
