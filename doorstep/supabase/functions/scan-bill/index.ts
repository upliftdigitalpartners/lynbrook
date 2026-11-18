// Reads a photo of a paper bill with Groq (vision model) and returns the key fields.
// Auth: the signed-in household user's JWT. Needs the GROQ_API_KEY secret.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const GROQ_KEY = Deno.env.get('GROQ_API_KEY') ?? '';
const MODEL = Deno.env.get('GROQ_VISION_MODEL') ?? 'qwen/qwen3.8-27b';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, status = 200) => Response.json(b, { status, headers: cors });

let cachedModel: string | null = null;
let lastModels = '';
async function pickVisionModel(skip: string): Promise<string | null> {
  const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${GROQ_KEY}` } });
  if (!r.ok) { lastModels = 'models list failed: ' + r.status; return null; }
  const ids: string[] = ((await r.json()).data ?? []).filter((m: { active?: boolean }) => m.active !== false).map((m: { id: string }) => m.id);
  lastModels = ids.join(', ');
  const prefs = [/llama-4-scout/i, /llama-4-maverick/i, /llama-4/i, /vision/i, /\bvl\b|-vl-/i, /qwen/i];
  for (const re of prefs) { const hit = ids.find((id) => re.test(id) && id !== skip); if (hit) return hit; }
  return null;
}

const PROMPT = `You read photos of US household bills (utilities, mortgage, insurance, taxes).
Return ONLY a JSON object with these keys:
"provider": company name as printed (string or null),
"category": one of "Electric","Gas","Water","Internet & phone","Mortgage","Insurance","Property tax","Trash","Other",
"account_number": the full account number with digits only (string or null),
"amount_due": total amount due now as a number (no $), or null,
"due_date": payment due date as YYYY-MM-DD, or null,
"service_period": short text like "Oct 10 – Nov 9" or null,
"confidence": "high", "medium" or "low".
Use null for anything you cannot read clearly. Do not guess.`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: u } = await db.auth.getUser(token);
  if (!u?.user) return json({ error: 'Sign in first.' }, 401);
  const { count } = await db.from('household_members').select('user_id', { count: 'exact', head: true }).eq('user_id', u.user.id);
  if (!count) return json({ error: 'Not part of a household.' }, 403);
  if (!GROQ_KEY) return json({ error: 'Bill scanning isn’t switched on for Doorstep yet.' }, 503);
  {
    const lim = u.user.email === 'demo@doorstep.example' ? 25 : 80;
    const { data: allowed } = await db.rpc('bump_ai', { p_user: u.user.id, p_limit: lim });
    if (allowed === false) return json({ error: 'You’ve used today’s AI allowance (' + lim + '). It resets tomorrow.', limit: true }, 429);
  }

  const body = await req.json().catch(() => ({}));
  const b64 = String(body.image ?? '');
  const type = String(body.type ?? 'image/jpeg');
  if (!b64 || !/^image\/(jpeg|png|webp)$/.test(type)) return json({ error: 'Send a JPEG, PNG or WebP photo.' }, 400);
  if (b64.length > 5_500_000) return json({ error: 'Photo too large.' }, 400);

  const ask = (model: string) => fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_completion_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: [
        { type: 'text', text: PROMPT },
        { type: 'image_url', image_url: { url: `data:${type};base64,${b64}` } },
      ] }],
    }),
  });
  let model = cachedModel || MODEL;
  let r = await ask(model);
  let out = await r.json().catch(() => ({}));
  if (r.status === 404 || r.status === 400 && /model/i.test(JSON.stringify(out))) {
    // The model was renamed or retired: pick a current vision model from Groq's list and retry once
    const alt = await pickVisionModel(model);
    if (alt) { model = alt; r = await ask(model); out = await r.json().catch(() => ({})); if (r.ok) cachedModel = model; }
  }
  if (!r.ok) {
    const msg = String(out?.error?.message ?? '').slice(0, 200);
    console.error('groq', r.status, model, msg);
    return json({ error: 'The bill reader is unavailable (' + r.status + (msg ? ': ' + msg : '') + ').', model, available: lastModels || undefined }, 502);
  }
  let fields: Record<string, unknown> = {};
  try { fields = JSON.parse(out.choices?.[0]?.message?.content ?? '{}'); } catch { return json({ error: 'Couldn’t read that photo. Try a clearer, flatter shot.' }, 422); }
  const amount = typeof fields.amount_due === 'number' ? fields.amount_due : parseFloat(String(fields.amount_due ?? '').replace(/[$,]/g, ''));
  const due = /^\d{4}-\d{2}-\d{2}$/.test(String(fields.due_date ?? '')) ? String(fields.due_date) : null;
  return json({
    provider: fields.provider ?? null,
    category: fields.category ?? null,
    account_number: fields.account_number ? String(fields.account_number).replace(/\D/g, '') || null : null,
    amount_due: isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : null,
    due_date: due,
    service_period: fields.service_period ?? null,
    confidence: fields.confidence ?? 'low',
  });
});
