// Public tenant page API. A tenant's private link carries their rental's portal_token.
// GET  ?t=TOKEN               -> name, unit, rent, last 6 months of rent, their repair requests
// POST {t, title, details, urgency, photo?: {name, type, base64}} -> new repair request (+ push to the household)
// POST {t, action: 'paid', amount, method, note} -> "I've paid" notice for the landlord to confirm (+ push)
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import webpush from 'npm:web-push@3.6.7';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT') ?? 'mailto:reminders@example.com', Deno.env.get('VAPID_PUBLIC_KEY')!, Deno.env.get('VAPID_PRIVATE_KEY')!);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, apikey, authorization, x-client-info',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (b: unknown, status = 200) => Response.json(b, { status, headers: cors });

async function rentalFor(token: string | null) {
  if (!token || !/^[0-9a-f]{16,64}$/.test(token)) return null;
  const { data } = await db.from('rentals').select('id,household_id,unit_id,tenant_name,rent_amount,due_day,grace_days,late_fee,lease_end,active,units(name),households(name,address,pay_zelle,pay_note)').eq('portal_token', token).eq('active', true).maybeSingle();
  return data;
}

async function notifyHousehold(householdId: string, payload: Record<string, unknown>) {
  const { data: members } = await db.from('household_members').select('user_id').eq('household_id', householdId);
  const ids = (members ?? []).map((m) => m.user_id);
  if (!ids.length) return;
  const { data: subs } = await db.from('push_subscriptions').select('id,endpoint,p256dh,auth').in('user_id', ids);
  for (const s of subs ?? []) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 86400 }); }
    catch (e) { const c = (e as { statusCode?: number }).statusCode; if (c === 404 || c === 410) await db.from('push_subscriptions').delete().eq('id', s.id); }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    if (req.method === 'GET') {
      const r = await rentalFor(new URL(req.url).searchParams.get('t'));
      if (!r) return json({ error: 'This link isn’t active. Ask your landlord for a new one.' }, 404);
      const now = new Date();
      const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1)).toISOString().slice(0, 10);
      const [{ data: pays }, { data: reqs }, { data: notes }] = await Promise.all([
        db.from('rent_payments').select('period,amount_due,amount_received,received_at,method').eq('rental_id', r.id).gte('period', since).order('period', { ascending: false }),
        db.from('repair_requests').select('id,title,status,reply,created_at,updated_at').eq('rental_id', r.id).order('created_at', { ascending: false }).limit(20),
        db.from('rent_notices').select('period,amount,method,status,created_at').eq('rental_id', r.id).gte('period', since).order('created_at', { ascending: false }).limit(10),
      ]);
      // deno-lint-ignore no-explicit-any
      const rr = r as any;
      return json({
        tenant: r.tenant_name, unit: rr.units?.name ?? null, house: rr.households?.name ?? null, address: rr.households?.address ?? null,
        rent: r.rent_amount, due_day: r.due_day, grace_days: r.grace_days, late_fee: r.late_fee, lease_end: r.lease_end,
        payments: pays ?? [], requests: reqs ?? [], notices: notes ?? [],
        pay_zelle: rr.households?.pay_zelle ?? null, pay_note: rr.households?.pay_note ?? null,
      });
    }
    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const r = await rentalFor(body.t ?? null);
      if (!r) return json({ error: 'This link isn’t active.' }, 404);
      if (body.action === 'paid') {
        const amount = Math.round(Number(body.amount) * 100) / 100;
        if (!(amount > 0 && amount < 100000)) return json({ error: 'Enter the amount you paid.' }, 400);
        const method = ['Zelle', 'Venmo', 'Check', 'Cash', 'Bank transfer', 'Other'].includes(body.method) ? body.method : 'Other';
        const note = String(body.note ?? '').trim().slice(0, 200) || null;
        const dayAgo = new Date(Date.now() - 86400000).toISOString();
        const { count } = await db.from('rent_notices').select('id', { count: 'exact', head: true }).eq('rental_id', r.id).gte('created_at', dayAgo);
        if ((count ?? 0) >= 5) return json({ error: 'You’ve already told your landlord today. They’ll confirm it soon.' }, 429);
        const now = new Date(); const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
        const { error } = await db.from('rent_notices').insert({ household_id: r.household_id, rental_id: r.id, period, amount, method, note });
        if (error) return json({ error: 'Couldn’t send it. Please try again.' }, 500);
        // deno-lint-ignore no-explicit-any
        const unit = (r as any).units?.name ?? 'your rental';
        await notifyHousehold(r.household_id, { title: `${r.tenant_name ?? 'Your tenant'} says rent is paid`, body: `$${amount.toFixed(2)} by ${method} · ${unit}. Open Rent to confirm.`, tag: 'rent-notice-' + r.id, url: './' });
        return json({ ok: true });
      }
      const title = String(body.title ?? '').trim().slice(0, 120);
      if (!title) return json({ error: 'Say what needs fixing.' }, 400);
      const details = String(body.details ?? '').trim().slice(0, 4000) || null;
      const urgency = body.urgency === 'urgent' ? 'urgent' : 'normal';
      // Simple flood guard: at most 10 requests per rental per day
      const dayAgo = new Date(Date.now() - 86400000).toISOString();
      const { count } = await db.from('repair_requests').select('id', { count: 'exact', head: true }).eq('rental_id', r.id).gte('created_at', dayAgo);
      if ((count ?? 0) >= 10) return json({ error: 'Too many requests today. Please call your landlord.' }, 429);
      let photo_path: string | null = null;
      if (body.photo?.base64) {
        const type = String(body.photo.type || 'image/jpeg');
        if (!/^image\/(jpeg|png|webp|heic|heif|gif)$/.test(type)) return json({ error: 'Photos only, please.' }, 400);
        const bytes = Uint8Array.from(atob(String(body.photo.base64)), (c) => c.charCodeAt(0));
        if (bytes.length > 8 * 1024 * 1024) return json({ error: 'That photo is too large (8 MB max).' }, 400);
        const ext = type.split('/')[1].replace('jpeg', 'jpg');
        photo_path = `${r.household_id}/requests/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
        const up = await db.storage.from('receipts').upload(photo_path, bytes, { contentType: type });
        if (up.error) photo_path = null;
      }
      const { data: created, error } = await db.from('repair_requests').insert({
        household_id: r.household_id, rental_id: r.id, unit_id: r.unit_id, title, details, urgency, photo_path,
      }).select('id').single();
      if (error) return json({ error: 'Couldn’t send it. Please try again.' }, 500);
      // deno-lint-ignore no-explicit-any
      const unit = (r as any).units?.name ?? 'tenant';
      await notifyHousehold(r.household_id, {
        title: (urgency === 'urgent' ? 'URGENT repair: ' : 'Repair request: ') + unit,
        body: `${r.tenant_name ?? 'Tenant'}: ${title}`, tag: 'req-' + created.id, url: './',
      });
      return json({ ok: true, id: created.id });
    }
    return json({ error: 'Not allowed' }, 405);
  } catch (e) {
    console.error(e);
    return json({ error: 'Something went wrong.' }, 500);
  }
});
