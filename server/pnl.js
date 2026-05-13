// PnL computed from execution ladder when available, otherwise from
// the trade's entry/exit/quantity/commission fields.
// Options contract multiplier = 100.

const MULTIPLIER = 100;

export function computeTradePnl(trade, executions = []) {
  if (executions && executions.length > 0) {
    let cash = 0;
    let commission = 0;
    for (const e of executions) {
      const sign = e.side === 'SELL' ? 1 : -1;
      cash += sign * e.qty * e.price * MULTIPLIER;
      commission += e.commission || 0;
    }
    const grossPnl = cash;
    const netPnl = cash + commission; // commission is already negative
    return { gross_pnl: round2(grossPnl), net_pnl: round2(netPnl), commission: round2(commission) };
  }

  if (trade.exit_price == null) {
    return { gross_pnl: null, net_pnl: null, commission: trade.commission || 0 };
  }
  const dir = trade.direction === 'short' ? -1 : 1;
  const gross = dir * (trade.exit_price - trade.entry_price) * trade.quantity * MULTIPLIER;
  const net = gross + (trade.commission || 0);
  return { gross_pnl: round2(gross), net_pnl: round2(net), commission: trade.commission || 0 };
}

export function entryCost(trade) {
  return Math.abs(trade.entry_price * trade.quantity * MULTIPLIER);
}

export function durationMinutes(trade) {
  if (!trade.exit_dt) return null;
  const a = new Date(trade.entry_dt + 'Z').getTime();
  const b = new Date(trade.exit_dt + 'Z').getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, (b - a) / 60000);
}

function round2(n) { return Math.round(n * 100) / 100; }

// Enrich a list of trades with computed pnl, pct, duration.
// Uses one batched executions query to avoid N+1.
export function enrichTrades(trades, executionsByTrade) {
  return trades.map((t) => {
    const execs = executionsByTrade ? executionsByTrade.get(t.id) || [] : [];
    const { gross_pnl, net_pnl, commission } = computeTradePnl(t, execs);
    const cost = entryCost(t);
    const pct = net_pnl != null && cost > 0 ? round2((net_pnl / cost) * 100) : null;
    return {
      ...t,
      synthetic_exit: !!t.synthetic_exit,
      gross_pnl,
      net_pnl,
      commission,
      pnl_pct: pct,
      duration_min: durationMinutes(t),
      entry_cost: round2(cost)
    };
  });
}
