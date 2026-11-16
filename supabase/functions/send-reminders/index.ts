// Sends bill reminders as Web Push notifications.
// Called hourly by pg_cron (x-cron-secret header) and by the app's "Send test" button (user JWT).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:reminders@example.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type Sub = { id: string; endpoint: string; p256dh: string; auth: string };

async function push(userId: string, payload: Record<string, unknown>) {
  const { data: subs } = await db.from('push_subscriptions').select('id,endpoint,p256dh,auth').eq('user_id', userId);
  let sent = 0;
  for (const s of (subs ?? []) as Sub[]) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 60 * 60 * 12 });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.from('push_subscriptions').delete().eq('id', s.id);
      else console.error('push failed', code, (e as Error).message);
    }
  }
  return sent;
}

function localParts(tz: string, d = new Date()) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour };
}

const money = (n: number) => '$' + n.toFixed(2);

async function runReminders() {
  const { data: members } = await db.from('household_members').select('household_id,user_id,remind_days,remind_hour,timezone');
  let total = 0;
  for (const mem of members ?? []) {
    const now = localParts(mem.timezone);
    if (now.h !== mem.remind_hour) continue;
    const period = `${now.y}-${String(now.m).padStart(2, '0')}-01`;
    const daysInMonth = new Date(Date.UTC(now.y, now.m, 0)).getUTCDate();
    const { data: bills } = await db.from('bills').select('id,name,label,due_day,default_amount,amount_type,autopay,escrow,due_months').eq('household_id', mem.household_id).eq('active', true);
    const { data: pays } = await db.from('payments').select('bill_id,amount,paid_at').eq('household_id', mem.household_id).eq('period', period);
    const payBy = new Map((pays ?? []).map((p) => [p.bill_id, p]));
    const lines: string[] = [];
    for (const b of bills ?? []) {
      if (!b.due_day || b.autopay || b.escrow) continue;
      if (b.due_months && b.due_months.length && !b.due_months.includes(now.m)) continue;
      const pay = payBy.get(b.id);
      if (pay?.paid_at) continue;
      const due = Math.min(b.due_day, daysInMonth);
      const diff = due - now.d;
      let kind = '';
      if (diff === mem.remind_days && diff > 0) kind = 'soon';
      else if (diff === 0) kind = 'today';
      else if (diff === -1) kind = 'overdue';
      if (!kind) continue;
      const key = `${b.id}:${period}:${kind}`;
      const { error } = await db.from('reminder_log').insert({ payment_key: key, user_id: mem.user_id });
      if (error) continue; // already sent
      const amt = pay?.amount ?? (b.amount_type === 'fixed' ? b.default_amount : null);
      const name = b.label ? `${b.name} (${b.label})` : b.name;
      const when = kind === 'soon' ? `due in ${diff} day${diff === 1 ? '' : 's'}` : kind === 'today' ? 'due today' : 'was due yesterday';
      lines.push(`${name} ${when}${amt ? ' · ' + money(Number(amt)) : ''}`);
    }
    // Rent: on the due day, and the day after the grace period if not fully received
    const { data: rentals } = await db.from('rentals').select('id,tenant_name,rent_amount,due_day,grace_days,unit_id,units(name)').eq('household_id', mem.household_id).eq('active', true);
    const { data: rpays } = await db.from('rent_payments').select('rental_id,amount_due,amount_received').eq('household_id', mem.household_id).eq('period', period);
    const rBy = new Map((rpays ?? []).map((p) => [p.rental_id, p]));
    for (const r of rentals ?? []) {
      if (!r.rent_amount) continue;
      const rp = rBy.get(r.id);
      const due = Number(rp?.amount_due ?? r.rent_amount);
      if (Number(rp?.amount_received ?? 0) >= due) continue;
      const dueDay = Math.min(r.due_day, daysInMonth);
      const lateDay = dueDay + (r.grace_days ?? 0) + 1;
      let kind = '';
      if (now.d === dueDay) kind = 'rent-due';
      else if (now.d === lateDay) kind = 'rent-late';
      if (!kind) continue;
      const key = `${r.id}:${period}:${kind}`;
      const { error } = await db.from('reminder_log').insert({ payment_key: key, user_id: mem.user_id });
      if (error) continue;
      // deno-lint-ignore no-explicit-any
      const who = r.tenant_name || (r as any).units?.name || 'tenant';
      const left = due - Number(rp?.amount_received ?? 0);
      lines.push(kind === 'rent-due' ? `Rent due today from ${who} · ${money(left)}` : `Rent from ${who} is late · ${money(left)} not received`);
    }

    // Leases ending in 90 / 60 / 30 days; deposit return deadline (14 days after move-out)
    const { data: leases } = await db.from('rentals').select('id,tenant_name,lease_end,move_out_on,deposit_returned_on,deposit').eq('household_id', mem.household_id);
    const dayIso = `${now.y}-${String(now.m).padStart(2, '0')}-${String(now.d).padStart(2, '0')}`;
    const daysTo = (iso: string) => Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(dayIso + 'T00:00:00Z')) / 86400000);
    for (const r of leases ?? []) {
      const who = r.tenant_name || 'Tenant';
      if (r.lease_end && !r.move_out_on) {
        const d = daysTo(r.lease_end);
        if (d === 90 || d === 60 || d === 30) {
          const { error } = await db.from('reminder_log').insert({ payment_key: `${r.id}:lease:${r.lease_end}:${d}`, user_id: mem.user_id });
          if (!error) lines.push(`${who}'s lease ends in ${d} days. Renew or plan move-out.`);
        }
      }
      if (r.move_out_on && !r.deposit_returned_on) {
        const left = 14 - (-daysTo(r.move_out_on));
        if (left === 4 || left === 1 || left === 0) {
          const { error } = await db.from('reminder_log').insert({ payment_key: `${r.id}:deposit:${r.move_out_on}:${left}`, user_id: mem.user_id });
          if (!error) lines.push(left === 0 ? `Last day to return ${who}'s deposit (NY 14-day rule)` : `Return ${who}'s deposit within ${left} day${left === 1 ? '' : 's'} (NY 14-day rule)`);
        }
      }
    }

    // Upkeep: remind_days before, and on the day it's due
    const todayIso = `${now.y}-${String(now.m).padStart(2, '0')}-${String(now.d).padStart(2, '0')}`;
    const { data: tasks } = await db.from('maintenance_tasks').select('id,title,next_due').eq('household_id', mem.household_id).eq('active', true).not('next_due', 'is', null);
    for (const t of tasks ?? []) {
      const diff = Math.round((Date.parse(t.next_due + 'T00:00:00Z') - Date.parse(todayIso + 'T00:00:00Z')) / 86400000);
      let kind = '';
      if (diff === mem.remind_days && diff > 0) kind = 'soon';
      else if (diff === 0) kind = 'today';
      if (!kind) continue;
      const key = `${t.id}:${t.next_due}:${kind}`;
      const { error } = await db.from('reminder_log').insert({ payment_key: key, user_id: mem.user_id });
      if (error) continue;
      lines.push(kind === 'today' ? `Upkeep due today: ${t.title}` : `Upkeep in ${diff} day${diff === 1 ? '' : 's'}: ${t.title}`);
    }

    if (!lines.length) continue;
    total += await push(mem.user_id, {
      title: lines.length === 1 ? 'House reminder' : `${lines.length} things need attention`,
      body: lines.join('\n'),
      tag: `bills-${period}-${now.d}`,
      url: './',
    });
  }
  return total;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    if (CRON_SECRET && req.headers.get('x-cron-secret') === CRON_SECRET) {
      const sent = await runReminders();
      return Response.json({ ok: true, sent }, { headers: cors });
    }
    const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data } = await db.auth.getUser(token);
    if (!data?.user) return Response.json({ error: 'unauthorized' }, { status: 401, headers: cors });
    const sent = await push(data.user.id, { title: 'Evergreen House', body: 'Notifications are working. You will get bill reminders here.', tag: 'test', url: './' });
    return Response.json({ ok: true, sent }, { headers: cors });
  } catch (e) {
    console.error(e);
    return Response.json({ error: (e as Error).message }, { status: 500, headers: cors });
  }
});
