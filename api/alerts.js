// Mark a price alert as reviewed or reopen it, with an optional note.
import { route, json, fail, sql } from './_lib.js';

export const PATCH = route(async (request) => {
  const b = await request.json().catch(() => ({}));
  if (!b.id || !['open', 'reviewed'].includes(b.status)) return fail('Bad request.');
  const note = b.note == null ? null : String(b.note).slice(0, 1000);
  const r = b.status === 'reviewed'
    ? await sql`update alerts set status = 'reviewed', reviewed_at = now(), note = coalesce(${note}, note) where id = ${b.id} returning id`
    : await sql`update alerts set status = 'open', reviewed_at = null, note = coalesce(${note}, note) where id = ${b.id} returning id`;
  if (!r[0]) return fail('Alert not found.', 404);
  return json({ ok: true });
}, { needs: 'owner' });
