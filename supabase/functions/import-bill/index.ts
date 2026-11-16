// Receives utility emails from the household's Google Apps Script and fills in bills.
// Auth: the household's import_token (sent as x-import-token).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { matchAccount, matchTenant, parseEmail, parseZelle } from './parse.ts';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

const PROVIDER_NAMES: Record<string, RegExp> = {
  pseg: /pseg/i,
  nationalgrid: /national\s*grid/i,
  liberty: /liberty/i,
  rocket: /rocket/i,
};

type Msg = { id: string; from: string; subject: string; date: string; text: string };

Deno.serve(async (req) => {
  if (req.method !== 'POST') return Response.json({ error: 'POST only' }, { status: 405 });
  const token = req.headers.get('x-import-token') ?? '';
  if (token.length < 20) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const { data: house } = await db.from('households').select('id').eq('import_token', token).maybeSingle();
  if (!house) return Response.json({ error: 'unauthorized' }, { status: 401 });

  let body: { messages?: Msg[]; test?: boolean };
  try { body = await req.json(); } catch { return Response.json({ error: 'bad json' }, { status: 400 }); }
  if (body.test) return Response.json({ ok: true, house: true });
  const messages = (body.messages ?? []).slice(0, 50);

  const { data: bills } = await db.from('bills').select('id,name,account_number,due_day,amount_type').eq('household_id', house.id).eq('active', true);
  const results: { id: string; status: string; detail?: string }[] = [];

  for (const m of messages) {
    if (!m?.id) continue;
    const { data: seen } = await db.from('email_imports').select('status').eq('household_id', house.id).eq('message_id', m.id).maybeSingle();
    if (seen) { results.push({ id: m.id, status: 'duplicate' }); continue; }

    const received = new Date(m.date || Date.now());
    const text = String(m.text ?? '').slice(0, 60000);
    const p = parseEmail(m.from ?? '', m.subject ?? '', text, isNaN(+received) ? new Date() : received);
    const rec: Record<string, unknown> = {
      message_id: m.id, household_id: house.id, provider: p.provider, kind: p.kind, amount: p.amount, due_date: p.dueDate,
      subject: String(m.subject ?? '').slice(0, 300), received_at: isNaN(+received) ? null : received.toISOString(),
    };
    const done = async (status: string, detail: string, billId: string | null = null) => {
      await db.from('email_imports').insert({ ...rec, status, detail, bill_id: billId });
      results.push({ id: m.id, status, detail });
    };

    // Zelle rent payments
    const z = parseZelle(m.from ?? '', m.subject ?? '', text);
    if (z) {
      rec.kind = 'zelle'; rec.provider = 'zelle'; rec.amount = z.amount; rec.due_date = null; rec.payer = z.payer;
      if (!z.incoming) { await done('ignored', 'Not money received'); continue; }
      if (z.amount == null) { await done('unmatched', `Zelle from ${z.payer ?? 'someone'}: couldn’t read the amount`); continue; }
      const { data: rentals } = await db.from('rentals').select('id,tenant_name,payer_names,rent_amount,unit_id').eq('household_id', house.id).eq('active', true);
      const hit = matchTenant(z.payer, z.amount, rentals ?? []);
      if (!hit) { await done('unmatched', `$${z.amount.toFixed(2)} from ${z.payer ?? 'unknown'}`); continue; }
      const rental = (rentals ?? []).find((r) => r.id === hit.id)!;
      const rdate = isNaN(+received) ? new Date() : received;
      const key = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
      let period = key(rdate);
      const { data: cur } = await db.from('rent_payments').select('*').eq('rental_id', rental.id).eq('period', period).maybeSingle();
      const due = Number(cur?.amount_due ?? rental.rent_amount ?? 0);
      // Paid late in the month and this month is already covered: it's next month's rent.
      if (rdate.getUTCDate() >= 25 && due > 0 && Number(cur?.amount_received ?? 0) >= due) {
        period = key(new Date(Date.UTC(rdate.getUTCFullYear(), rdate.getUTCMonth() + 1, 1)));
      }
      const target = period === key(rdate) ? cur
        : (await db.from('rent_payments').select('*').eq('rental_id', rental.id).eq('period', period).maybeSingle()).data;
      const row = {
        id: target?.id ?? crypto.randomUUID(), household_id: house.id, rental_id: rental.id, period,
        amount_due: target?.amount_due ?? rental.rent_amount,
        amount_received: Math.round((Number(target?.amount_received ?? 0) + z.amount) * 100) / 100,
        received_at: rdate.toISOString(), method: 'Zelle', note: target?.note ?? null, source: 'email', updated_at: new Date().toISOString(),
      };
      const { error } = await db.from('rent_payments').upsert(row, { onConflict: 'rental_id,period' });
      if (error) { await done('unmatched', 'Save failed: ' + error.message); continue; }
      rec.rental_id = rental.id;
      await done('applied', `$${z.amount.toFixed(2)} from ${z.payer ?? 'tenant'} → ${rental.tenant_name ?? 'tenant'}, ${period.slice(0, 7)}${hit.how === 'amount' ? ' (matched by amount)' : ''}`);
      continue;
    }

    if (!p.provider) { await done('ignored', 'Not from a known utility'); continue; }
    if (p.kind === 'other') { await done('ignored', 'Not a bill or payment email'); continue; }
    const candidates = (bills ?? []).filter((b) => PROVIDER_NAMES[p.provider!].test(b.name));
    if (!candidates.length) { await done('unmatched', `No ${p.provider} bill in the app`); continue; }
    const billId = matchAccount(p.digits, text + ' ' + (m.subject ?? ''), candidates);
    if (!billId) { await done('unmatched', 'Couldn’t tell which account this email is for'); continue; }
    const bill = candidates.find((b) => b.id === billId)!;

    // Which month does this belong to? The due date's month, else the month the email arrived.
    const ref = p.dueDate ? new Date(p.dueDate + 'T12:00:00Z') : received;
    const period = `${ref.getUTCFullYear()}-${String(ref.getUTCMonth() + 1).padStart(2, '0')}-01`;
    const { data: existing } = await db.from('payments').select('*').eq('bill_id', bill.id).eq('period', period).maybeSingle();

    if (p.kind === 'payment') {
      // A payment email may arrive in the month after the bill's period; prefer the latest unpaid period.
      const { data: open } = await db.from('payments').select('*').eq('bill_id', bill.id).is('paid_at', null).order('period', { ascending: false }).limit(1);
      const target = open?.[0] ?? existing;
      if (target?.paid_at) { await done('already_paid', 'Already marked paid', bill.id); continue; }
      const per = target?.period ?? period;
      const row = {
        id: target?.id ?? crypto.randomUUID(), household_id: house.id, bill_id: bill.id, period: per,
        amount: target?.amount ?? p.amount, paid_at: received.toISOString(), method: target?.method ?? 'Online',
        source: 'email', updated_at: new Date().toISOString(),
      };
      const { error } = await db.from('payments').upsert(row, { onConflict: 'bill_id,period' });
      if (error) { await done('unmatched', 'Save failed: ' + error.message, bill.id); continue; }
      await done('applied', `Marked paid${p.amount ? ' · $' + p.amount.toFixed(2) : ''}`, bill.id);
      continue;
    }

    // Bill email
    if (p.amount == null && !p.dueDate) { await done('unmatched', 'Couldn’t find the amount or due date', bill.id); continue; }
    if (existing?.paid_at) { await done('already_paid', 'That month is already marked paid', bill.id); continue; }
    if (existing?.amount != null && existing.source !== 'email' && p.amount != null && Number(existing.amount) !== p.amount) {
      await done('kept_manual', `Kept your amount $${Number(existing.amount).toFixed(2)} (email says $${p.amount.toFixed(2)})`, bill.id); continue;
    }
    const row = {
      id: existing?.id ?? crypto.randomUUID(), household_id: house.id, bill_id: bill.id, period,
      amount: p.amount ?? existing?.amount ?? null, due_date: p.dueDate ?? existing?.due_date ?? null,
      source: 'email', updated_at: new Date().toISOString(),
    };
    const { error } = await db.from('payments').upsert(row, { onConflict: 'bill_id,period' });
    if (error) { await done('unmatched', 'Save failed: ' + error.message, bill.id); continue; }
    if (p.dueDate && !bill.due_day) await db.from('bills').update({ due_day: +p.dueDate.slice(8, 10) }).eq('id', bill.id);
    await done('applied', [p.amount != null ? '$' + p.amount.toFixed(2) : null, p.dueDate ? 'due ' + p.dueDate : null].filter(Boolean).join(' · '), bill.id);
  }

  return Response.json({ ok: true, results });
});
