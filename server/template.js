import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { legacyTrades } from './legacyShape.js';
import { db } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');

// Cache the HTML in memory; reload if mtime changes.
const cache = new Map();
function readHtml(rel) {
  const abs = path.join(PUBLIC, rel);
  const st = fs.statSync(abs);
  const ent = cache.get(abs);
  if (ent && ent.mtime === st.mtimeMs) return ent.html;
  const html = fs.readFileSync(abs, 'utf8');
  cache.set(abs, { mtime: st.mtimeMs, html });
  return html;
}

const SCRIPT_RE = /<script id="trade-data" type="application\/json">[\s\S]*?<\/script>/;

function inject(html, trades) {
  const block = `<script id="trade-data" type="application/json">${JSON.stringify(trades)}</script>`;
  return SCRIPT_RE.test(html) ? html.replace(SCRIPT_RE, block) : html;
}

export function renderOverall() {
  return inject(readHtml('index.html'), legacyTrades());
}

export function renderCsv() {
  return inject(readHtml('csv/index.html'), legacyTrades());
}

// /today gets only the latest day's trades, and we patch the hardcoded date
// references so the page reflects the most recent session in the DB.
export function renderToday() {
  let html = readHtml('today/index.html');
  const all = legacyTrades();
  if (!all.length) return inject(html, []);

  // "Today" = trades that *closed* on the latest session, matching how
  // broker statements book realized P/L. An overnight position entered the
  // prior day belongs to the day its proceeds hit (exit_date), not entry.
  const latest = db.prepare(
    "SELECT DISTINCT substr(exit_dt,1,10) AS d FROM trades WHERE exit_dt IS NOT NULL ORDER BY d DESC LIMIT 1"
  ).get()?.d;
  if (!latest) return inject(html, all);

  const dayTrades = all.filter(t => t.exit_date === latest);
  html = inject(html, dayTrades);

  // Replace the baked-in date everywhere (title, subtitle, chart-base attr).
  // The original file uses "2026-05-11" in multiple places.
  const bakedDate = '2026-05-11';
  if (latest !== bakedDate) {
    html = html.replaceAll(bakedDate, latest);
  }
  return html;
}
