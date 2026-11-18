// Daily weather check (National Weather Service, free, US only). Run by pg_cron with x-cron-secret.
// - Freeze in the next 48h  -> push + pull "outdoor faucets" upkeep task forward to today
// - Active NWS alerts (winter storm, flood, wind, heat, ...) -> push with what to do
// The current notes are saved on households.weather for the app's banner.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import webpush from 'npm:web-push@3.6.7';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT') ?? 'mailto:reminders@example.com', Deno.env.get('VAPID_PUBLIC_KEY')!, Deno.env.get('VAPID_PRIVATE_KEY')!);
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const UA = { 'User-Agent': 'Doorstep/1.0 (landlord app)', Accept: 'application/geo+json' };

type Note = { kind: string; title: string; detail: string; until?: string | null };

const ADVICE: [RegExp, string][] = [
  [/winter storm|blizzard|snow|ice storm|freezing rain|winter weather/i, 'Clear sidewalks and steps after it ends, salt walkways, keep heat on in every unit and check on tenants.'],
  [/flood|coastal/i, 'Check the basement and sump pump, move valuables up, clear drains and gutters.'],
  [/wind|tropical|hurricane/i, 'Secure trash cans, furniture and anything loose outside; check for roof or siding damage after.'],
  [/heat/i, 'Check that tenants’ AC works; watch for power outages.'],
  [/freeze|frost|cold|chill/i, 'Drain outdoor faucets, keep heat at least 55°F, and open cabinet doors under sinks on outside walls.'],
];

async function getJson(url: string) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

async function notesFor(lat: number, lon: number): Promise<Note[]> {
  const notes: Note[] = [];
  const alerts = await getJson(`https://api.weather.gov/alerts/active?point=${lat},${lon}`);
  for (const f of alerts.features ?? []) {
    const p = f.properties ?? {};
    if (!/warning|watch|advisory/i.test(p.event ?? '')) continue;
    const advice = ADVICE.find(([re]) => re.test(p.event))?.[1] ?? 'Check the house and tenants.';
    notes.push({ kind: 'alert', title: p.event, detail: advice, until: p.ends ?? p.expires ?? null });
  }
  const pt = await getJson(`https://api.weather.gov/points/${lat},${lon}`);
  const fc = await getJson(pt.properties.forecast);
  const soon = (fc.properties?.periods ?? []).slice(0, 4); // ~48 hours
  const cold = soon.filter((x: { temperature: number; temperatureUnit: string }) => x.temperatureUnit === 'F' ? x.temperature <= 32 : x.temperature <= 0);
  if (cold.length) {
    const low = cold.reduce((a: { temperature: number }, b: { temperature: number }) => (b.temperature < a.temperature ? b : a));
    notes.push({ kind: 'freeze', title: `Freeze expected: ${low.temperature}°${low.temperatureUnit} ${low.name.toLowerCase()}`, detail: ADVICE[4][1], until: low.endTime ?? null });
  }
  return notes;
}

async function pushHousehold(householdId: string, payload: Record<string, unknown>) {
  const { data: members } = await db.from('household_members').select('user_id').eq('household_id', householdId);
  const { data: subs } = await db.from('push_subscriptions').select('id,endpoint,p256dh,auth').in('user_id', (members ?? []).map((m) => m.user_id));
  let sent = 0;
  for (const s of subs ?? []) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 43200 }); sent++; }
    catch (e) { const c = (e as { statusCode?: number }).statusCode; if (c === 404 || c === 410) await db.from('push_subscriptions').delete().eq('id', s.id); }
  }
  return { sent, members: members ?? [] };
}

Deno.serve(async (req) => {
  if (!CRON_SECRET || req.headers.get('x-cron-secret') !== CRON_SECRET) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const { data: houses } = await db.from('households').select('id,lat,lon').not('lat', 'is', null);
  const out: unknown[] = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const h of houses ?? []) {
    try {
      const notes = await notesFor(Number(h.lat), Number(h.lon));
      await db.from('households').update({ weather: notes, weather_at: new Date().toISOString() }).eq('id', h.id);
      let pushed = 0;
      for (const n of notes) {
        // one push per alert type per day per household
        const key = `weather:${h.id}:${today}:${n.kind}:${n.title.slice(0, 40)}`;
        const { data: m0 } = await db.from('household_members').select('user_id').eq('household_id', h.id).limit(1);
        if (!m0?.length) continue;
        const { error } = await db.from('reminder_log').insert({ payment_key: key, user_id: m0[0].user_id });
        if (error) continue;
        if (n.kind === 'freeze') {
          const { data: tasks } = await db.from('maintenance_tasks').select('id,last_done,next_due').eq('household_id', h.id).eq('active', true).ilike('title', '%outdoor faucet%');
          for (const t of tasks ?? []) {
            const recent = t.last_done && (Date.now() - Date.parse(t.last_done)) < 120 * 86400000;
            if (!recent && (!t.next_due || t.next_due > today)) await db.from('maintenance_tasks').update({ next_due: today }).eq('id', t.id);
          }
        }
        const r = await pushHousehold(h.id, { title: n.title, body: n.detail, tag: key, url: './' });
        pushed += r.sent;
      }
      out.push({ house: h.id, notes: notes.length, pushed });
    } catch (e) {
      console.error(e);
      out.push({ house: h.id, error: (e as Error).message });
    }
  }
  return Response.json({ ok: true, out });
});
