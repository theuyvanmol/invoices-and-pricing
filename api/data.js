// Everything the app shows: suppliers, products with full price history, invoices, alerts.
import { route, json, sql, publicSettings } from './_lib.js';

const n = (v) => (v == null ? null : Number(v));
const d = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));

export const GET = route(async (request, { role, settings }) => {
  const [sup, prod, pts, inv, al] = await sql.transaction([
    sql`select id, name from suppliers order by name`,
    sql`select id, supplier_id, name, unit from products`,
    sql`select product_id, invoice_id, date, price, qty, extract(epoch from created_at)*1000 as t from price_points order by date, created_at`,
    sql`select id, supplier_id, number, date, lines, total, printed_total, photos, source, source_file, extract(epoch from created_at)*1000 as t from invoices order by date desc, created_at desc limit 3000`,
    sql`select * from alerts order by date desc, created_at desc limit 2000`,
  ]);
  const hist = {};
  for (const p of pts) (hist[p.product_id] ||= []).push({ d: d(p.date), p: n(p.price), q: n(p.qty), inv: p.invoice_id, t: n(p.t) });
  return json({
    role,
    settings: publicSettings(settings),
    suppliers: sup,
    products: prod.map((p) => ({ id: p.id, supplierId: p.supplier_id, name: p.name, unit: p.unit, history: hist[p.id] || [] })),
    invoices: inv.map((i) => ({ id: i.id, supplierId: i.supplier_id, number: i.number, date: d(i.date), lines: i.lines, total: n(i.total), printedTotal: n(i.printed_total), photos: i.photos || [], sourceFile: i.source_file || null, source: i.source, createdAt: n(i.t) })),
    alerts: al.map((a) => ({ id: a.id, productId: a.product_id, supplierId: a.supplier_id, invoiceId: a.invoice_id, productName: a.product_name, unit: a.unit, from: n(a.from_price), to: n(a.to_price), diff: n(a.diff), pct: n(a.pct), qty: n(a.qty), invoiceNumber: a.invoice_number, date: d(a.date), status: a.status, note: a.note || '' })),
  });
});
