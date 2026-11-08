// Corrects a saved invoice line that was bought as a pack (e.g. 1 box) but should be counted
// in the usual unit (e.g. 12 bunch). Updates the invoice, the price history and the product,
// and removes the price alert that the wrong unit caused.
import { sql, norm } from './_lib.js';

const round4 = (n) => Math.round(Number(n) * 10000) / 10000;

export async function convertLine(invoiceId, productId, count, unit) {
  count = Number(count);
  unit = String(unit || '').trim().slice(0, 30);
  if (!(count > 0) || !unit) return { ok: false, error: 'Enter how many and the unit.' };
  const inv = (await sql`select id, lines from invoices where id = ${invoiceId}`)[0];
  if (!inv) return { ok: false, error: 'Invoice not found.' };
  let changed = null;
  const lines = (inv.lines || []).map((l) => {
    if (l.productId !== productId || changed) return l;
    const packs = Number(l.qty) || 1;
    const qty = Math.round(packs * count * 1000) / 1000;
    const price = round4((Number(l.qty) * Number(l.price)) / qty);
    changed = { qty, price };
    return { ...l, pieces: l.pieces || packs, qty, price, unit, total: l.total ?? Math.round(Number(l.qty) * Number(l.price) * 100) / 100, note: [l.note, `${packs} × ${l.unit} = ${qty} ${unit}`].filter(Boolean).join(' · ') };
  });
  if (!changed) return { ok: false, error: 'That product is not on this invoice.' };
  await sql.transaction([
    sql`update invoices set lines = ${JSON.stringify(lines)}::jsonb where id = ${invoiceId}`,
    sql`update price_points set qty = ${changed.qty}, price = ${changed.price} where invoice_id = ${invoiceId} and product_id = ${productId}`,
    sql`delete from alerts where invoice_id = ${invoiceId} and product_id = ${productId}`,
    sql`update products set unit = ${unit} where id = ${productId}`,
  ]);
  return { ok: true, ...changed, unit };
}

// One-off repairs for data saved before the pack-size fix. Each runs once.
const REPAIRS = [
  { key: 'spring-onions-F60870059', invoiceNumber: 'F60870059', product: 'spring onions', fromUnit: 'box', count: 12, unit: 'bunch' },
];
export async function runRepairs(settings, saveSettings) {
  const done = new Set(settings.repairsDone || []);
  let ran = false;
  for (const r of REPAIRS) {
    if (done.has(r.key)) continue;
    try {
      const rows = await sql`select i.id as invoice_id, p.id as product_id, p.name, l->>'unit' as unit
        from invoices i cross join lateral jsonb_array_elements(i.lines) l join products p on p.id = l->>'productId'
        where i.number = ${r.invoiceNumber}`;
      const hit = rows.find((x) => norm(x.name) === r.product && norm(x.unit) === r.fromUnit);
      if (hit) await convertLine(hit.invoice_id, hit.product_id, r.count, r.unit);
      if (hit || rows.length) { done.add(r.key); ran = true; }
    } catch (e) { console.error('repair failed', r.key, e); }
  }
  if (ran) await saveSettings({ ...settings, repairsDone: [...done] });
}
