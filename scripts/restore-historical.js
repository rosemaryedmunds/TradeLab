// Restore historical trades to the ground-truth state baked into the legacy
// /var/www/tradelab/index.html, while preserving any trades imported on or
// after `CUTOFF_DATE` (those came from clean broker tapes through the new
// importer). Run with `node scripts/restore-historical.js` for live restore,
// or `node scripts/restore-historical.js --dry-run` to preview.

import fs from 'node:fs';
import { db } from '../server/db.js';

const SOURCE = process.argv.find(a => a.endsWith('.html')) || process.env.TRADELAB_LEGACY_HTML;
if (!SOURCE) {
  console.error('Usage: node scripts/restore-historical.js <path-to-legacy-index.html> [--dry-run]');
  console.error('  Restores trades from a known-good legacy HTML snapshot. Skip this script if you don\'t have one.');
  process.exit(1);
}
const CUTOFF_DATE = '2026-05-12'; // any trade with entry_date >= this is kept as-is
const DRY = process.argv.includes('--dry-run');

const html = fs.readFileSync(SOURCE, 'utf8');
const m = html.match(/<script id="trade-data" type="application\/json">([\s\S]*?)<\/script>/);
if (!m) { console.error('No trade-data block in', SOURCE); process.exit(1); }
const orig = JSON.parse(m[1]);
console.log(`source has ${orig.length} trades through ${orig[orig.length-1]?.entry_date}`);

// 1. Plan: find man-* trades older than CUTOFF (these are orphaned partial fills).
const manToDelete = db.prepare(
  `SELECT id, symbol, entry_dt FROM trades WHERE id LIKE 'man-%' AND substr(entry_dt,1,10) < ?`
).all(CUTOFF_DATE);
console.log(`man-* trades to delete (entry_date < ${CUTOFF_DATE}): ${manToDelete.length}`);
for (const t of manToDelete.slice(0, 10)) console.log(`  ${t.id} ${t.symbol.slice(0,40)} ${t.entry_dt}`);
if (manToDelete.length > 10) console.log(`  …and ${manToDelete.length - 10} more`);

// 2. Plan: identify all-* trades whose DB data disagrees with the source HTML.
const drifted = [];
for (const o of orig) {
  const r = db.prepare('SELECT entry_price, exit_price, quantity, commission FROM trades WHERE id = ?').get(o.id);
  if (!r) { drifted.push({ id: o.id, reason: 'missing' }); continue; }
  const dn = r.exit_price != null ? (r.exit_price - r.entry_price) * r.quantity * 100 + (r.commission||0) : null;
  const on = o.net_pnl || 0;
  if (Math.abs((dn||0) - on) > 0.01) {
    drifted.push({ id: o.id, db_net: dn?.toFixed(2), orig_net: on.toFixed(2) });
  }
}
console.log(`all-* trades with drifted PnL: ${drifted.length}`);
for (const d of drifted.slice(0, 8)) console.log(`  ${d.id}  db=${d.db_net}  orig=${d.orig_net}${d.reason ? '  '+d.reason : ''}`);

if (DRY) {
  console.log('\n--- dry run: no changes committed ---');
  process.exit(0);
}

// 3. Execute the restore in a single transaction.
const delTrade = db.prepare('DELETE FROM trades WHERE id = ?');
const insertTrade = db.prepare(`
  INSERT INTO trades (id, symbol, root, expiry, strike, right, direction, quantity,
    entry_dt, exit_dt, entry_price, exit_price, commission, notes, synthetic_exit)
  VALUES (@id, @symbol, @root, @expiry, @strike, @right, @direction, @quantity,
    @entry_dt, @exit_dt, @entry_price, @exit_price, @commission, @notes, @synthetic_exit)
  ON CONFLICT(id) DO UPDATE SET
    symbol=excluded.symbol, root=excluded.root, expiry=excluded.expiry, strike=excluded.strike,
    right=excluded.right, direction=excluded.direction, quantity=excluded.quantity,
    entry_dt=excluded.entry_dt, exit_dt=excluded.exit_dt,
    entry_price=excluded.entry_price, exit_price=excluded.exit_price,
    commission=excluded.commission, synthetic_exit=excluded.synthetic_exit
`);
const insertExec = db.prepare(`
  INSERT INTO executions (trade_id, dt, side, qty, price, commission)
  VALUES (@trade_id, @dt, @side, @qty, @price, @commission)
`);
const clearExecs = db.prepare('DELETE FROM executions WHERE trade_id = ?');

const toISO = (s) => s ? String(s).replace(' ', 'T') : null;

const tx = db.transaction(() => {
  for (const t of manToDelete) delTrade.run(t.id);
  for (const o of orig) {
    insertTrade.run({
      id: o.id,
      symbol: o.symbol,
      root: o.root || null,
      expiry: o.expiry || null,
      strike: o.strike ?? null,
      right: o.right || null,
      direction: o.direction || 'long',
      quantity: Math.abs(o.quantity ?? 0),
      entry_dt: toISO(o.entry_dt),
      exit_dt: toISO(o.exit_dt),
      entry_price: o.entry_price ?? 0,
      exit_price: o.exit_price ?? null,
      commission: typeof o.total_commission === 'number' ? o.total_commission : (o.fee_drag ?? 0),
      notes: null,
      synthetic_exit: o.synthetic_exit ? 1 : 0
    });
    clearExecs.run(o.id);
    if (Array.isArray(o.execution_ladder)) {
      for (const e of o.execution_ladder) {
        insertExec.run({
          trade_id: o.id,
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

tx();

const totalTrades = db.prepare('SELECT COUNT(*) AS n FROM trades').get().n;
console.log(`\n✔ restore committed. Total trades now: ${totalTrades}`);
