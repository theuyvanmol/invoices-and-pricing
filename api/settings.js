// Owner settings: restaurant name, currency, alert threshold, alert email.
import { route, json, fail, saveSettings, publicSettings } from './_lib.js';

export const PUT = route(async (request, { settings }) => {
  const b = await request.json().catch(() => null);
  if (!b) return fail('Bad request.');
  const threshold = Math.min(100, Math.max(0, Number(b.threshold) || 0));
  const alertEmail = String(b.alertEmail || '').trim().slice(0, 200);
  if (alertEmail && !alertEmail.split(/[,;\s]+/).filter(Boolean).every((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) return fail('Check the email address.');
  const next = { ...settings, restaurant: String(b.restaurant ?? settings.restaurant ?? '').slice(0, 80), currency: String(b.currency || settings.currency || '£').slice(0, 5), threshold, alertEmail };
  await saveSettings(next);
  return json({ ok: true, settings: publicSettings(next) });
}, { needs: 'owner' });
