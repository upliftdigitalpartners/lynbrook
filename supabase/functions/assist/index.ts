// Groq-powered helpers for signed-in household members.
// mode "parse":   free text ("paid PSEG 2nd floor $96 yesterday") -> proposed actions (the app asks before saving)
// mode "ask":     question + compact household data -> short answer
// mode "receipt": photo of a store/contractor receipt -> vendor, date, total, summary
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const GROQ_KEY = Deno.env.get('GROQ_API_KEY') ?? '';
const TEXT_MODEL = Deno.env.get('GROQ_TEXT_MODEL') ?? 'openai/gpt-oss-120b';
const VISION_MODEL = Deno.env.get('GROQ_VISION_MODEL') ?? 'qwen/qwen3.8-27b';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, status = 200) => Response.json(b, { status, headers: cors });

let modelCache: string[] | null = null;
async function models(): Promise<string[]> {
  if (modelCache) return modelCache;
  const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${GROQ_KEY}` } });
  modelCache = r.ok ? ((await r.json()).data ?? []).map((m: { id: string }) => m.id) : [];
  return modelCache!;
}
async function pick(preferred: string, prefs: RegExp[]): Promise<string> {
  const ids = await models();
  if (!ids.length || ids.includes(preferred)) return preferred;
  for (const re of prefs) { const hit = ids.find((id) => re.test(id)); if (hit) return hit; }
  return preferred;
}

async function chat(model: string, messages: unknown[], asJson: boolean, maxTokens = 900) {
  const body: Record<string, unknown> = { model, messages, temperature: 0.1, max_completion_tokens: maxTokens };
  if (asJson) body.response_format = { type: 'json_object' };
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Groq ${r.status}: ${String(out?.error?.message ?? '').slice(0, 200)}`);
  return String(out.choices?.[0]?.message?.content ?? '');
}
function parseJson(s: string) {
  try { return JSON.parse(s); } catch { const m = s.match(/\{[\s\S]*\}/); if (m) { try { return JSON.parse(m[0]); } catch { /* fallthrough */ } } }
  return null;
}

const PARSE_PROMPT = `You turn short notes from a landlord about their house into structured actions.
Today is {TODAY}. Dates must be YYYY-MM-DD. Resolve "yesterday", "last Friday", month names, etc. relative to today.
You are given the household's bills, rentals and upkeep tasks with ids. Only use ids from these lists.
Return ONLY JSON: {"actions":[...], "note": "one short sentence describing what you understood, or what is unclear"}.
Allowed actions:
- {"type":"bill_paid","bill_id":ID,"amount":number|null,"date":DATE|null}            (a bill was paid)
- {"type":"bill_amount","bill_id":ID,"amount":number,"due_date":DATE|null}           (a bill came in for this amount)
- {"type":"rent_received","rental_id":ID,"amount":number|null,"date":DATE|null,"method":"Zelle"|"Venmo"|"Check"|"Cash"|"Bank transfer"|"Other"|null}
- {"type":"task_done","task_id":ID,"date":DATE|null,"cost":number|null,"vendor":string|null}
- {"type":"repair","title":string,"date":DATE|null,"cost":number|null,"vendor":string|null,"unit_id":ID|null}
If a bill or tenant is ambiguous (e.g. two PSEG accounts and no floor given), leave actions empty and say what is missing in "note".
Amounts: numbers only, no $ or commas.`;

const ASK_PROMPT = `You are the assistant inside a landlord's house app for a two-family rental at 110 Evergreen Ave, Lynbrook NY (the owner lives elsewhere, at "Cedarcroft", which is their home, not part of the rental).
Answer the question using ONLY the JSON data provided. Be brief and concrete: lead with the answer (numbers, dates), then at most 2 short supporting lines.
If the data doesn't contain the answer, say so plainly and suggest what to record in the app. Use $ with 2 decimals for money. Today is {TODAY}.
Do not give legal or tax advice beyond general pointers; suggest an accountant or attorney for specifics.`;

const RECEIPT_PROMPT = `Read this photo of a receipt or invoice for home repairs/maintenance.
Return ONLY JSON: {"vendor": string|null, "date": "YYYY-MM-DD"|null, "total": number|null, "summary": short description of what was bought or done (max 8 words)|null,
"category": one of "Plumbing","Electrical","Heating & cooling","Appliances","Exterior","Yard","Cleaning","Pest control","Safety","Other", "confidence":"high"|"medium"|"low"}.
Use the grand total (after tax). Use null for anything unclear. Do not guess.`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: u } = await db.auth.getUser(token);
  if (!u?.user) return json({ error: 'Sign in first.' }, 401);
  const { count } = await db.from('household_members').select('user_id', { count: 'exact', head: true }).eq('user_id', u.user.id);
  if (!count) return json({ error: 'Not part of a household.' }, 403);
  if (!GROQ_KEY) return json({ error: 'Add the GROQ_API_KEY secret in Supabase first.' }, 503);

  const body = await req.json().catch(() => ({}));
  const today = String(body.today ?? new Date().toISOString().slice(0, 10)).slice(0, 10);
  try {
    if (body.mode === 'parse') {
      const text = String(body.text ?? '').slice(0, 500).trim();
      if (!text) return json({ error: 'Type what happened.' }, 400);
      const model = await pick(TEXT_MODEL, [/gpt-oss-120b/, /gpt-oss/, /qwen/, /llama/]);
      const out = await chat(model, [
        { role: 'system', content: PARSE_PROMPT.replace('{TODAY}', today) },
        { role: 'user', content: 'Household data:\n' + JSON.stringify(body.context ?? {}).slice(0, 12000) + '\n\nNote: ' + text },
      ], true);
      const j = parseJson(out);
      if (!j) return json({ error: 'Couldn’t understand that. Try rephrasing.' }, 422);
      return json({ actions: Array.isArray(j.actions) ? j.actions.slice(0, 8) : [], note: j.note ?? null, model });
    }
    if (body.mode === 'ask') {
      const q = String(body.question ?? '').slice(0, 600).trim();
      if (!q) return json({ error: 'Ask a question.' }, 400);
      const model = await pick(TEXT_MODEL, [/gpt-oss-120b/, /gpt-oss/, /qwen/, /llama/]);
      const history = (Array.isArray(body.history) ? body.history : []).slice(-6).map((m: { role: string; content: string }) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 1500) }));
      const answer = await chat(model, [
        { role: 'system', content: ASK_PROMPT.replace('{TODAY}', today) + '\n\nHousehold data (JSON):\n' + JSON.stringify(body.context ?? {}).slice(0, 60000) },
        ...history,
        { role: 'user', content: q },
      ], false, 700);
      return json({ answer: answer.trim(), model });
    }
    if (body.mode === 'receipt') {
      const b64 = String(body.image ?? ''); const type = String(body.type ?? 'image/jpeg');
      if (!b64 || !/^image\/(jpeg|png|webp)$/.test(type)) return json({ error: 'Send a JPEG, PNG or WebP photo.' }, 400);
      if (b64.length > 5_500_000) return json({ error: 'Photo too large.' }, 400);
      const model = await pick(VISION_MODEL, [/llama-4/, /vision/, /qwen/]);
      const out = await chat(model, [{ role: 'user', content: [
        { type: 'text', text: RECEIPT_PROMPT },
        { type: 'image_url', image_url: { url: `data:${type};base64,${b64}` } },
      ] }], true, 400);
      const j = parseJson(out) ?? {};
      const total = typeof j.total === 'number' ? j.total : parseFloat(String(j.total ?? '').replace(/[$,]/g, ''));
      return json({
        vendor: j.vendor ?? null, date: /^\d{4}-\d{2}-\d{2}$/.test(String(j.date ?? '')) ? j.date : null,
        total: isFinite(total) && total > 0 ? Math.round(total * 100) / 100 : null, summary: j.summary ?? null,
        category: j.category ?? null, confidence: j.confidence ?? 'low', model,
      });
    }
    return json({ error: 'Unknown mode' }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: 'The assistant is unavailable right now. ' + (e as Error).message }, 502);
  }
});
