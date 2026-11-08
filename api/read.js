// Sends invoice photos to Google Gemini and returns the supplier, date and every line item as JSON.
import { route, json, fail, sql } from './_lib.js';

// Reads invoices with Google Gemini (free tier). It never calls Anthropic, so it never uses Claude credit.
const KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
let model = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const API = 'https://generativelanguage.googleapis.com/v1beta';

async function pickModel() {
  const r = await fetch(`${API}/models?pageSize=200`, { headers: { 'x-goog-api-key': KEY } });
  if (!r.ok) return null;
  const list = ((await r.json()).models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && /flash/i.test(m.name) && !/image|tts|audio|live|embed|thinking/i.test(m.name));
  list.sort((a, b) => (/lite/i.test(a.name) - /lite/i.test(b.name)) || b.name.localeCompare(a.name, undefined, { numeric: true }));
  return list[0]?.name.replace(/^models\//, '') || null;
}

async function callGemini(parts) {
  const body = JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } });
  const go = () => fetch(`${API}/models/${model}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY }, body });
  let r = await go();
  if (r.status === 404) { const m = await pickModel(); if (m && m !== model) { model = m; r = await go(); } }
  return r;
}

export const POST = route(async (request) => {
  if (!KEY) return fail('Automatic reading is not switched on yet (no Gemini key). Enter the invoice by hand for now.', 503, { code: 'NO_AI' });
  const { photos } = await request.json().catch(() => ({}));
  const urls = (Array.isArray(photos) ? photos : []).filter((u) => /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//i.test(String(u))).slice(0, 5);
  if (!urls.length) return fail('Add a photo of the invoice first.');

  const [sup, prod] = await sql.transaction([
    sql`select name from suppliers order by name limit 100`,
    sql`select p.name, p.unit, s.name as supplier from products p join suppliers s on s.id = p.supplier_id order by s.name, p.name limit 400`,
  ]);
  const prompt = `These ${urls.length} photo(s) are the pages, in order, of ONE supplier invoice or delivery note for a restaurant.
Extract every purchased line item. Reply with ONLY a JSON object, no other text:
{"supplier":"Supplier company name","invoiceNumber":"string","date":"YYYY-MM-DD","lines":[{"name":"product name","unit":"kg","quantity":2,"unitPrice":3.4,"lineTotal":6.8}],"invoiceTotal":0,"readable":true,"problem":""}
Rules:
- unitPrice is the price for ONE unit as charged, before VAT/tax when both are shown. Never return the line total as unitPrice.
- unit is short and lowercase: kg, g, l, ml, each, box, case, tray, bunch, bag, dozen. If sold by pack, include the pack, e.g. "case 6x1l".
- Skip delivery charges, deposits, discounts and tax lines. Put the grand total printed on the invoice in invoiceTotal.
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
  const res = await callGemini([...images, { text: prompt }]);
  if (!res.ok) {
    const t = await res.text();
    console.error('Gemini error', res.status, t.slice(0, 500));
    if (res.status === 400 && /API key/i.test(t)) return fail('The Gemini key is not valid. Check GEMINI_API_KEY in the Vercel project settings.', 502);
    if (res.status === 403) return fail('The Gemini key is not allowed to use this service. Check it in Google AI Studio.', 502);
    if (res.status === 429) return fail('The free reading limit was reached for now. Wait a minute and try again, or enter it by hand.', 503);
    return fail('The invoice could not be read right now. Try again, or enter it by hand.', 502);
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
});
