// Watches a shared Google Drive folder: every new photo or PDF is read with Gemini and saved as an invoice.
// Invoices that do not add up wait in the app under "Needs checking".
import { put } from '@vercel/blob';
import { route, json, fail, sql, getSettings, saveSettings, norm, round2, ensureSchema } from './_lib.js';
import { readInvoice } from './_reader.js';
import { saveInvoice } from './_save.js';

const KEY = process.env.GOOGLE_DRIVE_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const OK_TYPES = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/i;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf' };

export const folderIdFrom = (link) => {
  const s = String(link || '').trim();
  const m = s.match(/folders\/([A-Za-z0-9_-]{10,})/) || s.match(/[?&]id=([A-Za-z0-9_-]{10,})/) || s.match(/^([A-Za-z0-9_-]{20,})$/);
  return m ? m[1] : null;
};

async function driveError(r) {
  const t = await r.text();
  let msg = '';
  try { msg = JSON.parse(t).error?.message || ''; } catch {}
  if (/has not been used|is disabled|SERVICE_DISABLED|API_KEY_SERVICE_BLOCKED|blocked/i.test(t)) return { code: 'DRIVE_API_OFF', message: 'Google Drive is not switched on for your Google key yet. Turn on the "Google Drive API" for the same Google project (see the steps in the app).' };
  if (/API keys are not supported/i.test(t)) return { code: 'NEED_DRIVE_KEY', message: 'Your Gemini key cannot open Google Drive. Create a separate Google Drive key and add it in Vercel as GOOGLE_DRIVE_API_KEY (see the steps).' };
  if (r.status === 404) return { code: 'NO_ACCESS', message: 'The folder could not be opened. In Google Drive, set the folder to "Anyone with the link – Viewer".' };
  return { code: 'DRIVE_ERROR', message: `Google Drive said: ${msg || r.status}` };
}

// Lists every photo/PDF in the folder (and its subfolders, 3 levels deep).
async function listFiles(folderId) {
  const out = [];
  const walk = async (id, depth) => {
    let pageToken = '';
    do {
      const q = encodeURIComponent(`'${id}' in parents and trashed = false`);
      const url = `${DRIVE}?q=${q}&fields=nextPageToken,files(id,name,mimeType,size,createdTime)&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&key=${KEY}${pageToken ? `&pageToken=${pageToken}` : ''}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw Object.assign(new Error('drive'), await driveError(r));
      const j = await r.json();
      for (const f of j.files || []) {
        if (f.mimeType === 'application/vnd.google-apps.folder') { if (depth < 3) await walk(f.id, depth + 1); }
        else if (OK_TYPES.test(f.mimeType)) out.push(f);
      }
      pageToken = j.nextPageToken || '';
    } while (pageToken);
  };
  await walk(folderId, 0);
  return out;
}

function matchSupplierId(name, sups) {
  const n = norm(name);
  if (!n) return null;
  const hit = sups.find((s) => norm(s.name) === n) || sups.find((s) => { const m = norm(s.name); return m.length > 3 && (n.includes(m) || m.includes(n)); });
  return hit ? hit.id : null;
}

function toDraft(r, sups) {
  const sid = matchSupplierId(r.supplier, sups);
  const num = (v) => { const x = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(x) ? x : 0; };
  return {
    supplierId: sid || 'new', newSupplier: sid ? '' : String(r.supplier || ''), number: String(r.invoiceNumber || ''),
    date: /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') ? r.date : '', printedTotal: num(r.invoiceTotal), subtotal: num(r.subtotalExVat),
    lines: (r.lines || []).map((l) => ({ name: String(l.name || '').trim(), unit: String(l.unit || 'each').trim(), pieces: num(l.pieces) || null, qty: num(l.quantity), price: round2(num(l.unitPrice) || (num(l.lineTotal) && num(l.quantity) ? num(l.lineTotal) / num(l.quantity) : 0)) })).filter((l) => l.name),
  };
}

function problem(r, d) {
  const today = new Date().toISOString().slice(0, 10);
  if (r.readable === false) return 'Could not read: ' + (r.problem || 'unclear photo');
  if (!d.lines.length) return 'No product lines found';
  if (d.supplierId === 'new' && !d.newSupplier) return 'Supplier name not found';
  if (!d.date) return 'Invoice date not found';
  if (d.date > today) return 'Date is in the future: ' + d.date;
  if (d.lines.some((l) => !(l.price > 0) || !(l.qty > 0))) return 'A line is missing a quantity or price';
  const sum = round2(d.lines.reduce((a, l) => a + l.qty * l.price, 0));
  const totals = [d.subtotal, d.printedTotal].filter((t) => t > 0);
  if (totals.length && !totals.some((t) => Math.abs(t - sum) <= 0.05)) return `Lines add up to £${sum.toFixed(2)} but the invoice says £${totals[totals.length - 1].toFixed(2)}`;
  return '';
}

// Processes new files until the time budget runs out. Safe to run from several devices at once.
async function sync(settings, origin, budgetMs = 45000) {
  const started = Date.now();
  const files = await listFiles(settings.driveFolderId);
  const known = new Set((await sql`select file_id from drive_files where status <> 'processing' or updated_at > now() - interval '3 minutes'`).map((r) => r.file_id));
  const fresh = files.filter((f) => !known.has(f.id)).sort((a, b) => String(a.createdTime).localeCompare(String(b.createdTime)));
  const since = settings.driveSince || '9999';
  const done = [];
  let limited = false;
  for (const f of fresh) {
    if (Date.now() - started > budgetMs - 15000) break;
    const claim = await sql`insert into drive_files (file_id, name, mime, created_time, status, historic) values (${f.id}, ${f.name}, ${f.mimeType}, ${f.createdTime}, 'processing', ${String(f.createdTime) < since})
      on conflict (file_id) do update set status = 'processing', updated_at = now() where drive_files.status = 'processing' and drive_files.updated_at < now() - interval '3 minutes' returning file_id, historic`;
    if (!claim[0]) continue;
    const historic = claim[0].historic;
    const setRow = (status, message, extra = {}) => sql`update drive_files set status = ${status}, message = ${message}, draft = ${extra.draft ? JSON.stringify(extra.draft) : null}::jsonb, photo = coalesce(${extra.photo || null}, photo), invoice_id = ${extra.invoiceId || null}, updated_at = now() where file_id = ${f.id}`;
    try {
      if (Number(f.size) > 15 * 1024 * 1024) { await setRow('failed', 'File is over 15 MB'); done.push({ name: f.name, status: 'failed' }); continue; }
      const dl = await fetch(`${DRIVE}/${f.id}?alt=media&supportsAllDrives=true&key=${KEY}`, { signal: AbortSignal.timeout(20000) });
      if (!dl.ok) { const e = await driveError(dl); await setRow('failed', e.message); done.push({ name: f.name, status: 'failed' }); continue; }
      const buf = Buffer.from(await dl.arrayBuffer());
      const type = f.mimeType.toLowerCase();
      const d0 = new Date();
      const blob = await put(`invoices/${d0.getFullYear()}/${String(d0.getMonth() + 1).padStart(2, '0')}/drive.${EXT[type] || 'jpg'}`, buf, { access: 'public', contentType: type, addRandomSuffix: true });
      const res = await readInvoice([blob.url]);
      const r = await res.json();
      if (!res.ok) {
        if (res.status === 503 || /limit|busy/i.test(r.error || '')) { await sql`delete from drive_files where file_id = ${f.id}`; limited = true; break; }
        await setRow('failed', r.error || 'Could not be read', { photo: blob.url }); done.push({ name: f.name, status: 'failed' }); continue;
      }
      const sups = await sql`select id, name from suppliers`;
      const draft = toDraft(r, sups);
      const why = problem(r, draft);
      if (why) { await setRow('check', why, { draft, photo: blob.url }); done.push({ name: f.name, status: 'check' }); continue; }
      const saved = await saveInvoice({ ...draft, photos: [blob.url], source: 'ai', historic, sourceFile: `drive:${f.id}` }, { role: 'owner', settings, origin });
      const sj = await saved.json();
      if (saved.ok) { await setRow('saved', `${sj.supplier} · ${draft.date} · £${Number(sj.total).toFixed(2)}${sj.ups ? ` · ${sj.ups} price rise${sj.ups > 1 ? 's' : ''}` : ''}`, { invoiceId: sj.id, photo: blob.url }); done.push({ name: f.name, status: 'saved' }); }
      else if (sj.code === 'DUP') { await setRow('duplicate', sj.error, { photo: blob.url }); done.push({ name: f.name, status: 'duplicate' }); }
      else { await setRow('check', sj.error || 'Could not be saved', { draft, photo: blob.url }); done.push({ name: f.name, status: 'check' }); }
    } catch (e) {
      console.error('drive file failed', f.id, e);
      await sql`delete from drive_files where file_id = ${f.id}`;
      break;
    }
  }
  const remaining = Math.max(0, fresh.length - done.length);
  await saveSettings({ ...(await getSettings()), driveLastSync: new Date().toISOString() });
  return { processed: done, remaining, limited, total: files.length };
}

async function status(settings) {
  const counts = Object.fromEntries((await sql`select status, count(*)::int as n from drive_files group by status`).map((r) => [r.status, r.n]));
  const check = await sql`select file_id, name, status, message, draft, photo, historic, created_time from drive_files where status in ('check','failed') order by created_time limit 300`;
  const recent = await sql`select file_id, name, status, message, updated_at from drive_files where status in ('saved','duplicate') order by updated_at desc limit 20`;
  return { connected: !!settings.driveFolderId, folderId: settings.driveFolderId || null, since: settings.driveSince || null, lastSync: settings.driveLastSync || null, keyOk: !!KEY, counts, check, recent };
}

const isCron = (request) => /vercel-cron/i.test(request.headers.get('user-agent') || '') || (process.env.CRON_SECRET && request.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`);

export async function GET(request) {
  const url = new URL(request.url);
  if (url.searchParams.get('cron')) {
    if (!isCron(request)) return fail('Not allowed.', 403);
    try {
      await ensureSchema();
      const s = await getSettings();
      if (!s?.driveFolderId || !KEY) return json({ skipped: true });
      const out = { runs: 0, saved: 0 };
      const t0 = Date.now();
      while (Date.now() - t0 < 200000) { const r = await sync(s, url.origin, 50000); out.runs++; out.saved += r.processed.length; if (!r.remaining || r.limited) break; }
      return json(out);
    } catch (e) { console.error(e); return fail(e.message || 'Sync failed', 500); }
  }
  return statusRoute(request);
}
const statusRoute = route(async (request, { settings }) => json(await status(settings)));

export const POST = route(async (request, { role, settings }) => {
  const b = await request.json().catch(() => ({}));
  const origin = new URL(request.url).origin;
  try {
    if (b.action === 'connect') {
      if (role !== 'owner') return fail('Only the owner can connect a folder.', 403);
      if (!KEY) return fail('Add your Google key (GEMINI_API_KEY) in Vercel first.', 400);
      const id = folderIdFrom(b.link);
      if (!id) return fail('Paste the full Google Drive folder link.', 400);
      let files;
      try { files = await listFiles(id); } catch (e) { return fail(e.message, 400, { code: e.code }); }
      const next = { ...settings, driveFolderId: id, driveSince: b.importExisting === false ? '0000' : new Date().toISOString() };
      if (b.importExisting === false) {
        for (const f of files) await sql`insert into drive_files (file_id, name, mime, created_time, status, message) values (${f.id}, ${f.name}, ${f.mimeType}, ${f.createdTime}, 'ignored', 'Already in the folder when it was connected') on conflict do nothing`;
      }
      await saveSettings(next);
      return json({ ok: true, files: files.length, status: await status(next) });
    }
    if (b.action === 'disconnect') {
      if (role !== 'owner') return fail('Only the owner can do this.', 403);
      const { driveFolderId, driveSince, driveLastSync, ...rest } = settings;
      await saveSettings(rest);
      return json({ ok: true });
    }
    if (b.action === 'sync') {
      if (!settings.driveFolderId) return fail('No Google Drive folder connected.', 400);
      const r = await sync(settings, origin, 100000);
      return json({ ...r, status: await status({ ...settings, driveLastSync: new Date().toISOString() }) });
    }
    if (b.action === 'retry' && b.fileId) { await sql`delete from drive_files where file_id = ${String(b.fileId)} and status in ('check','failed','duplicate','ignored')`; return json({ ok: true }); }
    if (b.action === 'ignore' && b.fileId) { await sql`update drive_files set status = 'ignored', message = 'Ignored', updated_at = now() where file_id = ${String(b.fileId)}`; return json({ ok: true }); }
    return fail('Unknown action.');
  } catch (e) {
    if (e.code) return fail(e.message, 400, { code: e.code });
    throw e;
  }
});
