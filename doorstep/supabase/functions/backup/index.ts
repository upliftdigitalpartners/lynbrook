// Nightly backup: every app table as one JSON file in the private "backups" bucket. Keeps the last 14 days.
// Called by pg_cron with the x-cron-secret header. (Supabase's free plan has no automatic database backups.)
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const TABLES = ['households', 'household_members', 'units', 'bills', 'payments', 'rentals', 'rent_payments', 'rent_notices',
  'maintenance_tasks', 'maintenance_log', 'appliances', 'contractors', 'documents', 'lease_history', 'inspections',
  'repair_requests', 'email_imports', 'feedback'];
const KEEP = 14;

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) return new Response('Forbidden', { status: 403 });
  const out: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  for (const t of TABLES) {
    const rows: unknown[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from(t).select('*').range(from, from + 999);
      if (error) return Response.json({ ok: false, table: t, error: error.message }, { status: 500 });
      rows.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    out[t] = rows; counts[t] = rows.length;
  }
  const day = new Date().toISOString().slice(0, 10);
  const body = new Blob([JSON.stringify({ app: 'Doorstep', at: new Date().toISOString(), tables: out })], { type: 'application/json' });
  const up = await db.storage.from('backups').upload(`db/${day}.json`, body, { upsert: true, contentType: 'application/json' });
  if (up.error) return Response.json({ ok: false, error: up.error.message }, { status: 500 });
  const { data: files } = await db.storage.from('backups').list('db', { limit: 200, sortBy: { column: 'name', order: 'desc' } });
  const old = (files ?? []).map((f) => f.name).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).slice(KEEP).map((n) => 'db/' + n);
  if (old.length) await db.storage.from('backups').remove(old);
  return Response.json({ ok: true, file: `db/${day}.json`, counts, removed: old.length });
});
