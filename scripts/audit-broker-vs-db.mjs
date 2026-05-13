#!/usr/bin/env node
// Reconcile data/tradelab.db against authoritative broker exports.
//
// Usage:
//   node scripts/audit-broker-vs-db.mjs \
//     --ibkr /path/to/U########.TRANSACTIONS.YYYYMMDD.YYYYMMDD.csv \
//     [--tape /path/to/trade-history.csv]... \
//     [--db /path/to/tradelab.db]
//
// Inputs the script understands:
//   --ibkr  IBKR "Transaction History" CSV (rows beginning with
//           "Transaction History","Data",… and a "Buy" / "Sell" /
//           "Cash Settlement" type column). The signed Net Amount is
//           authoritative.
//   --tape  Per-fill broker "trade tape" CSV with columns
//           Symbol, Side, [Qty,] Fill Price, Time, Net Amount, Commission.
//           Used as a second-source cross-check; broker net is derived
//           as sum(sell net) - sum(buy net) - sum(|commission|).
//
// Per-day mismatches that pair to ~zero across adjacent dates are typically
// overnight-attribution noise (DB books a round trip to its entry date;
// broker books each fill on its fill date). Sum-to-near-zero pairs are not
// data errors.

import { parse } from 'csv-parse/sync';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = { tape: [], db: null, ibkr: null };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--ibkr') args.ibkr = process.argv[++i];
  else if (a === '--tape') args.tape.push(process.argv[++i]);
  else if (a === '--db') args.db = process.argv[++i];
  else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  else { console.error(`Unknown arg: ${a}`); printHelp(); process.exit(2); }
}
if (!args.ibkr && args.tape.length === 0) { printHelp(); process.exit(2); }

const DB_PATH = args.db || path.join(__dirname, '..', 'data', 'tradelab.db');

function printHelp() {
  console.error('Usage: node scripts/audit-broker-vs-db.mjs --ibkr <path> [--tape <path>]... [--db <path>]');
}

const r2 = (n) => Math.round(n * 100) / 100;
const fmt = (n) => (n >= 0 ? '+' : '') + n.toFixed(2);
const lc = (h) => h.map((x) => String(x).toLowerCase().trim().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''));

function readTape(p) {
  const text = fs.readFileSync(p, 'utf8');
  const rows = parse(text, { columns: lc, skip_empty_lines: true, trim: true });
  const byDate = new Map();
  for (const r of rows) {
    const t = r.time || r.dt;
    if (!t) continue;
    const iso = String(t).match(/^(\d{4}-\d{2}-\d{2})/);
    const us = String(t).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    const date = iso ? iso[1] : us ? `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}` : String(t).slice(0, 10);
    const side = String(r.side || '').toUpperCase().startsWith('S') ? 'SELL' : 'BUY';
    const net = parseFloat(r.net_amount ?? r.net ?? r.amount ?? 0);
    const commission = Math.abs(parseFloat(r.commission ?? 0)) || 0;
    if (!byDate.has(date)) byDate.set(date, { buy: 0, sell: 0, comm: 0, rows: 0 });
    const b = byDate.get(date);
    if (side === 'BUY') b.buy += Math.abs(net); else b.sell += Math.abs(net);
    b.comm += commission;
    b.rows += 1;
  }
  return byDate;
}

function readIbkrTxn(p) {
  const text = fs.readFileSync(p, 'utf8');
  const rows = parse(text, { skip_empty_lines: true, relax_column_count: true, trim: true });
  const byDate = new Map();
  for (const r of rows) {
    if (r[0] !== 'Transaction History' || r[1] !== 'Data') continue;
    const typ = r[5];
    if (!['Buy', 'Sell', 'Cash Settlement'].includes(typ)) continue;
    const date = r[2];
    const net = parseFloat(r[12]) || 0;
    if (!byDate.has(date)) byDate.set(date, { net: 0, rows: 0 });
    const b = byDate.get(date);
    b.net += net;
    b.rows += 1;
  }
  return byDate;
}

const db = new Database(DB_PATH, { readonly: true });
const dbByDate = new Map();
for (const t of db.prepare(`SELECT entry_dt, exit_dt, exit_price, quantity, entry_price, commission FROM trades`).all()) {
  const date = (t.entry_dt || '').slice(0, 10);
  if (!date) continue;
  const mult = 100;
  const net_pnl = (t.exit_price == null || t.exit_dt == null)
    ? (t.commission || 0)
    : (t.exit_price - t.entry_price) * t.quantity * mult + (t.commission || 0);
  if (!dbByDate.has(date)) dbByDate.set(date, { net: 0, trades: 0 });
  const b = dbByDate.get(date);
  b.net += net_pnl;
  b.trades += 1;
}

const mismatches = [];

if (args.ibkr) {
  console.log(`=== IBKR transactions (${path.basename(args.ibkr)}) ===\n`);
  const byDate = readIbkrTxn(args.ibkr);
  let total_broker = 0, total_db = 0, mismatch_days = 0, missing = 0;
  for (const [date, b] of [...byDate].sort()) {
    const broker_net = r2(b.net);
    const dbB = dbByDate.get(date);
    if (!dbB) {
      console.log(`${date}  rows=${b.rows} broker=${fmt(broker_net)}  DB: NO TRADES  <<<MISSING`);
      missing++;
      total_broker += broker_net;
      continue;
    }
    const delta = r2(dbB.net - broker_net);
    const flag = Math.abs(delta) > 0.5 ? '  <<<<<<' : '';
    if (flag) { mismatch_days++; mismatches.push({ date, delta, broker: broker_net, db: dbB.net, dbtrades: dbB.trades, brokerrows: b.rows }); }
    total_broker += broker_net;
    total_db += dbB.net;
    console.log(`${date}  rows=${String(b.rows).padStart(3)} broker=${String(fmt(broker_net)).padStart(10)}  DB trades=${String(dbB.trades).padStart(3)} net=${String(fmt(dbB.net)).padStart(10)}  Δ=${fmt(delta)}${flag}`);
  }
  console.log(`\nIBKR totals: broker ${fmt(total_broker)}  DB ${fmt(total_db)}  Δ(DB - broker)=${fmt(total_db - total_broker)}`);
  console.log(`Mismatch days (|Δ|>$0.50): ${mismatch_days}    Missing-in-DB days: ${missing}`);
}

for (const p of args.tape) {
  if (!fs.existsSync(p)) { console.log(`\n(skip) missing ${p}`); continue; }
  console.log(`\n=== Tape cross-check (${path.basename(p)}) ===\n`);
  const byDate = readTape(p);
  for (const [date, b] of [...byDate].sort()) {
    const broker_net = b.sell - b.buy - b.comm;
    const dbB = dbByDate.get(date);
    if (!dbB) { console.log(`${date}  broker ${fmt(broker_net)}  DB: NO TRADES`); continue; }
    const delta = r2(dbB.net - broker_net);
    const flag = Math.abs(delta) > 0.5 ? '  <<<<<<' : '';
    console.log(`${date}  broker rows=${b.rows} net=${fmt(broker_net)}  DB trades=${dbB.trades} net=${fmt(dbB.net)}  Δ=${fmt(delta)}${flag}`);
  }
}

if (mismatches.length) {
  console.log('\n=== Mismatched days (sorted by |Δ| desc) ===');
  mismatches.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  for (const m of mismatches.slice(0, 30)) {
    console.log(`  ${m.date}  Δ=${fmt(m.delta)}  broker=${fmt(m.broker)} (${m.brokerrows} rows)  DB=${fmt(m.db)} (${m.dbtrades} trades)`);
  }
  console.log('\nNote: per-day deltas that pair to ~zero across adjacent dates are overnight-attribution noise (DB books each round trip to its entry date), not data errors.');
}
