// Reads invoice photos with Google Gemini (free). Never calls Anthropic.
import { route, json } from './_lib.js';
import { readInvoice, listModels, KEY, currentModel } from './_reader.js';

export const POST = route(async (request) => {
  const { photos, model } = await request.json().catch(() => ({}));
  return readInvoice(photos, model);
});

// Lists which free Gemini models this key can use (names only), to help diagnose reading problems.
export const GET = route(async () => json({ preferred: currentModel(), models: KEY ? await listModels() : [] }));
