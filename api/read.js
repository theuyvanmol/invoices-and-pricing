// Sends invoice photos to Claude and returns the supplier, date and every line item as JSON.
import { route, json, fail, sql } from './_lib.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

export const POST = route(async (request) => {
  if (!process.env.ANTHROPIC_API_KEY) return fail('Automatic reading is not switched on yet (no Anthropic API key). Enter the invoice by hand for now.', 503, { code: 'NO_AI' });
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

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      messages: [{ role: 'user', content: [...urls.map((url) => ({ type: 'image', source: { type: 'url', url } })), { type: 'text', text: prompt }] }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    console.error('Anthropic error', res.status, t.slice(0, 500));
    if (res.status === 401) return fail('The Anthropic API key is not valid. Check it in the Vercel project settings.', 502);
    if (res.status === 429 || res.status === 529) return fail('The reading service is busy. Wait a minute and try again.', 503);
    return fail('The invoice could not be read right now. Try again, or enter it by hand.', 502);
  }
  const out = await res.json();
  const text = (out.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  let data = null;
  try { data = JSON.parse(text); } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) try { data = JSON.parse(m[0]); } catch {}
  }
  if (!data) return fail('The invoice could not be read clearly. Retake the photo flat and in good light, or enter it by hand.', 422);
  return json(data);
});
