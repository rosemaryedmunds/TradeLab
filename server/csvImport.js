import { parse } from 'csv-parse/sync';
import { db } from './db.js';
import { settlementPrice } from './settlement.js';

// Auto-detects three formats:
//   1. Flat trade rows (one row per round-trip closed trade)
//   2. IBKR-style execution rows with round_trip_id (multiple rows grouped by id)
//   3. Broker "trade tape" — per-fill rows with Symbol/Side/Fill Price/Time/Net Amount/Commission;
//      FIFO-matches buys to sells per symbol into round trips.
// Returns { inserted, updated, skipped, errors, mode }.

function normalizeHeader(h) {
  return String(h || '').toLowerCase().trim().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,'');
}

function toISO(s) {
  if (!s) return null;
  const v = String(s).trim();
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return v;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(v)) return v.replace(' ', 'T');
  // US-style M/D/YYYY H:MM[:SS]
  const us = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (us) {
    const [, mm, dd, yyyy, hh, mi, ss] = us;
    return `${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}T${hh.padStart(2,'0')}:${mi}:${ss || '00'}`;
  }
  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0,19);
  return v;
}

function detectDelimiter(text) {
  const head = text.split('\n').slice(0, 5).join('\n');
  const t = (head.match(/\t/g) || []).length;
  const c = (head.match(/,/g) || []).length;
  return t > c ? '\t' : ',';
}

function detectRoot(symbol) {
  if (!symbol) return null;
  // "SPX (SPXW) May12 '26 7340 Put" -> SPXW
  const inner = String(symbol).match(/\(([A-Z]+)\)/);
  if (inner) return inner[1];
  const m = String(symbol).trim().match(/^([A-Z]+)/);
  return m ? m[1] : null;
}

const MONTHS = { Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12 };

function parseOptionDescription(s) {
  // "SPX (SPXW) May12 '26 7340 Put"  or  "AAPL Jun 21 '24 200 Call"
  const m = String(s).match(/([A-Z][a-z]{2})\s*(\d{1,2})\s+'?(\d{2,4})\s+(\d+(?:\.\d+)?)\s+(Call|Put|C|P)\b/i);
  if (!m) return { root: detectRoot(s), expiry: null, strike: null, right: null };
  const [, mon, day, yr, strike, rt] = m;
  const yrNum = yr.length === 2 ? 2000 + parseInt(yr, 10) : parseInt(yr, 10);
  const monNum = MONTHS[mon[0].toUpperCase() + mon.slice(1, 3).toLowerCase()];
  const expiry = monNum ? `${yrNum}-${String(monNum).padStart(2,'0')}-${String(day).padStart(2,'0')}` : null;
  return {
    root: detectRoot(s),
    expiry,
    strike: parseFloat(strike),
    right: /^c/i.test(rt) ? 'C' : 'P'
  };
}

function detectFormat(rows) {
  if (!rows.length) return 'flat';
  const keys = new Set(Object.keys(rows[0]));
  // Trade tape: has Fill Price + Time + Side (the user's IBKR-style export)
  if ((keys.has('fill_price') || keys.has('price')) && keys.has('time') && keys.has('side')) return 'tape';
  // IBKR execution ladder with round_trip_id
  if ((keys.has('side') || keys.has('action')) && (keys.has('qty') || keys.has('quantity')) && (keys.has('price') || keys.has('fill_price'))) {
    return 'executions';
  }
  return 'flat';
}

export async function importCsv(text) {
  const delimiter = detectDelimiter(text);
  const records = parse(text, {
    columns: (h) => h.map(normalizeHeader),
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    delimiter
  });
  if (!records.length) return { inserted: 0, updated: 0, skipped: 0, errors: ['empty csv'], mode: 'flat' };

  const mode = detectFormat(records);
  if (mode === 'tape')       return await importTape(records);
  if (mode === 'executions') return importExecutions(records);
  return importFlat(records);
}

const insertTradeSQL = `
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
`;
const insertExecSQL = `
  INSERT INTO executions (trade_id, dt, side, qty, price, commission)
  VALUES (@trade_id, @dt, @side, @qty, @price, @commission)
`;
const clearExecSQL = `DELETE FROM executions WHERE trade_id = ?`;

function nextManualId() {
  const row = db.prepare("SELECT id FROM trades WHERE id LIKE 'man-%' ORDER BY id DESC LIMIT 1").get();
  const n = row ? parseInt(row.id.slice(4), 10) : 0;
  return `man-${String(n+1).padStart(4,'0')}`;
}

// Find an existing trade that should be treated as "the same" as an incoming one.
// Open positions: match on (symbol, entry_dt) only (one open per buy-time).
// Closed trades: must match on entry+exit datetimes AND exit price (handles
// FIFO splits where one buy is closed by multiple sells).
function findExisting(symbol, entry_dt, exit_dt, exit_price) {
  if (exit_dt == null) {
    return db.prepare(`SELECT id FROM trades WHERE symbol = ? AND entry_dt = ? AND exit_dt IS NULL`).get(symbol, entry_dt);
  }
  return db.prepare(`
    SELECT id FROM trades
    WHERE symbol = ? AND entry_dt = ? AND exit_dt = ?
      AND ABS(COALESCE(exit_price, -99999) - ?) < 0.00005
  `).get(symbol, entry_dt, exit_dt, exit_price ?? 0);
}

// ---------------- FLAT ----------------
function importFlat(rows) {
  const insertTrade = db.prepare(insertTradeSQL);
  let inserted = 0, updated = 0, skipped = 0;
  const errors = [];

  const tx = db.transaction(() => {
    for (const r of rows) {
      try {
        const symbol = r.symbol || r.contract || r.ticker;
        const entry_dt = toISO(r.entry_dt || r.entry || r.entry_datetime || r.entry_time);
        const entry_price = parseFloat(r.entry_price ?? r.entry);
        const quantity = parseFloat(r.quantity ?? r.qty);
        if (!symbol || !entry_dt || Number.isNaN(entry_price) || Number.isNaN(quantity)) {
          skipped++;
          errors.push(`flat row missing required (symbol/entry_dt/entry_price/quantity): ${JSON.stringify(r).slice(0,200)}`);
          continue;
        }
        let id = r.id || r.trade_id || r.round_trip_id;
        if (!id) {
          const exit_dt = toISO(r.exit_dt || r.exit || r.exit_time);
          const exit_price = r.exit_price != null && r.exit_price !== '' ? parseFloat(r.exit_price) : null;
          const match = findExisting(symbol, entry_dt, exit_dt, exit_price);
          id = match ? match.id : nextManualId();
        }
        const parsed = parseOptionDescription(symbol);
        const exists = db.prepare('SELECT 1 FROM trades WHERE id = ?').get(id);
        insertTrade.run({
          id,
          symbol,
          root: r.root || parsed.root,
          expiry: r.expiry || parsed.expiry,
          strike: r.strike ? parseFloat(r.strike) : parsed.strike,
          right: r.right || parsed.right,
          direction: r.direction || 'long',
          quantity: Math.abs(quantity),
          entry_dt,
          exit_dt: toISO(r.exit_dt || r.exit || r.exit_time),
          entry_price,
          exit_price: r.exit_price != null && r.exit_price !== '' ? parseFloat(r.exit_price) : null,
          commission: r.commission ? parseFloat(r.commission) : 0,
          notes: r.notes || null,
          synthetic_exit: 0
        });
        if (exists) updated++; else inserted++;
      } catch (e) {
        skipped++;
        errors.push(`${e.message}: ${JSON.stringify(r).slice(0,200)}`);
      }
    }
  });
  tx();
  return { inserted, updated, skipped, errors: errors.slice(0, 20), mode: 'flat' };
}

// ---------------- EXECUTIONS WITH round_trip_id ----------------
function importExecutions(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = r.round_trip_id || r.trade_id || r.id;
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  if (groups.size === 0) {
    // No explicit ids — fall through to tape parser, which FIFO-matches buys to sells
    return importTape(rows);
  }

  const insertTrade = db.prepare(insertTradeSQL);
  const clearExec = db.prepare(clearExecSQL);
  const insertExec = db.prepare(insertExecSQL);
  let inserted = 0, updated = 0;
  const errors = [];

  const tx = db.transaction(() => {
    for (const [key, execs] of groups) {
      execs.sort((a, b) => String(a.dt||a.datetime||a.time).localeCompare(String(b.dt||b.datetime||b.time)));
      const first = execs[0];
      const symbol = first.symbol || first.contract;
      const parsed = parseOptionDescription(symbol);

      let buyQty = 0, sellQty = 0, buyVal = 0, sellVal = 0, totalCommission = 0;
      let entry_dt = null, exit_dt = null;
      for (const e of execs) {
        const dt = toISO(e.dt || e.datetime || e.time);
        const side = String(e.side || e.action || '').toUpperCase().startsWith('S') ? 'SELL' : 'BUY';
        const qty = Math.abs(parseFloat(e.qty ?? e.quantity ?? 0));
        const price = parseFloat(e.price ?? e.fill_price);
        const commission = -Math.abs(parseFloat(e.commission ?? 0)) || 0;
        if (!dt || Number.isNaN(qty) || Number.isNaN(price)) {
          errors.push(`bad exec row in ${key}`); continue;
        }
        if (side === 'BUY') { buyQty += qty; buyVal += qty * price; if (!entry_dt) entry_dt = dt; }
        else { sellQty += qty; sellVal += qty * price; exit_dt = dt; }
        totalCommission += commission;
      }
      if (buyQty === 0) { errors.push(`no buys in ${key}`); continue; }
      const entry_price = buyVal / buyQty;
      const exit_price = sellQty > 0 ? sellVal / sellQty : null;

      let id = first.round_trip_id || first.trade_id || `csv-${String(key).slice(0,32)}`;
      const matchByContent = !first.round_trip_id && !first.trade_id
        ? db.prepare('SELECT id FROM trades WHERE symbol = ? AND entry_dt = ?').get(symbol, entry_dt)
        : null;
      if (matchByContent) id = matchByContent.id;
      const exists = db.prepare('SELECT 1 FROM trades WHERE id = ?').get(id);

      insertTrade.run({
        id, symbol,
        root: first.root || parsed.root,
        expiry: first.expiry || parsed.expiry,
        strike: first.strike ? parseFloat(first.strike) : parsed.strike,
        right: first.right || parsed.right,
        direction: 'long',
        quantity: buyQty,
        entry_dt, exit_dt,
        entry_price, exit_price,
        commission: totalCommission,
        notes: null,
        synthetic_exit: 0
      });
      clearExec.run(id);
      for (const e of execs) {
        const dt = toISO(e.dt || e.datetime || e.time);
        const side = String(e.side || e.action || '').toUpperCase().startsWith('S') ? 'SELL' : 'BUY';
        const qty = Math.abs(parseFloat(e.qty ?? e.quantity ?? 0));
        const price = parseFloat(e.price ?? e.fill_price);
        const commission = -Math.abs(parseFloat(e.commission ?? 0)) || 0;
        if (!dt || Number.isNaN(qty) || Number.isNaN(price)) continue;
        insertExec.run({ trade_id: id, dt, side, qty, price, commission });
      }
      if (exists) updated++; else inserted++;
    }
  });
  tx();
  return { inserted, updated, skipped: 0, errors: errors.slice(0, 20), mode: 'executions' };
}

// ---------------- TAPE: per-fill rows, FIFO match per symbol ----------------
async function importTape(rows) {
  // Normalize each row into an execution record.
  const execs = [];
  const errors = [];
  for (const r of rows) {
    const symbol = r.symbol || r.contract;
    const dt = toISO(r.dt || r.time || r.datetime);
    const side = String(r.side || r.action || '').toUpperCase().startsWith('S') ? 'SELL' : 'BUY';
    const price = parseFloat(r.fill_price ?? r.price);
    const commission = -Math.abs(parseFloat(r.commission ?? 0)) || 0;
    let qty = parseFloat(r.qty ?? r.quantity ?? r.shares);
    const netRaw = r.net_amount ?? r.net ?? r.amount;
    const net = parseFloat(netRaw);
    // If qty missing, derive from net amount: net = qty * price * 100
    if (Number.isNaN(qty) || qty === 0) {
      if (!Number.isNaN(net) && price > 0) qty = Math.round(Math.abs(net) / (price * 100));
    }
    if (!symbol || !dt || Number.isNaN(price) || Number.isNaN(qty) || qty <= 0) {
      errors.push(`bad tape row: ${JSON.stringify(r).slice(0,200)}`);
      continue;
    }
    // Some broker tape exports include a row for cash settlement / exercise of
    // an expired option that does NOT follow the per-fill convention: Net
    // Amount is 0 while the price column holds the dollar settlement value.
    // Read literally that produces a 100x phantom gain. Filter any row where
    // net is explicitly zero but qty*price*100 would be a non-trivial amount;
    // the auto-expiry branch below settles the open position correctly from
    // the underlying's close.
    const expectedNet = qty * price * 100;
    if (netRaw != null && netRaw !== '' && Math.abs(net) < 0.005 && expectedNet > 50) {
      errors.push(`skipped settlement/exercise row (net=0, implied=${expectedNet}): ${symbol} ${dt}`);
      continue;
    }
    execs.push({ symbol, dt, side, qty: Math.abs(qty), price, commission });
  }
  if (!execs.length) return { inserted: 0, updated: 0, skipped: rows.length, errors: errors.slice(0,20), mode: 'tape' };

  // Sort ascending by dt within each symbol, FIFO-match buys to sells.
  const bySymbol = new Map();
  for (const e of execs) {
    if (!bySymbol.has(e.symbol)) bySymbol.set(e.symbol, []);
    bySymbol.get(e.symbol).push(e);
  }

  const insertTrade = db.prepare(insertTradeSQL);
  const clearExec = db.prepare(clearExecSQL);
  const insertExec = db.prepare(insertExecSQL);
  let inserted = 0, updated = 0, skipped = 0;
  const trades = [];

  for (const [symbol, list] of bySymbol) {
    // Stable sort by dt; at the same dt, BUY must come before SELL (you can't
    // FIFO-close a position before it was opened). This matters when broker
    // tape rounds to the minute and groups same-minute fills.
    list.sort((a, b) => a.dt.localeCompare(b.dt) || (a.side === b.side ? 0 : a.side === 'BUY' ? -1 : 1));
    const openBuys = []; // FIFO queue of remaining buy lots
    for (const e of list) {
      if (e.side === 'BUY') {
        openBuys.push({ remaining: e.qty, price: e.price, dt: e.dt, commPerUnit: e.commission / e.qty });
        continue;
      }
      // SELL: close from oldest open buys
      let toClose = e.qty;
      let costSum = 0, entryDt = null, entryCommission = 0, totalQty = 0;
      while (toClose > 0 && openBuys.length) {
        const head = openBuys[0];
        const take = Math.min(toClose, head.remaining);
        if (!entryDt) entryDt = head.dt;
        costSum += take * head.price;
        entryCommission += take * head.commPerUnit;
        head.remaining -= take;
        toClose -= take;
        totalQty += take;
        if (head.remaining < 1e-9) openBuys.shift();
      }
      if (totalQty === 0) { skipped++; errors.push(`sell with no open position: ${symbol} ${e.dt}`); continue; }
      const sellCommissionShare = e.commission * (totalQty / e.qty);
      trades.push({
        symbol,
        entry_dt: entryDt,
        exit_dt: e.dt,
        quantity: totalQty,
        entry_price: costSum / totalQty,
        exit_price: e.price,
        commission: entryCommission + sellCommissionShare,
        execs: [
          { dt: entryDt, side: 'BUY',  qty: totalQty, price: costSum / totalQty, commission: entryCommission },
          { dt: e.dt,    side: 'SELL', qty: totalQty, price: e.price,             commission: sellCommissionShare }
        ]
      });
    }
    for (const stillOpen of openBuys) {
      if (stillOpen.remaining <= 0) continue;
      const parsed = parseOptionDescription(symbol);
      // Synthesize an exit at SPX-cash intrinsic value if the contract has expired.
      const todayISO = new Date().toISOString().slice(0, 10);
      const isZeroDTE = parsed.expiry && parsed.expiry === stillOpen.dt.slice(0, 10);
      const expired = parsed.expiry && (parsed.expiry < todayISO || (parsed.expiry === todayISO && isZeroDTE));
      if (expired) {
        const exit_dt = `${parsed.expiry}T16:00:00`;
        const buyComm = stillOpen.commPerUnit * stillOpen.remaining;
        let exitPx = 0;
        try {
          const settle = await settlementPrice({ right: parsed.right, strike: parsed.strike, expiry: parsed.expiry });
          if (settle != null && Number.isFinite(settle)) exitPx = Math.round(settle * 100) / 100;
        } catch { /* fall back to $0 worthless */ }
        const syntheticExecs = [
          { dt: stillOpen.dt, side: 'BUY', qty: stillOpen.remaining, price: stillOpen.price, commission: buyComm }
        ];
        // If the option settled with intrinsic value, record the cash settlement
        // as a SELL execution. Without it, pnl.js (which sums executions) would
        // report only the buy cost and miss the settlement credit.
        if (exitPx > 0) {
          syntheticExecs.push({ dt: exit_dt, side: 'SELL', qty: stillOpen.remaining, price: exitPx, commission: 0 });
        }
        trades.push({
          symbol,
          entry_dt: stillOpen.dt,
          exit_dt,
          quantity: stillOpen.remaining,
          entry_price: stillOpen.price,
          exit_price: exitPx,
          commission: buyComm,
          synthetic_exit: 1,
          execs: syntheticExecs
        });
        const tag = exitPx > 0 ? `ITM settle @ $${exitPx}` : '$0 worthless';
        errors.push(`auto-closed expired: ${symbol} entry ${stillOpen.dt} → exit ${exit_dt} (${tag})`);
      } else {
        errors.push(`unclosed open buy: ${symbol} ${stillOpen.dt} qty ${stillOpen.remaining} — recorded as open trade`);
        trades.push({
          symbol,
          entry_dt: stillOpen.dt,
          exit_dt: null,
          quantity: stillOpen.remaining,
          entry_price: stillOpen.price,
          exit_price: null,
          commission: stillOpen.commPerUnit * stillOpen.remaining,
          execs: [{ dt: stillOpen.dt, side: 'BUY', qty: stillOpen.remaining, price: stillOpen.price, commission: stillOpen.commPerUnit * stillOpen.remaining }]
        });
      }
    }
  }

  // When a broker fragments a single buy across multiple closing sells at the
  // same timestamp and same price, FIFO produces N round trips that share
  // (symbol, entry_dt, exit_dt, exit_price). Snapshot the pre-existing matching
  // IDs per key once, then consume them one per duplicate. Without this, trade
  // #2 dedups against trade #1 just inserted in this batch and silently
  // overwrites it — N partial fills collapse to 1, lost trades, wrong PnL.
  const dedupKey = (t) => `${t.symbol}|${t.entry_dt}|${t.exit_dt ?? ''}|${t.exit_price ?? ''}`;
  const existingByKey = new Map();
  for (const t of trades) {
    const k = dedupKey(t);
    if (existingByKey.has(k)) continue;
    const rows = t.exit_dt == null
      ? db.prepare(`SELECT id FROM trades WHERE symbol = ? AND entry_dt = ? AND exit_dt IS NULL ORDER BY id`).all(t.symbol, t.entry_dt)
      : db.prepare(`SELECT id FROM trades WHERE symbol = ? AND entry_dt = ? AND exit_dt = ? AND ABS(COALESCE(exit_price, -99999) - ?) < 0.00005 ORDER BY id`).all(t.symbol, t.entry_dt, t.exit_dt, t.exit_price ?? 0);
    existingByKey.set(k, rows.map((r) => r.id));
  }

  const tx = db.transaction(() => {
    for (const t of trades) {
      const parsed = parseOptionDescription(t.symbol);
      const queue = existingByKey.get(dedupKey(t));
      const reuseId = queue.length ? queue.shift() : null;
      const id = reuseId ?? nextManualId();
      const exists = !!reuseId;
      insertTrade.run({
        id,
        symbol: t.symbol,
        root: parsed.root,
        expiry: parsed.expiry,
        strike: parsed.strike,
        right: parsed.right,
        direction: 'long',
        quantity: t.quantity,
        entry_dt: t.entry_dt,
        exit_dt: t.exit_dt,
        entry_price: t.entry_price,
        exit_price: t.exit_price,
        commission: t.commission,
        notes: null,
        synthetic_exit: t.synthetic_exit ? 1 : 0
      });
      clearExec.run(id);
      for (const e of t.execs) {
        insertExec.run({ trade_id: id, dt: e.dt, side: e.side, qty: e.qty, price: e.price, commission: e.commission });
      }
      if (exists) updated++; else inserted++;
    }
  });
  tx();
  return { inserted, updated, skipped, errors: errors.slice(0, 20), mode: 'tape' };
}
