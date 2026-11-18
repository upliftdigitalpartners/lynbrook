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

class GroqError extends Error { constructor(public status: number, msg: string) { super(msg); } }
async function chatOnce(model: string, messages: unknown[], asJson: boolean, maxTokens: number) {
  const body: Record<string, unknown> = { model, messages, temperature: 0.1, max_completion_tokens: maxTokens };
  if (asJson) body.response_format = { type: 'json_object' };
  if (/gpt-oss/.test(model)) body.reasoning_effort = 'low'; // short thinking so the answer fits in the reply budget
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new GroqError(r.status, `Groq ${r.status}: ${String(out?.error?.message ?? '').slice(0, 200)}`);
  const text = String(out.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!text) throw new GroqError(502, 'Empty reply');
  return text;
}
// Free Groq plans cap tokens per minute per model. When one model is over its limit (413/429) or down (5xx),
// try the next available model, which has its own separate limit.
const TEXT_FALLBACKS = [/gpt-oss-120b/, /llama-3\.3-70b/, /qwen3-32b/, /gpt-oss-20b/, /llama-3\.1-8b/];
let lastModel = '';
async function chat(model: string, messages: unknown[], asJson: boolean, maxTokens = 900) {
  const ids = await models();
  const chain = [model];
  if (!/vision|qwen3\.8|llama-4/.test(model)) for (const re of TEXT_FALLBACKS) { const hit = ids.find((id) => re.test(id) && !/guard|safeguard/.test(id)); if (hit && !chain.includes(hit)) chain.push(hit); }
  let last: unknown = null;
  for (const m of chain.slice(0, 5)) {
    try { const out = await chatOnce(m, messages, asJson, maxTokens); lastModel = m; return out; }
    catch (e) { last = e; if (!(e instanceof GroqError) || !(e.status === 413 || e.status === 429 || e.status >= 500 || e.status === 404 || e.status === 400 && /json|response_format/i.test(e.message))) throw e; console.warn('fallback after', m, e.message); }
  }
  if (last instanceof GroqError && (last.status === 413 || last.status === 429)) throw new Error('BUSY');
  throw last;
}
// Keep requests well under the free-plan per-minute token limit (~8k tokens).
function fit(ctx: unknown, maxChars: number): string {
  let s = JSON.stringify(ctx ?? {});
  if (s.length <= maxChars) return s;
  const c = JSON.parse(s);
  // Trim the longest arrays and month maps first, keeping the most recent entries.
  for (let round = 0; round < 12 && s.length > maxChars; round++) {
    const walk = (o: any) => {
      if (!o || typeof o !== 'object') return;
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (Array.isArray(v) && v.length > 4) o[k] = v.slice(0, Math.ceil(v.length * 0.6));
        else if (v && typeof v === 'object' && /^\d{4}-\d{2}$/.test(Object.keys(v)[0] ?? '')) { const ks = Object.keys(v).sort(); if (ks.length > 3) for (const x of ks.slice(0, Math.floor(ks.length * 0.4))) delete v[x]; }
        else walk(v);
      }
    };
    walk(c); s = JSON.stringify(c);
  }
  return s.slice(0, maxChars);
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

const ASK_PROMPT = `You are the assistant inside Doorstep, an app for small landlords. The household data covers one property: its rental units, bills, rent, upkeep and mortgage. Places marked home_not_rental (the owner's own home, or "Personal" expenses) are not part of the rental.
Answer the question using ONLY the JSON data provided. Be brief and concrete: lead with the answer (numbers, dates), then at most 2 short supporting lines.
Write plain text for a phone chat bubble: no markdown, no tables, no headings, no bold; use short lines, one item per line.
If the data doesn't contain the answer, say so plainly and suggest what to record in the app. Use $ with 2 decimals for money. Today is {TODAY}.
Do not give legal or tax advice beyond general pointers; suggest an accountant or attorney for specifics.`;

const EXPLAIN_PROMPT = `You help a landlord understand why a utility bill changed. You get JSON with the bill (name, category, place),
its monthly amounts for up to 13 months, this month's amount, the same month last year, and heating degree days (HDD) for the usage month this year vs last year when known
(more HDD = colder = more heating). The property is a small US rental. Today is {TODAY}.
Return ONLY JSON: {"headline": one short sentence with the size of the change and the most likely cause,
"reasons": [2-3 short likely causes, most likely first, each under 18 words, grounded in the data (season, weather, usage trend, rate changes, estimated vs actual reads, billing period length)],
"checks": [2-3 short practical things to check or do, under 14 words each]}.
Don't invent numbers that aren't in the data. If the change is normal for the season, say so.
If hdd_usage_month is null you do NOT know the weather: say "possibly colder", never state it was colder.
Write for a homeowner: never use the terms HDD or heating degree days; say "colder" or "milder" instead.`;

const RECAP_PROMPT = `Write a plain-English monthly recap for a small landlord. Data is JSON for one month of one rental property; the owner's own home and personal expenses, if any, are listed separately and are not rental.
Return ONLY JSON: {"title": "<Month> in a sentence" (max 10 words), "bullets": [3-5 short bullets: rent (who paid, anything late or partial), bills (total, anything unusual vs usual or last year), upkeep/repairs done and costs, what's coming up next month], "net": one short line with rental money in vs out and net}.
Use $ amounts with no cents unless under $100. Be specific with names and numbers from the data. Friendly, calm, no exclamation marks. Don't invent anything.`;

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
  if (!GROQ_KEY) return json({ error: 'The AI helper isn’t switched on for Doorstep yet.' }, 503);
  {
    // Doorstep: daily AI allowance per person; the shared demo gets a smaller one
    const lim = u.user.email === 'demo@doorstep.example' ? 25 : 80;
    const { data: allowed } = await db.rpc('bump_ai', { p_user: u.user.id, p_limit: lim });
    if (allowed === false) return json({ error: 'You’ve used today’s AI allowance (' + lim + '). It resets tomorrow.', limit: true }, 429);
  }

  const body = await req.json().catch(() => ({}));
  const today = String(body.today ?? new Date().toISOString().slice(0, 10)).slice(0, 10);
  try {
    if (body.mode === 'parse') {
      const text = String(body.text ?? '').slice(0, 500).trim();
      if (!text) return json({ error: 'Type what happened.' }, 400);
      const model = await pick(TEXT_MODEL, [/gpt-oss-120b/, /gpt-oss/, /qwen/, /llama/]);
      const out = await chat(model, [
        { role: 'system', content: PARSE_PROMPT.replace('{TODAY}', today) },
        { role: 'user', content: 'Household data:\n' + fit(body.context, 8000) + '\n\nNote: ' + text },
      ], true);
      const j = parseJson(out);
      if (!j) return json({ error: 'Couldn’t understand that. Try rephrasing.' }, 422);
      return json({ actions: Array.isArray(j.actions) ? j.actions.slice(0, 8) : [], note: j.note ?? null, model: lastModel || model });
    }
    if (body.mode === 'ask') {
      const q = String(body.question ?? '').slice(0, 600).trim();
      if (!q) return json({ error: 'Ask a question.' }, 400);
      const model = await pick(TEXT_MODEL, [/gpt-oss-120b/, /gpt-oss/, /qwen/, /llama/]);
      const history = (Array.isArray(body.history) ? body.history : []).slice(-4).map((m: { role: string; content: string }) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 800) }));
      const answer = await chat(model, [
        { role: 'system', content: ASK_PROMPT.replace('{TODAY}', today) + '\n\nHousehold data (JSON):\n' + fit(body.context, 10000) },
        ...history,
        { role: 'user', content: q },
      ], false, 700);
      return json({ answer: answer.trim(), model: lastModel || model });
    }
    if (body.mode === 'explain' || body.mode === 'recap') {
      const model = await pick(TEXT_MODEL, [/gpt-oss-120b/, /gpt-oss/, /qwen/, /llama/]);
      const prompt = (body.mode === 'explain' ? EXPLAIN_PROMPT : RECAP_PROMPT).replace('{TODAY}', today);
      const out = await chat(model, [{ role: 'system', content: prompt }, { role: 'user', content: fit(body.context, 8000) }], true, 700);
      const j = parseJson(out);
      if (!j) return json({ error: 'Couldn’t put that together. Try again.' }, 422);
      return json(Object.assign(j, { model: lastModel || model }));
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
    if ((e as Error).message === 'BUSY') return json({ error: 'The AI is busy right now (free plan limit). Try again in a minute.', busy: true }, 429);
    return json({ error: 'The assistant is unavailable right now. ' + (e as Error).message }, 502);
  }
});
