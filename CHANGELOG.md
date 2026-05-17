# Changelog

## Unreleased (master)

Comparing against the prior published commit `45a1dca` ("dashboards: X-axis
toggle, RTH/ETH filter, ET→CT fix, scenario impact, share cards").

### New

- **Trade Doctor** (`/doctor`) — objective evaluation of trading decisions,
  not account performance. One input: your typical dollar risk per trade.
  - **State-vs-baseline ladder.** Four calendar-day windows side by side
    (5d / 10d / 30d / 90d), each showing profit factor, daily-R and
    per-trade expectancy, win rate, cum R, and trade count. Reads
    left-to-right as a "what I just did → who I am right now → recent
    pattern → long-run pattern" story.
  - **Date-range filter.** From/To inputs plus quick-range chips
    (7d / 30d / 90d / 1y / All). Every graded metric on the page recomputes
    against the filtered trade set.
  - **Five graded category composites** with descriptions: Edge Quality,
    Risk-Adjusted Return, Drawdown & Curve, Discipline, Consistency.
    Sub-metric breakdown on each category card.
  - **Trajectory modifier** (`↑↑ / ↑ / → / ↓ / ↓↓`) computed from
    10-day vs 30-day category scores. The headline diagnostic is
    trajectory-aware — when trajectory is positive AND a strength
    finding fires, the strength leads instead of the historical weakness.
  - **Diagnostic rules engine.** Top 2–4 findings ranked by impact and
    trajectory: recent turnaround (vs short and long baselines), edge
    compression, expectancy/curve sign mismatch, discipline strength,
    time-of-day weakness, drawdown with temporal framing, win-rate-vs-
    payoff skew, sharpe-with-giveback.
  - **Outlier hygiene.** Trades with `|net_pnl / R| > 50` are excluded
    up front and surfaced in a warning banner (id, symbol, date, PnL,
    R-multiple). One bad-data row can't silently poison your grades.
  - **Time-of-day heatmap.** 30-minute buckets with per-bucket trade
    counts; buckets with fewer than 5 trades dim so single-trade
    "patterns" don't look real.
  - **Long-term rolling charts.** PF on 5d / 10d / 30d; R-Sharpe on
    5d / 10d / 30d with trade-count gating on the short windows;
    cumulative R with linear-fit overlay; rolling 30-day edge
    concentration.
  - **Tier gating.** Always-on, intraday, weekly, monthly, long-term —
    cards only appear once you have enough data to evaluate them.

### Fixed

- **Phantom PnL on open positions with executions** (`server/pnl.js`).
  A trade with at least one BUY execution but no matching SELL was
  returning the BUY's cash outlay as `net_pnl`. A 9-contract MES BUY
  at $7,510.75 produced a fake `−$6,759,675` "PnL" that propagated
  into every aggregate. Fix: `computeTradePnl` now compares total
  bought vs sold quantity and returns `net_pnl: null` when they
  don't reconcile, matching the existing contract that PnL is
  non-null only for closed round-trips.
