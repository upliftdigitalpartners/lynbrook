-- Doorstep demo: a sample landlord account with a fictional duplex, rebuilt from scratch every night.
-- The demo login (demo@doorstep.example) is public on purpose; nothing here is real.
create extension if not exists pg_cron;

create or replace function public.reset_demo()
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  demo uuid; h uuid; u_whole uuid; u_up uuid; u_down uuid; u_me uuid;
  b_mort uuid; b_ins uuid; b_gas uuid; b_water uuid; b_trash uuid; b_el_up uuid; b_el_down uuid; b_net uuid; b_spot uuid; b_phone uuid;
  r_maria uuid; r_james uuid; t_smoke uuid; t_furn uuid; t_gutter uuid; t_filter uuid;
  cur date := date_trunc('month', current_date)::date; k date; i int; m int; amt numeric;
begin
  select id into demo from auth.users where email = 'demo@doorstep.example';
  if demo is null then raise notice 'demo user missing'; return; end if;
  -- anyone could have changed the password or added data: put it all back
  update auth.users set encrypted_password = crypt('doorstep-demo', gen_salt('bf')) where id = demo;
  delete from households where id in (select household_id from household_members where user_id = demo);
  delete from push_subscriptions where user_id = demo;

  insert into households (name, address, lat, lon, pay_zelle, pay_note)
    values ('Maple Street Duplex', '24 Maple St, Springfield, MA', 42.1015, -72.5898, 'rent@maple-duplex.example', 'Please put your unit in the memo.')
    returning id into h;
  insert into household_members (household_id, user_id, role) values (h, demo, 'owner');
  insert into units (household_id, name, sort) values (h, 'Whole house', 0) returning id into u_whole;
  insert into units (household_id, name, sort) values (h, 'Downstairs', 1) returning id into u_down;
  insert into units (household_id, name, sort) values (h, 'Upstairs', 2) returning id into u_up;
  insert into units (household_id, name, sort, exclude_from_tax) values (h, 'Personal', 99, true) returning id into u_me;

  insert into bills (household_id, unit_id, name, category, amount_type, default_amount, due_day, autopay, loan_balance, loan_rate, home_value)
    values (h, u_whole, 'Pine Valley Mortgage', 'Mortgage', 'fixed', 2180, 1, true, 286400, 6.125, 465000) returning id into b_mort;
  insert into bills (household_id, unit_id, name, category, amount_type, default_amount, due_day) values (h, u_whole, 'Homeowners insurance', 'Insurance', 'fixed', 145, 5) returning id into b_ins;
  insert into bills (household_id, unit_id, name, category, amount_type, due_day) values (h, u_whole, 'Bay State Gas', 'Gas', 'variable', 12) returning id into b_gas;
  insert into bills (household_id, unit_id, name, category, amount_type, due_day) values (h, u_whole, 'City Water', 'Water', 'variable', 25) returning id into b_water;
  insert into bills (household_id, unit_id, name, category, amount_type, default_amount, due_day) values (h, u_whole, 'Trash pickup', 'Trash', 'fixed', 38, 10) returning id into b_trash;
  insert into bills (household_id, unit_id, name, label, category, amount_type, due_day) values (h, u_up, 'Valley Electric', 'Upstairs', 'Electric', 'variable', 18) returning id into b_el_up;
  insert into bills (household_id, unit_id, name, label, category, amount_type, due_day) values (h, u_down, 'Valley Electric', 'Downstairs', 'Electric', 'variable', 20) returning id into b_el_down;
  insert into bills (household_id, unit_id, name, category, amount_type, default_amount, due_day, autopay) values (h, u_me, 'Netflix', 'Streaming', 'fixed', 15.49, 20, true) returning id into b_net;
  insert into bills (household_id, unit_id, name, category, amount_type, default_amount, due_day, autopay) values (h, u_me, 'Spotify', 'Streaming', 'fixed', 11.99, 5, true) returning id into b_spot;
  insert into bills (household_id, unit_id, name, category, amount_type, default_amount, due_day) values (h, u_me, 'Phone', 'Internet & phone', 'fixed', 65, 22) returning id into b_phone;

  insert into rentals (household_id, unit_id, tenant_name, phone, rent_amount, due_day, grace_days, deposit, lease_start, lease_end)
    values (h, u_down, 'Maria Gomez', '+15555550142', 1650, 1, 5, 1650, (cur - interval '20 months')::date, (cur + interval '4 months' - interval '1 day')::date) returning id into r_maria;
  insert into rentals (household_id, unit_id, tenant_name, phone, rent_amount, due_day, grace_days, deposit, lease_start, lease_end)
    values (h, u_up, 'James Lee', '+15555550188', 1450, 1, 5, 1450, (cur - interval '14 months')::date, (cur + interval '10 months' - interval '1 day')::date) returning id into r_james;

  -- 12 months of history, then this month part-way through
  for i in reverse 11..0 loop
    k := (cur - make_interval(months => i))::date; m := extract(month from k);
    -- fixed bills, paid on time
    insert into payments (household_id, bill_id, period, amount, paid_at, principal, interest, escrow_part, balance_after)
      values (h, b_mort, k, 2180, case when i > 0 or extract(day from current_date) >= 1 then k + interval '12 hours' end, 1440 + (11 - i) * 7, 1460 - (11 - i) * 7, 280, 286400 - (11 - i) * 1450);
    insert into payments (household_id, bill_id, period, amount, paid_at) values (h, b_ins, k, 145, case when i > 0 or extract(day from current_date) >= 6 then k + interval '4 days' end);
    insert into payments (household_id, bill_id, period, amount, paid_at) values (h, b_trash, k, 38, case when i > 0 then k + interval '8 days' end);
    -- utilities: heat in winter, electric in summer
    amt := round((45 + case when m in (12,1,2) then 190 when m in (11,3) then 120 when m in (10,4) then 60 else 10 end + (i % 3) * 6)::numeric, 2);
    insert into payments (household_id, bill_id, period, amount, paid_at) values (h, b_gas, k, amt, case when i > 0 then k + interval '10 days' end);
    insert into payments (household_id, bill_id, period, amount, paid_at) values (h, b_water, k, round((52 + (i % 4) * 4.5)::numeric, 2), case when i > 0 then k + interval '22 days' end);
    insert into payments (household_id, bill_id, period, amount, paid_at) values (h, b_el_up, k, round((68 + case when m in (6,7,8) then 55 else 0 end + (i % 2) * 7.4)::numeric, 2), case when i > 0 then k + interval '16 days' end);
    insert into payments (household_id, bill_id, period, amount, paid_at) values (h, b_el_down, k, round((74 + case when m in (6,7,8) then 62 else 0 end + (i % 3) * 5.2)::numeric, 2), case when i > 0 then k + interval '18 days' end);
    insert into payments (household_id, bill_id, period, amount, paid_at) values (h, b_net, k, 15.49, case when i > 0 or extract(day from current_date) >= 20 then k + interval '19 days' end);
    insert into payments (household_id, bill_id, period, amount, paid_at) values (h, b_spot, k, 11.99, case when i > 0 or extract(day from current_date) >= 5 then k + interval '4 days' end);
    insert into payments (household_id, bill_id, period, amount, paid_at) values (h, b_phone, k, 65, case when i > 0 then k + interval '21 days' end);
    -- rent: Maria always on time; James late twice, and not in yet this month
    insert into rent_payments (household_id, rental_id, period, amount_due, amount_received, received_at, method, source)
      values (h, r_maria, k, 1650, 1650, k + interval '1 day 10 hours', 'Zelle', 'manual');
    if i > 0 then
      insert into rent_payments (household_id, rental_id, period, amount_due, amount_received, received_at, method, source)
        values (h, r_james, k, 1450, 1450, k + case when i in (3, 7) then interval '11 days' else interval '2 days' end + interval '9 hours', 'Zelle', 'manual');
    end if;
  end loop;

  insert into maintenance_tasks (household_id, unit_id, title, category, interval_months, last_done, next_due, vendor)
    values (h, u_whole, 'Test smoke & CO detectors', 'Safety', 6, current_date - 190, current_date - 8, null) returning id into t_smoke;
  insert into maintenance_tasks (household_id, unit_id, title, category, interval_months, last_done, next_due, vendor)
    values (h, u_whole, 'Furnace service', 'Heating & cooling', 12, current_date - 353, current_date + 12, 'Springfield Heating') returning id into t_furn;
  insert into maintenance_tasks (household_id, unit_id, title, category, interval_months, last_done, next_due, vendor)
    values (h, u_whole, 'Clean the gutters', 'Exterior', 6, current_date - 120, current_date + 62, null) returning id into t_gutter;
  insert into maintenance_tasks (household_id, unit_id, title, category, interval_months, last_done, next_due, vendor)
    values (h, u_whole, 'Replace HVAC filter', 'Heating & cooling', 3, current_date - 85, current_date + 5, null) returning id into t_filter;
  insert into maintenance_log (household_id, task_id, unit_id, title, done_on, cost, vendor) values
    (h, t_furn, u_whole, 'Furnace service', current_date - 353, 189, 'Springfield Heating'),
    (h, t_gutter, u_whole, 'Clean the gutters', current_date - 120, 160, 'Ace Gutters'),
    (h, null, u_up, 'Fixed leaking kitchen faucet', current_date - 75, 95, 'Bright Plumbing'),
    (h, null, u_down, 'Replaced bathroom fan', current_date - 33, 140, 'Me');
  insert into appliances (household_id, unit_id, kind, name, brand, installed_on, warranty_until)
    values (h, u_whole, 'Water heater', 'Water heater', 'Rheem', current_date - 365 * 6, current_date + 365 * 2);
end $$;
revoke all on function public.reset_demo() from public, anon, authenticated;

-- Rebuild the demo every night at 4:17 AM New York time (09:17 UTC)
select cron.unschedule(jobid) from cron.job where jobname = 'reset-demo';
select cron.schedule('reset-demo', '17 9 * * *', $$select public.reset_demo()$$);
