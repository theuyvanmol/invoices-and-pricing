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
{"supplier":"Supplier company name","invoiceNumber":"string","date":"YYYY-MM-DD","lines":[{"name":"product name","category":"Chilled","packSize":"1 x 2.5kg","pieces":null,"quantity":1,"unit":"pack 2.5kg","unitPrice":13.45,"lineTotal":13.45,"vatRate":0,"promo":false,"regularPrice":null,"note":""}],"sections":[{"name":"Chilled","subtotal":20.63}],"subtotalExVat":0,"invoiceTotal":0,"incomplete":false,"readable":true,"problem":""}
Rules:
- quantity × unitPrice must equal lineTotal, exactly as the invoice charges it. unitPrice is the price for ONE unit, before VAT/tax when both are shown. Never return the line total as unitPrice.
- Weighed items are ONLY lines priced per kg, where weight × price = value (e.g. meat: Qty 2, Unit 3.44kg, Price 9.50, Value 32.68 → pieces = 2, quantity = 3.44, unit = "kg", unitPrice = 9.50). A pack size such as "1 2.5kg", "4 2.5kg" or "1 1ltr" is NOT a weight to multiply: then quantity is the number of packs (QTY column), unit is the pack (e.g. "pack 2.5kg", "case 4x2.5kg") and pieces is null.
- Sold by weight with only a weight and a value (e.g. 3.952kg, £20.55, or 3kg 952g): quantity = weight in kg (convert grams: 952g = 0.952), unit = "kg", unitPrice = value ÷ weight (price per kg, e.g. 5.20), lineTotal = value.
- Boxes of countable items (e.g. Spring Onions, unit "Box (12 bunches)" or "12 x bunch", £6.50): when a known product from the same supplier is priced per bunch/each/head/punnet, express the line in that unit: quantity = boxes × items (12), unit = "bunch", unitPrice = box price ÷ items (0.5417, up to 4 decimals), lineTotal = 6.50, pieces = number of boxes.
- pieces is the number of items, packs or joints delivered. Leave it null when it is the same as quantity.
- lineTotal is the line value printed on the invoice.
- unit is short and lowercase: kg, g, l, ml, each, box, case, tray, bunch, bag, dozen. If sold by pack, include the pack, e.g. "case 6x1l".
- category: the section heading the line is printed under (e.g. "Chilled", "Frozen Food", "Catering Grocery"), in normal capitalisation. null when the invoice has no sections.
- packSize: the pack size exactly as printed (e.g. "24 x 330ml", "4 x 2.5kg"), or null.
- vatRate: the VAT % for the line when the invoice shows VAT codes and what they mean (e.g. code A = 0, code B = 20), else null.
- promo: true when the line's price is a temporary reduction (short life, condition, price override, special offer, clearance). Put the usual price in regularPrice when it is shown (e.g. a WAS price) and a short reason in note.
- Ignore RRP, POR, margin and barcode columns, and letters printed next to prices such as TC or R.
- incomplete: true when the invoice clearly continues on a page that is not included (e.g. "/CONT", "continued", "Page 1 of 2" with no final totals).
- Boxes at the top such as "SUBSTITUTION DETAILS", "items at a reduced price", "not available" or "out of stock" are NOTES, not extra lines. Never add them as lines. Use a reduced-price note only to set promo, regularPrice (the WAS price) and note on the matching line in the invoice details. Out-of-stock items are not charged unless they also appear in the invoice details.
- sections: every section heading with its printed sub-total (e.g. Booker "FROZEN FOOD ... GOODS : 176.16" → {"name":"Frozen Food","subtotal":176.16}). Empty list when there are no sections.
- Before answering, check your work: each section's lines must add up to that section's printed sub-total (e.g. GOODS: 24.16), and all lines must add up to the goods total. Re-read any line that does not.
- Skip delivery charges, deposits, discounts, tax lines and free lines priced at 0.00 (promo magazines, samples). Put the grand total printed on the invoice in invoiceTotal, and the goods total before VAT in subtotalExVat (same as invoiceTotal when there is no VAT).
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
  fixLines(data);
  const firstModel = model;
  let issue = checkTotals(data);
  if (issue) {
    // One careful second look, telling the reader exactly what does not add up.
    const retry = await callGemini([...images, { text: prompt }, { text: `Your previous answer was:\n${JSON.stringify(data)}\nProblem: ${issue}\nLook at the photo again line by line (quantity, price and value columns) and return the corrected JSON only.` }]);
    if (retry.ok) {
      try {
        const t2 = ((await retry.json()).candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('\n');
        const d2 = fixLines(JSON.parse(t2.match(/\{[\s\S]*\}/)?.[0] || t2));
        const issue2 = checkTotals(d2);
        if (!issue2 || (d2.lines || []).length >= (data.lines || []).length && scoreOff(d2) < scoreOff(data)) { data = d2; issue = issue2; }
      } catch {}
    }
  }
  data.reader = { model, backup: !/^gemini-3\.[5-9]-flash$|^gemini-flash-latest$/.test(model) || /lite/.test(model), checked: !!issue === false, issue: issue || '' };
  return json(data);
}

export const currentModel = () => model;

// The printed line value is the truth. If quantity × price does not match it, repair the line
// (e.g. a pack size like "1 x 2.5kg" wrongly read as 2.5 kg), or flag it for checking.
export function fixLines(data) {
  const n = (v) => { const x = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(x) ? x : 0; };
  const close = (a, b) => Math.abs(a - b) <= Math.max(0.02, b * 0.002);
  for (const l of data.lines || []) {
    const total = n(l.lineTotal), price = n(l.unitPrice);
    let qty = n(l.quantity), pieces = n(l.pieces);
    if (/^(g|gr|grams?)$/i.test(l.unit || '') && qty > 0) { qty = qty / 1000; l.quantity = qty; l.unit = 'kg'; }
    if (!(price > 0) && total > 0 && qty > 0) { l.unitPrice = Math.round((total / qty) * 10000) / 10000; continue; }
    if (!(total > 0) || !(price > 0)) continue;
    if (close(qty * price, total)) continue;
    const catchWeight = qty > 0 && Math.abs(qty * 10 - Math.round(qty * 10)) > 0.001; // e.g. 3.952 kg, 4.65 kg
    if ((/^kg$/i.test(l.unit || '') || /\(kg\)|per kg/i.test(l.name || '')) && catchWeight && close(price, total)) { l.unitPrice = Math.round((total / qty) * 10000) / 10000; l.unit = 'kg'; continue; }
    if (pieces > 0 && close(pieces * price, total)) { l.quantity = pieces; l.pieces = null; if (/kg|g$|ltr|ml|\bl\b/i.test(l.unit || '') && !/\s/.test(l.unit || '')) l.unit = 'each'; continue; }
    const q = Math.round((total / price) * 1000) / 1000;
    if (q > 0 && Math.abs(q - Math.round(q)) < 0.01) { l.quantity = Math.round(q); l.pieces = pieces && pieces !== Math.round(q) ? pieces : null; if (/^(kg|g|l|ml|ltr)$/i.test(l.unit || '')) l.unit = 'each'; continue; }
    if (q > 0) { l.quantity = q; continue; }
    l.mismatch = true;
  }
  // Drop a line that repeats another (e.g. a reduced-price note read as a second line).
  const seen = [];
  data.lines = (data.lines || []).filter((l) => {
    const key = String(l.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const twin = seen.find((x) => x.key === key && n(x.l.quantity) === n(l.quantity) && (close(n(x.l.unitPrice), n(l.unitPrice)) || close(n(x.l.unitPrice), n(l.regularPrice)) || close(n(l.unitPrice), n(x.l.regularPrice)) || n(x.l.regularPrice) > 0 || n(l.regularPrice) > 0));
    if (twin) { const keep = twin.l.promo && !l.promo ? twin.l : l; /* the charged line: later on the page, or the reduced one */ Object.assign(twin.l, keep, { promo: twin.l.promo || l.promo, regularPrice: n(twin.l.regularPrice) || n(l.regularPrice) || null }); return false; }
    seen.push({ key, l });
    return true;
  });
  return data;
}

const n2 = (v) => { const x = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(x) ? x : 0; };
const sumLines = (d) => Math.round((d.lines || []).reduce((a, l) => a + n2(l.quantity) * n2(l.unitPrice), 0) * 100) / 100;
function scoreOff(d) {
  const totals = [n2(d.subtotalExVat), n2(d.invoiceTotal)].filter((t) => t > 0);
  const off = totals.length ? Math.min(...totals.map((t) => Math.abs(t - sumLines(d)))) : 0;
  return off + (d.lines || []).filter((l) => l.mismatch).length * 1000;
}
// Returns a sentence describing what does not add up, or '' when everything matches.
export function checkTotals(d) {
  const bad = (d.lines || []).filter((l) => l.mismatch).map((l) => l.name);
  if (bad.length) return `quantity × unitPrice does not equal lineTotal for: ${bad.join(', ')}`;
  for (const sec of d.sections || []) {
    const want = n2(sec.subtotal), name = String(sec.name || '').toLowerCase();
    if (!(want > 0) || !name) continue;
    const got = Math.round((d.lines || []).filter((l) => String(l.category || '').toLowerCase() === name).reduce((a, l) => a + n2(l.quantity) * n2(l.unitPrice), 0) * 100) / 100;
    if (got > 0 && Math.abs(got - want) > 0.05) return `the ${sec.name} lines add up to ${got.toFixed(2)} but the printed ${sec.name} sub-total is ${want.toFixed(2)}; a line is missing, counted twice or misread`;
  }
  if (d.incomplete) return '';
  const totals = [n2(d.subtotalExVat), n2(d.invoiceTotal)].filter((t) => t > 0);
  const sum = sumLines(d);
  if (totals.length && !totals.some((t) => Math.abs(t - sum) <= 0.05)) return `the lines add up to ${sum.toFixed(2)} but the invoice total is ${totals[0].toFixed(2)}${totals[1] ? ` (or ${totals[1].toFixed(2)})` : ''}; a line is missing, duplicated or misread`;
  return '';
}
