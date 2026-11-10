// Save a checked invoice (updates price history and creates alerts) or delete one.
import { del } from '@vercel/blob';
import { route, json, fail, sql } from './_lib.js';
import { saveInvoice } from './_save.js';
import { convertLine, setLinePrice } from './_fix.js';

export const POST = route(async (request, ctx) => {
  const b = await request.json().catch(() => null);
  if (!b) return fail('Bad request.');
  if (b.manualPrice && ctx.role !== 'owner') return fail('Only the owner can change prices.', 403);
  return saveInvoice(b, { ...ctx, origin: new URL(request.url).origin });
});

export const DELETE = route(async (request) => {
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return fail('Missing invoice.');
  const r = await sql`select photos, lines from invoices where id = ${id}`;
  if (!r[0]) return fail('Invoice not found.', 404);
  await sql.transaction([
    sql`delete from invoices where id = ${id}`,
    sql`delete from products p where not exists (select 1 from price_points pp where pp.product_id = p.id)`,
  ]);
  // Put each affected product's unit back to the unit on its latest remaining invoice.
  for (const pid of [...new Set((r[0].lines || []).map((l) => l.productId).filter(Boolean))]) {
    const last = await sql`select lines from invoices where lines @> ${JSON.stringify([{ productId: pid }])}::jsonb order by date desc, created_at desc limit 1`;
    const unit = last[0] && (last[0].lines || []).find((l) => l.productId === pid)?.unit;
    if (unit) await sql`update products set unit = ${unit} where id = ${pid}`;
  }
  const photos = r[0].photos || [];
  if (photos.length && process.env.BLOB_READ_WRITE_TOKEN) await del(photos).catch((e) => console.error('Photo delete failed', e));
  return json({ ok: true });
}, { needs: 'owner' });

// Fix the pack size of one line, e.g. "1 box" was really 12 bunches.
export const PATCH = route(async (request) => {
  const b = await request.json().catch(() => ({}));
  if (b.action === 'price') {
    const r = await setLinePrice(String(b.invoiceId || ''), String(b.productId || ''), b.price);
    return r.ok ? json(r) : fail(r.error, 400);
  }
  const r = await convertLine(String(b.invoiceId || ''), String(b.productId || ''), b.count, b.unit);
  return r.ok ? json(r) : fail(r.error, 400);
}, { needs: 'owner' });
