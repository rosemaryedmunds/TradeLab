// Compute SPX-cash settlement values for expired options.
// SPXW (and most weeklies) are PM-settled: settlement = SPX close at 16:00 ET.
// Regular monthly SPX (AM-settled, "SET") settles at Friday open — we approximate
// with the cash open of the expiry day for now; this can be refined later if
// users trade traditional SPX AM-settled regulars.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', 'data', 'candle-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const MASSIVE_BASE = 'https://api.massive.com';
const MASSIVE_KEY  = process.env.MASSIVE_API_KEY || process.env.POLYGON_API_KEY || '';

async function massiveJson(urlPath) {
  if (!MASSIVE_KEY) throw new Error('MASSIVE_API_KEY not set');
  const url = `${MASSIVE_BASE}${urlPath}${urlPath.includes('?') ? '&' : '?'}apiKey=${MASSIVE_KEY}`;
  const { stdout } = await execFileP('curl', [
    '-s', '--compressed', '--max-time', '20', '-A', 'Mozilla/5.0', url
  ], { maxBuffer: 4 * 1024 * 1024 });
  if (!stdout) throw new Error('Massive: empty');
  const j = JSON.parse(stdout);
  if (j.status === 'ERROR') throw new Error(`Massive: ${j.error || 'unknown'}`);
  return j;
}

// Returns the SPX close at 16:00 ET for the given trading date (PM settlement),
// or null when no data is available (weekends, holidays, future dates).
export async function getSpxPmClose(dateISO) {
  const cachePath = path.join(CACHE_DIR, `spx_pm_close_${dateISO}.json`);
  if (fs.existsSync(cachePath)) {
    try { return JSON.parse(fs.readFileSync(cachePath, 'utf8')).close; } catch {}
  }
  // Try daily bar first — single response, cheaper.
  try {
    const j = await massiveJson(`/v2/aggs/ticker/I:SPX/range/1/day/${dateISO}/${dateISO}?adjusted=false`);
    const r = j.results?.[0];
    if (r && r.c != null) {
      fs.writeFileSync(cachePath, JSON.stringify({ close: r.c, source: 'daily' }));
      return r.c;
    }
  } catch (e) { /* fall through to 1m */ }
  // Fallback: pull the day's 1m bars and take the 16:00 ET print.
  try {
    const j = await massiveJson(`/v2/aggs/ticker/I:SPX/range/1/minute/${dateISO}/${dateISO}?adjusted=false&sort=asc&limit=50000`);
    const bars = j.results || [];
    if (!bars.length) return null;
    const last = bars[bars.length - 1]; // last printed minute of the session
    fs.writeFileSync(cachePath, JSON.stringify({ close: last.c, source: '1m' }));
    return last.c;
  } catch { return null; }
}

// Pull strike + right ('C'/'P') out of either an explicit pair or a contract description.
export function intrinsicValue({ right, strike }, spxClose) {
  if (spxClose == null || strike == null || !right) return null;
  if (right === 'C') return Math.max(0, spxClose - strike);
  if (right === 'P') return Math.max(0, strike - spxClose);
  return null;
}

// Convenience: settlement price for a contract on its expiry date.
// Returns 0 if SPX cash data shows the option closed OTM, or the intrinsic value if ITM.
// Returns null if SPX data couldn't be fetched.
export async function settlementPrice({ right, strike, expiry }) {
  if (!expiry || !right || strike == null) return null;
  const close = await getSpxPmClose(expiry);
  if (close == null) return null;
  return intrinsicValue({ right, strike }, close);
}
