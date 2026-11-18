-- Doorstep (public multi-landlord platform). Runs after the shared migrations 001-010.

-- Anyone signed in can create their own property; they become its owner.
create or replace function public.create_household(p_name text, p_address text, p_units text[])
returns uuid language plpgsql security definer set search_path = public as $$
declare h uuid; i int := 1; u text;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Give your property a name'; end if;
  if (select count(*) from household_members where user_id = auth.uid()) >= 5 then raise exception 'You can have up to 5 properties'; end if;
  insert into households (name, address) values (left(trim(p_name), 80), nullif(left(trim(coalesce(p_address, '')), 160), '')) returning id into h;
  insert into household_members (household_id, user_id, role) values (h, auth.uid(), 'owner');
  insert into units (household_id, name, sort) values (h, 'Whole house', 0);
  foreach u in array coalesce(p_units, array[]::text[]) loop
    if coalesce(trim(u), '') <> '' then insert into units (household_id, name, sort) values (h, left(trim(u), 40), i); i := i + 1; end if;
  end loop;
  insert into units (household_id, name, sort, exclude_from_tax) values (h, 'Personal', 99, true);
  return h;
end $$;
revoke all on function public.create_household(text, text, text[]) from anon;
grant execute on function public.create_household(text, text, text[]) to authenticated;

-- Members can rename their own places.
drop policy if exists units_rw on public.units;
create policy units_rw on public.units for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));
