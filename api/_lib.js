// Shared helpers for all API routes: database, sessions, JSON responses.
import { neon } from '@neondatabase/serverless';
import crypto from 'node:crypto';

const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL_UNPOOLED || '';
export const sql = DB_URL ? neon(DB_URL) : null;

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
export const fail = (message, status = 400, extra = {}) => json({ error: message, ...extra }, status);

export const newId = (p) => p + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
export const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9฀-๿]+/g, ' ').trim();
export const round2 = (n) => Math.round(Number(n) * 100) / 100;

let schemaReady = false;
export async function ensureSchema() {
  if (!sql) throw Object.assign(new Error('No database connected'), { code: 'NO_DB' });
  if (schemaReady) return;
  await sql.transaction([
    sql`create table if not exists settings (id int primary key, data jsonb not null)`,
    sql`create table if not exists suppliers (id text primary key, name text not null, created_at timestamptz default now())`,
    sql`create table if not exists products (id text primary key, supplier_id text not null references suppliers(id) on delete cascade, name text not null, unit text not null, norm text not null, created_at timestamptz default now())`,
    sql`create index if not exists products_supplier_norm on products(supplier_id, norm)`,
    sql`create table if not exists invoices (id text primary key, supplier_id text not null references suppliers(id) on delete cascade, number text, date date not null, lines jsonb not null, total numeric not null, printed_total numeric, photos jsonb not null default '[]', source text, created_by text, created_at timestamptz default now())`,
    sql`create table if not exists price_points (id bigserial primary key, product_id text not null references products(id) on delete cascade, invoice_id text not null references invoices(id) on delete cascade, date date not null, price numeric not null, qty numeric, created_at timestamptz default now())`,
    sql`create index if not exists price_points_product on price_points(product_id, date)`,
    sql`create table if not exists alerts (id text primary key, product_id text not null references products(id) on delete cascade, supplier_id text not null, invoice_id text references invoices(id) on delete cascade, product_name text, unit text, from_price numeric, to_price numeric, diff numeric, pct numeric, qty numeric, invoice_number text, date date, status text not null default 'open', note text, created_at timestamptz default now(), reviewed_at timestamptz)`,
  ]);
  await sql`alter table invoices add column if not exists source_file text`;
  await sql`create table if not exists drive_files (file_id text primary key, name text, mime text, created_time timestamptz, status text not null, message text, draft jsonb, photo text, invoice_id text, historic boolean default false, updated_at timestamptz default now())`;
  schemaReady = true;
}

export const RESTAURANT = 'Geisha Restaurant';
// Settings are created automatically. PIN sign-in stays off until the owner turns it on in Settings.
export async function getSettings() {
  await ensureSchema();
  const rows = await sql`select data from settings where id = 1`;
  if (rows[0]?.data) return rows[0].data;
  const data = { restaurant: RESTAURANT, currency: '£', threshold: 0, alertEmail: '', pinsEnabled: false, secret: crypto.randomBytes(32).toString('hex') };
  await saveSettings(data);
  return data;
}
export async function saveSettings(data) {
  await sql`insert into settings (id, data) values (1, ${JSON.stringify(data)}::jsonb) on conflict (id) do update set data = excluded.data`;
}

// PINs are stored as scrypt hashes, never in plain text.
export function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(String(pin), salt, 32).toString('hex');
}
export function checkPin(pin, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(pin), salt, 32);
  const real = Buffer.from(hash, 'hex');
  return real.length === test.length && crypto.timingSafeEqual(real, test);
}

const COOKIE = 'ip_session';
export function makeSession(role, secret) {
  const exp = Date.now() + 1000 * 60 * 60 * 24 * 90; // 90 days
  const body = `${role}.${exp}`;
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return `${COOKIE}=${body}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 90}`;
}
export const clearSession = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export async function getRole(request, settings) {
  settings = settings || (await getSettings());
  if (!settings?.pinsEnabled) return 'owner';
  if (!settings?.secret) return null;
  const raw = (request.headers.get('cookie') || '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  if (!raw) return null;
  const [role, exp, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!role || !exp || !sig) return null;
  const good = crypto.createHmac('sha256', settings.secret).update(`${role}.${exp}`).digest('hex');
  if (good.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
  if (Number(exp) < Date.now()) return null;
  if (role !== 'owner' && role !== 'manager') return null;
  // A changed PIN rotates the secret, which signs everyone out.
  return role;
}

// Wraps a route: database check, login check, error handling.
export function route(handler, { needs = 'any' } = {}) {
  return async (request) => {
    try {
      const settings = await getSettings();
      if (needs !== 'none') {
        if (!settings) return fail('Setup is not finished.', 409, { code: 'SETUP' });
        const role = await getRole(request, settings);
        if (!role) return fail('Please sign in.', 401, { code: 'AUTH' });
        if (needs === 'owner' && role !== 'owner') return fail('Only the owner can do this.', 403);
        return await handler(request, { role, settings });
      }
      return await handler(request, { role: null, settings });
    } catch (e) {
      if (e.code === 'NO_DB') return fail('The database is not connected yet. Add a Neon Postgres database to this Vercel project.', 503, { code: 'NO_DB' });
      console.error(e);
      return fail('Something went wrong on the server. Try again.', 500);
    }
  };
}

export function publicSettings(s) {
  if (!s) return null;
  return { restaurant: s.restaurant || RESTAURANT, currency: '£', threshold: Number(s.threshold || 0), alertEmail: s.alertEmail || '', pinsEnabled: !!s.pinsEnabled };
}
