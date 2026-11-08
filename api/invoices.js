// Save a checked invoice (updates price history and creates alerts) or delete one.
import { del } from '@vercel/blob';
import { route, json, fail, sql } from './_lib.js';
import { saveInvoice } from './_save.js';

export const POST = route(async (request, ctx) => {
  const b = await request.json().catch(() => null);
  if (!b) return fail('Bad request.');
  return saveInvoice(b, { ...ctx, origin: new URL(request.url).origin });
});

export const DELETE = route(async (request) => {
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return fail('Missing invoice.');
  const r = await sql`select photos from invoices where id = ${id}`;
  if (!r[0]) return fail('Invoice not found.', 404);
  await sql.transaction([
    sql`delete from invoices where id = ${id}`,
    sql`delete from products p where not exists (select 1 from price_points pp where pp.product_id = p.id)`,
  ]);
  const photos = r[0].photos || [];
  if (photos.length && process.env.BLOB_READ_WRITE_TOKEN) await del(photos).catch((e) => console.error('Photo delete failed', e));
  return json({ ok: true });
}, { needs: 'owner' });
