// Reads invoice photos/PDFs with Google Gemini and returns the supplier, date and every line item.
import { json, fail, sql } from './_lib.js';

// Reads invoices with Google Gemini (free tier). It never calls Anthropic, so it never uses Claude credit.
export const KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
export let model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
// Tested backups, used when the main model is busy. Others found on the account are tried after these.
const BACKUPS = ['gemini-3.6-flash', 'gemini-flash-lite-latest', 'gemini-3.5-flash-lite'];
const API = 'https://generativelanguage.googleapis.com/v1beta';

// All free Flash models this key can use, best first (full Flash before Lite, newest first).
export async function listModels() {
  try {
    const r = await fetch(`${API}/models?pageSize=200`, { headers: { 'x-goog-api-key': KEY }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    const list = ((await r.json()).models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && /flash/i.test(m.name) && !/image|tts|audio|live|embed|thinking|omni|preview/i.test(m.name));
    list.sort((a, b) => (/lite/i.test(a.name) - /lite/i.test(b.name)) || b.name.localeCompare(a.name, undefined, { numeric: true }));
    return list.map((m) => m.name.replace(/^models\//, ''));
  } catch { return []; }
}

// Tries the preferred model, then other free Flash models when Google is busy (503), rate-limited (429) or the model is gone (404).
async function callGemini(parts, only) {
  const body = JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } });
  const started = Date.now();
  const tried = new Set();
  let queue = only ? [only] : [model, ...BACKUPS], listed = !!only, last = null;
  callGemini.log = [];
  while (queue.length && Date.now() - started < 48000) {
    const m = queue.shift();
    if (tried.has(m)) continue;
    tried.add(m);
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = 50000 - (Date.now() - started);
      if (left < 6000) break;
      try {
        last = await fetch(`${API}/models/${m}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY }, body, signal: AbortSignal.timeout(Math.min(20000, left - 2000)) });
      } catch (e) { callGemini.log.push(`${m}:timeout:${Math.round((Date.now() - started) / 1000)}s`); last = { ok: false, status: 504, text: async () => JSON.stringify({ error: { message: 'Timed out' } }) }; break; }
      callGemini.log.push(`${m}:${last.status}:${Math.round((Date.now() - started) / 1000)}s`);
      if (last.ok) { model = m; return last; }
      if (last.status === 503 && attempt === 0) { await new Promise((r) => setTimeout(r, 1500)); continue; }
      break;
    }
    if (![404, 429, 500, 503, 504].includes(last.status)) return last;
    if (!listed) { listed = true; queue.push(...(await listModels()).filter((x) => !tried.has(x)).slice(0, 4)); }
  }
  return last;
}

export async function readInvoice(photos, testModel) {
  if (!KEY) return fail('Automatic reading is not switched on yet (no Gemini key). Enter the invoice by hand for now.', 503, { code: 'NO_AI' });
  const urls = (Array.isArray(photos) ? photos : []).filter((u) => /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//i.test(String(u))).slice(0, 5);
  if (!urls.length) return fail('Add a photo of the invoice first.');

  const [sup, prod] = await sql.transaction([
    sql`select name from suppliers order by name limit 100`,
    sql`select p.name, p.unit, s.name as supplier from products p join suppliers s on s.id = p.supplier_id order by s.name, p.name limit 700`,
  ]);
  const prompt = `These ${urls.length} photo(s) are the pages, in order, of ONE supplier invoice or delivery note for a restaurant.
Extract every purchased line item. Reply with ONLY a JSON object, no other text:
{"supplier":"Supplier company name","invoiceNumber":"string","date":"YYYY-MM-DD","lines":[{"name":"product name","pieces":2,"quantity":3.44,"unit":"kg","unitPrice":9.5,"lineTotal":32.68}],"subtotalExVat":0,"invoiceTotal":0,"readable":true,"problem":""}
Rules:
- quantity × unitPrice must equal lineTotal, exactly as the invoice charges it. unitPrice is the price for ONE unit, before VAT/tax when both are shown. Never return the line total as unitPrice.
- Weighed items (meat, fish, cheese): when the invoice shows a count AND a weight (e.g. Qty 2, Unit 3.44kg, Price 9.50, Value 32.68), set pieces = 2, quantity = 3.44, unit = "kg", unitPrice = 9.50 (per kg), lineTotal = 32.68.
- pieces is the number of items, packs or joints delivered. Leave it null when it is the same as quantity.
- lineTotal is the line value printed on the invoice.
- unit is short and lowercase: kg, g, l, ml, each, box, case, tray, bunch, bag, dozen. If sold by pack, include the pack, e.g. "case 6x1l".
- Skip delivery charges, deposits, discounts and tax lines. Put the grand total printed on the invoice in invoiceTotal, and the goods total before VAT in subtotalExVat (same as invoiceTotal when there is no VAT).
- Use plain product names without product codes. If a line clearly matches a known product below from the same supplier, reuse that exact name and unit so the price history stays linked.
- Dates on invoices may be day/month/year. Return ISO YYYY-MM-DD.
- If the photos are not an invoice or cannot be read, set readable to false and explain briefly in problem.
- Numbers must be plain numbers without currency symbols.
Known suppliers: ${sup.map((s) => s.name).join('; ') || 'none yet'}
Known products (name (unit) — supplier):
${prod.map((p) => `${p.name} (${p.unit}) — ${p.supplier}`).join('\n') || 'none yet'}`;

  const images = [];
  for (const u of urls) {
    const r = await fetch(u);
    if (!r.ok) return fail('A photo could not be loaded. Take it again.', 422);
    images.push({ inline_data: { mime_type: r.headers.get('content-type') || 'image/jpeg', data: Buffer.from(await r.arrayBuffer()).toString('base64') } });
  }
  const res = await callGemini([...images, { text: prompt }], /^[a-z0-9.-]{3,60}$/.test(testModel || '') ? testModel : null);
  if (!res.ok) {
    const t = await res.text();
    console.error('Gemini error', res.status, t.slice(0, 500));
    if (res.status === 400 && /API key/i.test(t)) return fail('The Gemini key is not valid. Check GEMINI_API_KEY in the Vercel project settings.', 502);
    if (res.status === 403) return fail('The Gemini key is not allowed to use this service. Check it in Google AI Studio.', 502);
    if (res.status === 429) return fail('The free reading limit was reached for now. Wait a minute and try again, or enter it by hand.', 503);
    let why = '';
    try { why = JSON.parse(t).error?.message || ''; } catch {}
    return fail('The invoice could not be read right now. Try again, or enter it by hand.', 502, { detail: `Gemini ${res.status}: ${why.slice(0, 200)} | tried ${(callGemini.log || []).join(', ')}` });
  }
  const out = await res.json();
  const text = (out.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('\n');
  let data = null;
  try { data = JSON.parse(text); } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) try { data = JSON.parse(m[0]); } catch {}
  }
  if (!data) return fail('The invoice could not be read clearly. Retake the photo flat and in good light, or enter it by hand.', 422);
  return json(data);
}

export const currentModel = () => model;
