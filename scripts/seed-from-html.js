import fs from 'node:fs';
import path from 'node:path';
import { db, tradeCount } from '../server/db.js';

// Optional bootstrap script — only used if you're migrating from a legacy
// static HTML dashboard with an inline <script id="trade-data"> block.
// New users should ignore this and just upload CSVs via /trades instead.
const SOURCE = process.argv[2] || process.env.TRADELAB_LEGACY_HTML;
if (!SOURCE) {
  console.error('Usage: node scripts/seed-from-html.js <path-to-legacy-index.html>');
  console.error('  (or set TRADELAB_LEGACY_HTML in the env)');
  process.exit(1);
}

const html = fs.readFileSync(SOURCE, 'utf8');
const match = html.match(/<script id="trade-data" type="application\/json">([\s\S]*?)<\/script>/);
if (!match) {
  console.error('No trade-data block found in', SOURCE);
  process.exit(1);
}
const trades = JSON.parse(match[1]);
console.log(`Found ${trades.length} trades in ${SOURCE}`);

const insertTrade = db.prepare(`
  INSERT OR REPLACE INTO trades
  (id, symbol, root, expiry, strike, right, direction, quantity,
   entry_dt, exit_dt, entry_price, exit_price, commission, notes,
   synthetic_exit)
  VALUES
  (@id, @symbol, @root, @expiry, @strike, @right, @direction, @quantity,
   @entry_dt, @exit_dt, @entry_price, @exit_price, @commission, @notes,
   @synthetic_exit)
`);

const insertExec = db.prepare(`
  INSERT INTO executions (trade_id, dt, side, qty, price, commission)
  VALUES (@trade_id, @dt, @side, @qty, @price, @commission)
`);

const clearExecs = db.prepare(`DELETE FROM executions WHERE trade_id = ?`);

// Convert "2026-01-06 11:57:58" -> "2026-01-06T11:57:58"
const toISO = (s) => (s ? String(s).replace(' ', 'T') : null);

const tx = db.transaction((rows) => {
  for (const t of rows) {
    const row = {
      id: t.id,
      symbol: t.symbol,
      root: t.root || null,
      expiry: t.expiry || null,
      strike: t.strike ?? null,
      right: t.right || null,
      direction: t.direction || 'long',
      quantity: Math.abs(t.quantity ?? 0),
      entry_dt: toISO(t.entry_dt),
      exit_dt: toISO(t.exit_dt),
      entry_price: t.entry_price ?? 0,
      exit_price: t.exit_price ?? null,
      commission: typeof t.total_commission === 'number' ? t.total_commission : (t.fee_drag ?? 0),
      notes: null,
      synthetic_exit: t.synthetic_exit ? 1 : 0
    };
    insertTrade.run(row);
    clearExecs.run(t.id);
    if (Array.isArray(t.execution_ladder)) {
      for (const e of t.execution_ladder) {
        insertExec.run({
          trade_id: t.id,
          dt: toISO(e.dt),
          side: e.side,
          qty: Math.abs(e.qty ?? 0),
          price: e.price ?? 0,
          commission: e.commission ?? 0
        });
      }
    }
  }
});

tx(trades);

console.log(`Database now has ${tradeCount()} trades.`);
