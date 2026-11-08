// Stores one invoice photo in Vercel Blob and returns its address.
import { put } from '@vercel/blob';
import { route, json, fail } from './_lib.js';

const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

export const POST = route(async (request) => {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return fail('Photo storage is not connected yet.', 503, { code: 'NO_BLOB' });
  const type = (request.headers.get('x-file-type') || 'image/jpeg').toLowerCase();
  if (!TYPES[type]) return fail('Only JPG, PNG or WebP photos, or PDF files, can be uploaded.');
  const buf = Buffer.from(await request.arrayBuffer());
  if (!buf.length) return fail('The photo was empty.');
  if (buf.length > 4 * 1024 * 1024) return fail('The file is too large (over 4 MB).');
  const d = new Date();
  const name = `invoices/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/invoice.${TYPES[type]}`;
  const blob = await put(name, buf, { access: 'public', contentType: type, addRandomSuffix: true });
  return json({ url: blob.url });
});
