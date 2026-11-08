// Sign-in, first-time setup and sign-out.
import crypto from 'node:crypto';
import { json, fail, getSettings, saveSettings, hashPin, checkPin, makeSession, clearSession, getRole, publicSettings, sql } from './_lib.js';

const features = () => ({
  db: !!sql,
  ai: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
  photos: !!process.env.BLOB_READ_WRITE_TOKEN,
  email: !!process.env.RESEND_API_KEY,
});
const pinOk = (p) => /^\d{4,8}$/.test(String(p || ''));

export async function GET(request) {
  if (!sql) return json({ needsSetup: false, role: null, features: features(), error: 'NO_DB' });
  try {
    const s = await getSettings();
    const role = await getRole(request, s);
    return json({ needsSetup: false, role, settings: role ? publicSettings(s) : { restaurant: s.restaurant || '', pinsEnabled: true }, features: features() });
  } catch (e) {
    console.error(e);
    return fail('Could not reach the database.', 503);
  }
}

export async function POST(request) {
  if (!sql) return fail('The database is not connected yet.', 503, { code: 'NO_DB' });
  let body;
  try { body = await request.json(); } catch { return fail('Bad request.'); }
  try {
    const s = await getSettings();

    if (body.action === 'setup') {
      if (s && s.pinsEnabled) return fail('PIN sign-in is already set up. Sign in instead.', 409);
      if (!pinOk(body.ownerPin) || !pinOk(body.managerPin)) return fail('PINs must be 4 to 8 digits.');
      if (body.ownerPin === body.managerPin) return fail('The owner PIN and manager PIN must be different.');
      const data = {
        restaurant: String(body.restaurant || '').slice(0, 80),
        currency: '£',
        pinsEnabled: true,
        threshold: 0,
        alertEmail: String(body.alertEmail || '').slice(0, 200),
        ownerHash: hashPin(body.ownerPin),
        managerHash: hashPin(body.managerPin),
        secret: crypto.randomBytes(32).toString('hex'),
      };
      await saveSettings(data);
      return json({ ok: true, role: 'owner' }, 200, { 'set-cookie': makeSession('owner', data.secret) });
    }

    if (!s) return fail('Setup is not finished.', 409, { code: 'SETUP' });

    if (body.action === 'login') {
      const now = Date.now();
      if ((s.fails || 0) >= 8 && now - (s.failAt || 0) < 15 * 60 * 1000) return fail('Too many wrong PINs. Wait 15 minutes and try again.', 429);
      const pin = String(body.pin || '');
      const role = checkPin(pin, s.ownerHash) ? 'owner' : checkPin(pin, s.managerHash) ? 'manager' : null;
      if (!role) {
        const fails = now - (s.failAt || 0) > 15 * 60 * 1000 ? 1 : (s.fails || 0) + 1;
        await saveSettings({ ...s, fails, failAt: now });
        await new Promise((r) => setTimeout(r, 500));
        return fail('That PIN is not right.', 401);
      }
      if (s.fails) await saveSettings({ ...s, fails: 0, failAt: 0 });
      return json({ ok: true, role }, 200, { 'set-cookie': makeSession(role, s.secret) });
    }

    if (body.action === 'logout') return json({ ok: true }, 200, { 'set-cookie': clearSession() });

    if (body.action === 'pins') {
      const role = await getRole(request, s);
      if (role !== 'owner') return fail('Only the owner can change PINs.', 403);
      const next = { ...s };
      if (!s.pinsEnabled && (!body.ownerPin || !body.managerPin)) return fail('Choose both an owner PIN and a manager PIN to turn on sign-in.');
      next.pinsEnabled = true;
      if (body.ownerPin) { if (!pinOk(body.ownerPin)) return fail('PINs must be 4 to 8 digits.'); next.ownerHash = hashPin(body.ownerPin); }
      if (body.managerPin) { if (!pinOk(body.managerPin)) return fail('PINs must be 4 to 8 digits.'); next.managerHash = hashPin(body.managerPin); }
      if (body.ownerPin && body.managerPin && body.ownerPin === body.managerPin) return fail('The owner PIN and manager PIN must be different.');
      next.secret = crypto.randomBytes(32).toString('hex'); // signs everyone else out
      await saveSettings(next);
      return json({ ok: true }, 200, { 'set-cookie': makeSession('owner', next.secret) });
    }

    return fail('Unknown action.');
  } catch (e) {
    console.error(e);
    return fail('Something went wrong on the server. Try again.', 500);
  }
}
