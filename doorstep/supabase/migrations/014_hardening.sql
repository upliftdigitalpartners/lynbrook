-- Doorstep production hardening.

-- 1. Properties: members can read and edit; only an owner can delete one. New ones only come from create_household().
drop policy if exists households_rw on public.households;
drop policy if exists households_read on public.households;
drop policy if exists households_update on public.households;
drop policy if exists households_delete on public.households;
create policy households_read on public.households for select using (public.is_member(id));
create policy households_update on public.households for update using (public.is_member(id)) with check (public.is_member(id));
create policy households_delete on public.households for delete
  using (exists (select 1 from public.household_members m where m.household_id = id and m.user_id = auth.uid() and m.role = 'owner'));

-- 2. Account functions: signed-in people only (they already refuse anonymous callers, now they can't be called at all).
revoke execute on function public.create_household(text, text, text[]) from public, anon;
revoke execute on function public.delete_my_account() from public, anon;
revoke execute on function public.join_household(text) from public, anon;
revoke execute on function public.rotate_house_code(uuid) from public, anon;
revoke execute on function public.rotate_import_token(uuid) from public, anon;
grant execute on function public.create_household(text, text, text[]) to authenticated;
grant execute on function public.delete_my_account() to authenticated;
grant execute on function public.join_household(text) to authenticated;
grant execute on function public.rotate_house_code(uuid) to authenticated;
grant execute on function public.rotate_import_token(uuid) to authenticated;

-- 3. Uploads: photos and PDFs only, 10 MB each.
update storage.buckets set file_size_limit = 10485760,
  allowed_mime_types = array['image/jpeg','image/png','image/webp','image/heic','image/heif','image/gif','application/pdf']
  where id = 'receipts';
-- Private backups bucket: no policies, so only the server can read or write it.
insert into storage.buckets (id, name, public, file_size_limit) values ('backups', 'backups', false, 52428800) on conflict (id) do nothing;

-- 4. The shared demo login can't be hijacked: its email and password are put back every 15 minutes.
create or replace function public.demo_guard()
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  update auth.users set email = 'demo@doorstep.example', encrypted_password = crypt('doorstep-demo', gen_salt('bf')),
    email_confirmed_at = coalesce(email_confirmed_at, now()), banned_until = null
  where id = '2b54607a-9bc2-48d2-acd4-8096b6802813'
    and (email <> 'demo@doorstep.example' or encrypted_password <> crypt('doorstep-demo', encrypted_password) or banned_until is not null);
end $$;
revoke all on function public.demo_guard() from public, anon, authenticated;
select cron.unschedule(jobid) from cron.job where jobname = 'demo-guard';
select cron.schedule('demo-guard', '*/15 * * * *', $$select public.demo_guard()$$);

-- 5. Error reports from the app (write-only; read them in the Supabase dashboard).
create table if not exists public.app_errors (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid,
  message text not null,
  stack text,
  url text,
  agent text
);
alter table public.app_errors enable row level security;
create or replace function public.log_client_error(p_message text, p_stack text, p_url text, p_agent text)
returns void language plpgsql security definer set search_path = public as $$
begin
  -- throttle: 30 per person per hour, 300 per hour from signed-out visitors
  if auth.uid() is not null then
    if (select count(*) from app_errors where user_id = auth.uid() and at > now() - interval '1 hour') >= 30 then return; end if;
  elsif (select count(*) from app_errors where user_id is null and at > now() - interval '1 hour') >= 300 then return; end if;
  insert into app_errors (user_id, message, stack, url, agent)
    values (auth.uid(), left(coalesce(p_message, '?'), 500), left(p_stack, 2000), left(p_url, 300), left(p_agent, 300));
end $$;
revoke all on function public.log_client_error(text, text, text, text) from public;
grant execute on function public.log_client_error(text, text, text, text) to anon, authenticated;

-- 6. Feedback and contact messages (write-only; read them in the Supabase dashboard).
create table if not exists public.feedback (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid,
  email text,
  message text not null,
  page text
);
alter table public.feedback enable row level security;
create or replace function public.send_feedback(p_message text, p_email text, p_page text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if coalesce(trim(p_message), '') = '' then raise exception 'Write a message first'; end if;
  if auth.uid() is not null then
    if (select count(*) from feedback where user_id = auth.uid() and at > now() - interval '1 day') >= 10 then raise exception 'Thanks! You''ve sent a lot today. Try again tomorrow.'; end if;
  elsif (select count(*) from feedback where user_id is null and at > now() - interval '1 hour') >= 30 then raise exception 'Too many messages right now. Try again later.'; end if;
  insert into feedback (user_id, email, message, page)
    values (auth.uid(), nullif(left(trim(coalesce(p_email, '')), 200), ''), left(trim(p_message), 4000), left(p_page, 100));
end $$;
revoke all on function public.send_feedback(text, text, text) from public;
grant execute on function public.send_feedback(text, text, text) to anon, authenticated;

-- 7. Tidy-up: old error reports and AI counters after 30 days.
select cron.unschedule(jobid) from cron.job where jobname = 'prune-logs';
select cron.schedule('prune-logs', '41 8 * * *', $$delete from public.app_errors where at < now() - interval '30 days'; delete from public.ai_usage where day < current_date - 30$$);
