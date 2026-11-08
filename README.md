# Invoices & Pricing

A mobile-first web app for restaurants. Managers photograph supplier invoices, Google Gemini reads every line, and the owner sees every product's current price, previous price, full history, supplier comparisons and alerts when a price goes up.

## How it works
- **Scan**: managers sign in with the manager PIN, tap Scan, photograph each page, check the lines that were read, and save.
- **Prices**: every product from every supplier keeps its full price history.
- **Alerts**: any increase (or above the % you choose) creates an alert in the app and, optionally, an email.
- **Owner**: signs in with the owner PIN to review alerts, change settings and PINs, and delete invoices.

## Hosting (Vercel)
| What | Where it comes from |
|---|---|
| Database | Neon Postgres from the Vercel Marketplace (`DATABASE_URL`) |
| Invoice photos | Vercel Blob store connected to the project (`BLOB_READ_WRITE_TOKEN`) |
| Invoice reading | `GEMINI_API_KEY` (free, from aistudio.google.com). Optional: `GEMINI_MODEL` |
| Email alerts (optional) | `RESEND_API_KEY` (from resend.com). Optional: `ALERT_FROM` with a verified sender |

Tables are created automatically on first use. The first person to open the site chooses the owner and manager PINs.

## Code
- `public/index.html` — the whole app UI (no build step)
- `api/*.js` — Vercel Functions: `session`, `data`, `upload`, `read`, `invoices`, `alerts`, `settings`
