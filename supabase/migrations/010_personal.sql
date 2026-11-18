-- Personal expenses (Netflix, phone, gym, car insurance...) live in their own place, "Personal".
-- Like Cedarcroft, it is not part of the rental: left out of rental totals and the tax report.
insert into public.units (household_id, name, sort, exclude_from_tax)
select h.id, 'Personal', 99, true
from public.households h
where not exists (select 1 from public.units u where u.household_id = h.id and lower(u.name) = 'personal');
