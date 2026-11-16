-- Weather-triggered tasks: location and the latest weather notes per household
alter table public.households add column if not exists lat numeric(8,4);
alter table public.households add column if not exists lon numeric(8,4);
alter table public.households add column if not exists weather jsonb;        -- [{kind, title, detail, until}]
alter table public.households add column if not exists weather_at timestamptz;
update public.households set lat = 40.6548, lon = -73.6718 where name = 'Evergreen House' and lat is null; -- Lynbrook, NY
