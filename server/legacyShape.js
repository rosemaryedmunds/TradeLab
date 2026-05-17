// Returns trades in the exact shape the legacy dashboards consume.
// The old HTML reads `<script id="trade-data" type="application/json">` and
// expects fields: id, seq, symbol, root, expiry, strike, right, direction,
// quantity, entry_dt, exit_dt, entry_date, exit_date, entry_time, exit_time,
// entry_price, exit_price, entry_gross_cost, exit_gross_proceeds, gross_pnl,
// net_pnl, pnl_pct, duration_min, fee_drag, costs, total_commission,
// synthetic_exit, source_rows, execution_ladder[...], cum_pnl, drawdown,
// round_trip_id

import { db } from './db.js';

// Options use a flat $100/contract multiplier. Futures use a per-root
// dollar-per-point multiplier; the table below covers the common micros and
// fulls. Anything not in FUTURES_MULT is treated as an option contract.
const OPT_MULT = 100;
const FUTURES_MULT = {
  ES: 50, MES: 5,
  NQ: 20, MNQ: 2,
  RTY: 50, M2K: 5,
  YM: 5,  MYM: 0.5,
  CL: 1000, MCL: 100,
  GC: 100,  MGC: 10,
  SI: 5000, SIL: 1000,
  ZN: 1000, ZB: 1000,
};
// Default user-facing "base value" per contract — the denominator for PnL %.
// Approximates working margin so % returns on futures are comparable to
// option-strategy % returns. Users override via the dashboard's futures-base
// editor; this is just the seed value.
const FUTURES_BASE_DEFAULT = {
  ES: 1000, MES: 100,
  NQ: 1000, MNQ: 100,
  RTY: 1000, M2K: 100,
  YM: 500,  MYM: 50,
  CL: 1000, MCL: 100,
  GC: 1500, MGC: 150,
};
function tradeMult(root) {
  return Object.prototype.hasOwnProperty.call(FUTURES_MULT, root) ? FUTURES_MULT[root] : OPT_MULT;
}
function isFuturesRoot(root) {
  return Object.prototype.hasOwnProperty.call(FUTURES_MULT, root);
}
function futuresBaseValue(root) {
  return FUTURES_BASE_DEFAULT[root] != null ? FUTURES_BASE_DEFAULT[root] : 500;
}

const toLegacyDt = (iso) => iso ? iso.replace('T', ' ') : null;
const dateOnly = (iso) => iso ? iso.slice(0, 10) : null;
const r = (n, p = 5) => n == null ? null : Math.round(n * 10 ** p) / 10 ** p;

export function legacyTrades({ includeOpen = false } = {}) {
  // The legacy dashboards (/, /csv, /today) expect closed round trips only —
  // their date/PF math chokes on null exit_dt. Open positions surface on /trades.
  const where = includeOpen ? '' : `WHERE exit_dt IS NOT NULL`;
  const trades = db.prepare(`SELECT * FROM trades ${where} ORDER BY entry_dt`).all();
  if (!trades.length) return [];
  const execs = db.prepare(
    `SELECT e.* FROM executions e JOIN trades t ON t.id = e.trade_id
      ORDER BY e.trade_id, e.dt`
  ).all();
  const execByTrade = new Map();
  for (const e of execs) {
    if (!execByTrade.has(e.trade_id)) execByTrade.set(e.trade_id, []);
    execByTrade.get(e.trade_id).push(e);
  }

  // First pass: compute per-trade gross/net/pct from executions when present.
  const out = trades.map((t, i) => {
    const ladder = execByTrade.get(t.id) || [];
    const MULT = tradeMult(t.root);                 // 100 for options, $/pt for futures
    const isFut = isFuturesRoot(t.root);
    let cash = 0, commission = 0;
    let buyQty = 0, buyValue = 0, sellQty = 0, sellValue = 0;
    let entry_dt = t.entry_dt, exit_dt = t.exit_dt;
    let entry_price = t.entry_price, exit_price = t.exit_price;
    const ladderOut = [];

    if (ladder.length) {
      for (const e of ladder) {
        const sign = e.side === 'SELL' ? 1 : -1;
        const proceeds = sign * e.qty * e.price * MULT;
        const netcash  = proceeds + (e.commission || 0);
        cash += proceeds;
        commission += (e.commission || 0);
        if (e.side === 'BUY')  { buyQty  += e.qty; buyValue  += e.qty * e.price; }
        else                   { sellQty += e.qty; sellValue += e.qty * e.price; }
        let fifo_pnl = 0;
        if (e.side === 'SELL' && buyQty > 0) {
          const avgBuy = buyValue / buyQty;
          fifo_pnl = (e.price - avgBuy) * e.qty * MULT;
        }
        ladderOut.push({
          dt: toLegacyDt(e.dt),
          side: e.side,
          qty: e.side === 'SELL' ? -e.qty : e.qty,
          price: e.price,
          proceeds: r(proceeds),
          commission: r(e.commission || 0),
          netcash: r(netcash),
          fifo_pnl: r(fifo_pnl)
        });
      }
      entry_price = buyQty > 0 ? buyValue / buyQty : t.entry_price;
      exit_price  = sellQty > 0 ? sellValue / sellQty : t.exit_price;
    }

    const dir = t.direction === 'short' ? -1 : 1;
    const grossFromPrices = t.exit_price != null
      ? dir * (t.exit_price - t.entry_price) * t.quantity * MULT
      : null;

    const gross_pnl = ladder.length ? r(cash) : (grossFromPrices != null ? r(grossFromPrices) : null);
    const net_pnl   = ladder.length ? r(cash + commission)
                    : (grossFromPrices != null ? r(grossFromPrices + (t.commission || 0)) : null);

    // Futures: PnL % uses a per-contract "base value" (proxy for working
    // margin) instead of the full notional, otherwise a $5/pt move on 9 MES
    // contracts dilutes to ~0% against a $6.75M notional denominator. The
    // server bakes a default; the client lets the user override it via a
    // small editor (persisted in localStorage) and recomputes pnl_pct on
    // the fly.
    const entry_gross_cost = isFut
      ? r(futuresBaseValue(t.root) * t.quantity)
      : r(Math.abs(entry_price) * t.quantity * MULT);
    const exit_gross_proceeds  = exit_price != null
      ? (isFut ? r(futuresBaseValue(t.root) * t.quantity)
               : r(Math.abs(exit_price) * t.quantity * MULT))
      : null;

    const pnl_pct = net_pnl != null && entry_gross_cost > 0
      ? r((net_pnl / entry_gross_cost) * 100, 5) : null;

    let duration_min = null;
    if (exit_dt) {
      const a = Date.parse(entry_dt + 'Z'), b = Date.parse(exit_dt + 'Z');
      if (!Number.isNaN(a) && !Number.isNaN(b)) duration_min = (b - a) / 60000;
    }

    const totalCommission = ladder.length ? r(commission) : r(t.commission || 0);

    return {
      id: t.id,
      seq: i + 1,
      symbol: t.symbol,
      root: t.root,
      expiry: t.expiry,
      strike: t.strike,
      right: t.right,
      direction: t.direction,
      quantity: t.quantity,
      entry_dt: toLegacyDt(entry_dt),
      exit_dt: toLegacyDt(exit_dt),
      entry_date: dateOnly(entry_dt),
      exit_date:  dateOnly(exit_dt),
      entry_time: toLegacyDt(entry_dt),
      exit_time:  toLegacyDt(exit_dt),
      entry_price: r(entry_price),
      exit_price: exit_price != null ? r(exit_price) : null,
      entry_gross_cost,
      exit_gross_proceeds,
      gross_pnl,
      net_pnl,
      pnl_pct,
      duration_min: duration_min != null ? r(duration_min) : null,
      fee_drag: totalCommission,
      costs: totalCommission,
      total_commission: totalCommission,
      synthetic_exit: !!t.synthetic_exit,
      source_rows: ladder.length || 2,
      execution_ladder: ladderOut,
      cum_pnl: 0,
      drawdown: 0,
      round_trip_id: t.id,
      // Futures metadata so the client can recompute % against a user-set
      // base value. Multiplier is the $/pt the server already applied to
      // net_pnl/gross_pnl; the client should NOT re-multiply.
      is_futures: isFut,
      contract_mult: MULT,
      base_value_default: isFut ? futuresBaseValue(t.root) : null
    };
  });

  // Second pass: cum_pnl and drawdown in exit-time order, then re-attach by id.
  const byId = new Map(out.map(t => [t.id, t]));
  const exitOrdered = [...out].sort((a, b) => {
    const ea = a.exit_dt || a.entry_dt || '';
    const eb = b.exit_dt || b.entry_dt || '';
    return ea.localeCompare(eb);
  });
  let cum = 0, peak = 0;
  for (const t of exitOrdered) {
    cum += t.net_pnl || 0;
    peak = Math.max(peak, cum);
    byId.get(t.id).cum_pnl = r(cum);
    byId.get(t.id).drawdown = r(cum - peak);
  }

  return out;
}
