// Shared invoice saving, used by the invoices route and the Google Drive sync.
import { json, fail, sql, newId, norm, round2 } from './_lib.js';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const round4 = (n) => Math.round(Number(n) * 10000) / 10000;
const COUNT = /^(each|single|sgl|piece|pc|pcs|item|unit|ea)$/;
const sing = (w) => { const x = String(w || '').toLowerCase().trim(); return COUNT.test(x) ? 'each' : x.replace(/(es|s)$/, ''); };

// When a product we usually buy per bunch/each/head arrives as a box of N of them,
// express it in the usual unit so prices stay comparable. Returns true when converted.
export function toBaseUnit(oldUnit, l) {
  const base = sing(norm(oldUnit));
  if (!base || /\d/.test(base) || base.length < 2) return false;
  const text = [l.unit, l.packSize, l.note].filter(Boolean).join(' ').toLowerCase();
  let count = 0;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(?:x\s*)?([a-z]+)/g)) if (sing(m[2]) === base) { count = Number(m[1]); break; }
  // "Box (30)" or "box of 30": a bare count means items, when we usually buy single items
  if (!count && base === 'each') { const m = text.match(/\((\d+)\)|\bof\s+(\d+)\b|\b(\d+)\s*(?:x|per)\s*(?:box|case|pack|tray)?\b/); if (m) count = Number(m[1] || m[2] || m[3]); }
  if (!(count > 1)) return false;
  const packs = l.qty || 1;
  l.pieces = l.pieces || packs;
  l.qty = Math.round(packs * count * 1000) / 1000;
  l.price = round4(l.price / count);
  l.note = [l.note, `${packs} × ${l.unit} = ${l.qty} ${oldUnit}`].filter(Boolean).join(' · ');
  l.unit = oldUnit;
  return true;
}


// Saves one checked invoice: suppliers, products, price history and alerts. Returns a Response.
export async function saveInvoice(b, { role, settings, origin }) {
  const date = String(b.date || '');
  if (!ISO.test(date)) return fail('Add the invoice date.');
  const lines = (Array.isArray(b.lines) ? b.lines : [])
    .map((l) => ({ name: String(l.name || '').trim().slice(0, 120), unit: String(l.unit || 'each').trim().slice(0, 30) || 'each', pieces: Number(l.pieces) > 0 ? Number(l.pieces) : null, qty: Number(l.qty) || 0, price: round4(Number(l.price) || 0),
      category: l.category ? String(l.category).trim().slice(0, 60) : null, packSize: l.packSize ? String(l.packSize).trim().slice(0, 40) : null,
      vat: [0, 5, 20].includes(Number(l.vat)) && l.vat !== null && l.vat !== '' ? Number(l.vat) : null, promo: !!l.promo, regularPrice: Number(l.regularPrice) > 0 ? round2(Number(l.regularPrice)) : null, note: l.note ? String(l.note).slice(0, 120) : null }))
    .filter((l) => l.name);
  if (!lines.length) return fail('Add at least one product line.');
  if (lines.some((l) => !(l.price > 0))) return fail('Every line needs a price above zero.');
  const photos = (Array.isArray(b.photos) ? b.photos : []).filter((u) => /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//i.test(String(u))).slice(0, 5);
  const number = String(b.number || '').trim().slice(0, 60);

  // Supplier: existing id, or match by name, or create.
  let supplierId = null, supplierName = '';
  const queries = [];
  if (b.supplierId && b.supplierId !== 'new') {
    const r = await sql`select id, name from suppliers where id = ${b.supplierId}`;
    if (r[0]) { supplierId = r[0].id; supplierName = r[0].name; }
  }
  if (!supplierId) {
    supplierName = String(b.newSupplier || '').trim().slice(0, 120);
    if (!supplierName) return fail('Add the supplier name.');
    const all = await sql`select id, name from suppliers`;
    const hit = all.find((s) => norm(s.name) === norm(supplierName));
    if (hit) { supplierId = hit.id; supplierName = hit.name; }
    else { supplierId = newId('s'); queries.push(sql`insert into suppliers (id, name) values (${supplierId}, ${supplierName})`); }
  }

  if (number && !b.allowDuplicate) {
    const dup = await sql`select id, number from invoices where supplier_id = ${supplierId}`;
    if (dup.some((x) => norm(x.number) === norm(number))) return fail(`Invoice ${number} from ${supplierName} is already saved.`, 409, { code: 'DUP' });
  }

  const existing = await sql`select id, name, unit, norm from products where supplier_id = ${supplierId}`;
  const lastPrices = existing.length
    ? await sql`select distinct on (product_id) product_id, price, date from price_points where product_id = any(${existing.map((p) => p.id)}) and date <= ${date} and not coalesce(promo, false) order by product_id, date desc, created_at desc`
    : [];
  const priorOf = Object.fromEntries(lastPrices.map((r) => [r.product_id, { price: Number(r.price), date: r.date }]));
  const byNorm = Object.fromEntries(existing.map((p) => [p.norm, p]));

  const invoiceId = newId('i');
  const threshold = Number(settings.threshold || 0);
  const invLines = [], alerts = [], pointQueries = [];
  let news = 0;
  for (const l of lines) {
    const key = norm(l.name);
    let p = byNorm[key];
    if (!p) {
      p = { id: newId('p'), name: l.name, unit: l.unit, norm: key, isNew: true };
      byNorm[key] = p; news++;
      queries.push(sql`insert into products (id, supplier_id, name, unit, norm) values (${p.id}, ${supplierId}, ${l.name}, ${l.unit}, ${key})`);
    } else if (!p.isNew && p.unit !== l.unit && toBaseUnit(p.unit, l)) {
      // converted, e.g. 1 box of 12 bunches at £6.50 -> 12 bunch at £0.5417
    } else if (!p.isNew && p.unit !== l.unit) {
      queries.push(sql`update products set unit = ${l.unit} where id = ${p.id}`);
    }
    const prior = p.isNew ? null : priorOf[p.id];
    if (prior && prior.price > 0 && !b.historic && !l.promo) {
      const diff = round2(l.price - prior.price), pct = (diff / prior.price) * 100;
      // A different unit or pack size (e.g. bunch -> box of 12) is not a price rise, so no alert.
      const sameUnit = p.isNew || norm(p.unit) === norm(l.unit);
      if (sameUnit && diff > 0.004 && pct >= threshold) alerts.push({ id: newId('a'), productId: p.id, productName: p.name, unit: l.unit, from: prior.price, to: l.price, diff, pct: round2(pct), qty: l.qty });
    }
    invLines.push({ productId: p.id, name: p.name, unit: l.unit, pieces: l.pieces, qty: l.qty, price: l.price, total: round2(l.qty * l.price), category: l.category, packSize: l.packSize, vat: l.vat, promo: l.promo, regularPrice: l.regularPrice, note: l.note });
    pointQueries.push(sql`insert into price_points (product_id, invoice_id, date, price, qty, promo) values (${p.id}, ${invoiceId}, ${date}, ${l.price}, ${l.qty}, ${l.promo})`);
  }
  const total = round2(invLines.reduce((a, l) => a + l.qty * l.price, 0));
  queries.push(sql`insert into invoices (id, supplier_id, number, date, lines, total, printed_total, photos, source, created_by, source_file) values (${invoiceId}, ${supplierId}, ${number}, ${date}, ${JSON.stringify(invLines)}::jsonb, ${total}, ${Number(b.printedTotal) || null}, ${JSON.stringify(photos)}::jsonb, ${['ai','pricelist'].includes(b.source) ? b.source : 'manual'}, ${role}, ${b.sourceFile ? String(b.sourceFile).slice(0, 300) : null})`);
  queries.push(...pointQueries);
  for (const a of alerts) queries.push(sql`insert into alerts (id, product_id, supplier_id, invoice_id, product_name, unit, from_price, to_price, diff, pct, qty, invoice_number, date) values (${a.id}, ${a.productId}, ${supplierId}, ${invoiceId}, ${a.productName}, ${a.unit}, ${a.from}, ${a.to}, ${a.diff}, ${a.pct}, ${a.qty}, ${number}, ${date})`);
  await sql.transaction(queries);

  let emailed = false;
  if (!b.historic && alerts.length && settings.alertEmail && process.env.RESEND_API_KEY) emailed = await sendAlertEmail(settings, supplierName, number, date, alerts, origin);

  if (b.driveFileId) await sql`update drive_files set status = 'saved', invoice_id = ${invoiceId}, message = ${supplierName + ' · ' + date}, updated_at = now() where file_id = ${String(b.driveFileId)}`;
  return json({ ok: true, id: invoiceId, supplier: supplierName, number, total, lines: invLines.length, ups: alerts.length, news, emailed });
}

async function sendAlertEmail(settings, supplier, number, date, alerts, origin) {
  const cur = settings.currency || '£';
  const m = (v) => cur + Number(v).toFixed(2);
  const rows = alerts.map((a) => `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee"><b>${esc(a.productName)}</b></td><td style="padding:6px 10px;border-bottom:1px solid #eee">${m(a.from)} → <b>${m(a.to)}</b> /${esc(a.unit)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;color:#c23f2a"><b>+${a.pct.toFixed(1)}%</b></td></tr>`).join('');
  const html = `<div style="font-family:system-ui,sans-serif;color:#18201d"><h2 style="margin:0 0 6px">${alerts.length} price increase${alerts.length > 1 ? 's' : ''} from ${esc(supplier)}</h2><p style="margin:0 0 14px;color:#555">Invoice ${esc(number || '(no number)')} · ${esc(date)}${settings.restaurant ? ' · ' + esc(settings.restaurant) : ''}</p><table style="border-collapse:collapse;font-size:14px">${rows}</table><p style="margin-top:18px"><a href="${origin}/#alerts" style="background:#1d5c7a;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Review in Invoices &amp; Pricing</a></p></div>`;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({ from: process.env.ALERT_FROM || 'Invoices & Pricing <onboarding@resend.dev>', to: settings.alertEmail.split(/[,;\s]+/).filter(Boolean), subject: `Price increase: ${alerts.map((a) => a.productName).slice(0, 3).join(', ')} (${supplier})`, html }),
    });
    if (!r.ok) console.error('Email failed', r.status, (await r.text()).slice(0, 300));
    return r.ok;
  } catch (e) { console.error('Email failed', e); return false; }
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

