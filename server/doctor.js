// server/doctor.js
//
// Trade Doctor — evaluates the *quality of decisions* (not account performance)
// using letter grades. Pure functions; no DB / Express dependencies. The caller
// (server/index.js) hands us enriched trades + the user's R-value.
//
// Datetime convention follows the rest of the app: `entry_dt` and `exit_dt`
// are stored in Eastern Time (IBKR export shape). For trading-day / week /
// month bucketing we use the ET date portion (slice(0,10)) directly, which
// matches dayKey() in server/index.js.

// ----------------------------------------------------------------------------
// CONFIG  (review-approved; tune from here without touching logic)
// ----------------------------------------------------------------------------

const SCORES = {
  'A+': 97, 'A': 93, 'A-': 90,
  'B+': 87, 'B': 83, 'B-': 80,
  'C+': 77, 'C': 73, 'C-': 70,
  'D+': 67, 'D': 63, 'D-': 60,
  'F':  50,
};

// dir = 'high' (higher is better) or 'low' (lower is better).
// tiers: ordered top-to-bottom. For 'high' each threshold is a lower bound; for
// 'low' each is an upper bound. F's threshold is the open end (±Infinity).
const BANDS = {
  // ----- from spec -----
  profit_factor:        { dir: 'high', tiers: [['A+', 2.5], ['A', 2.0], ['B', 1.6], ['C', 1.3], ['D', 1.1], ['F', -Infinity]] },
  // Expectancy is graded on a DAILY-R basis, not per-trade. A scalper at
  // +0.11R/trade with 30 trades/day produces +3.3R/day (A+); a swing trader
  // at the same per-trade number produces +0.55R/day (B). Grading on per-day
  // R makes the score frequency-agnostic. Per-trade R is displayed alongside
  // for context (see snapshots.expectancy_r_per_trade).
  expectancy_r:         { dir: 'high', tiers: [['A+', 2.0], ['A', 1.0], ['B', 0.5], ['C', 0.25], ['D', 0], ['F', -Infinity]] },
  r_sharpe:             { dir: 'high', tiers: [['A+', 3.0], ['A', 2.0], ['B', 1.5], ['C', 1.0], ['D', 0.5], ['F', -Infinity]] },
  r_calmar:             { dir: 'high', tiers: [['A+', 3.0], ['A', 2.0], ['B', 1.0], ['C', 0.5], ['D', 0.25],['F', -Infinity]] },
  gain_to_pain:         { dir: 'high', tiers: [['A+', 2.0], ['A', 1.5], ['B', 1.0], ['C', 0.5], ['D', 0.25],['F', -Infinity]] },
  max_r_drawdown:       { dir: 'low',  tiers: [['A+', 5],   ['A', 10],  ['B', 15],  ['C', 25],  ['D', 40],  ['F', Infinity]] },
  closed_trade_giveback:{ dir: 'low',  tiers: [['A+',0.10], ['A',0.20], ['B',0.35], ['C',0.50], ['D',0.70], ['F', Infinity]] },
  largest_loss_vs_win:  { dir: 'low',  tiers: [['A+', 0.5], ['A', 0.75],['B', 1.0], ['C', 1.5], ['D', 2.0], ['F', Infinity]] },
  pct_profitable_days:  { dir: 'high', tiers: [['A+',0.70], ['A',0.60], ['B',0.55], ['C',0.50], ['D',0.45], ['F', -Infinity]] },
  pct_profitable_weeks: { dir: 'high', tiers: [['A+',0.75], ['A',0.65], ['B',0.55], ['C',0.50], ['D',0.45], ['F', -Infinity]] },
  pct_profitable_months:{ dir: 'high', tiers: [['A+',0.80], ['A',0.70], ['B',0.60], ['C',0.50], ['D',0.40], ['F', -Infinity]] },

  // ----- HEURISTIC (not in user spec; one-line justification each) -----
  // Win rate informational; bands match the spec's day/week pattern.
  win_rate:             { dir: 'high', tiers: [['A+',0.65], ['A',0.55], ['B',0.50], ['C',0.45], ['D',0.40], ['F', -Infinity]] },
  // Payoff: 1.0 = breakeven at 50% wr; >2.0 elite, <0.8 weak.
  payoff_ratio:         { dir: 'high', tiers: [['A+', 2.0], ['A', 1.5], ['B', 1.2], ['C', 1.0], ['D', 0.8], ['F', -Infinity]] },
  // Recovery factor = total R / |max R DD|. >5 elite (Schwager).
  recovery_factor:      { dir: 'high', tiers: [['A+', 5.0], ['A', 3.0], ['B', 2.0], ['C', 1.0], ['D', 0.5], ['F', -Infinity]] },
  // Sortino runs ~1.4× Sharpe; bands shifted up vs r_sharpe.
  r_sortino:            { dir: 'high', tiers: [['A+', 4.0], ['A', 2.5], ['B', 2.0], ['C', 1.3], ['D', 0.7], ['F', -Infinity]] },
  // Equity curve R² — REBANDED per review.
  equity_r2:            { dir: 'high', tiers: [['A+',0.80], ['A',0.65], ['B',0.50], ['C',0.35], ['D',0.20], ['F', -Infinity]] },
  // Edge concentration = top-10%-by-PnL ÷ total PnL. Healthy ~30–50%; >70% thin.
  edge_concentration:   { dir: 'low',  tiers: [['A+',0.30], ['A',0.45], ['B',0.55], ['C',0.65], ['D',0.75], ['F', Infinity]] },
  // Largest loss vs avg daily win = how many good days one bad trade eats.
  loss_vs_daily_win:    { dir: 'low',  tiers: [['A+', 0.5], ['A', 1.0], ['B', 1.5], ['C', 2.5], ['D', 4.0], ['F', Infinity]] },
  // Weekly give-back: tighter than closed-trade because weekly peaks are realized.
  weekly_giveback:      { dir: 'low',  tiers: [['A+',0.10], ['A',0.20], ['B',0.30], ['C',0.45], ['D',0.60], ['F', Infinity]] },
  // Weekly PF coefficient of variation: stdev/mean. Lower = stabler.
  pf_cov:               { dir: 'low',  tiers: [['A+',0.20], ['A',0.35], ['B',0.55], ['C',0.80], ['D',1.20], ['F', Infinity]] },
};

// Category & sub-weights. Within each category, missing metrics are skipped
// and remaining sub-weights re-normalize to keep proportions correct.
const CATEGORIES = {
  edge_quality: {
    weight: 0.20,
    label: 'Edge Quality',
    description: 'Are your trades profitable in expectation? Blends profit factor, expectancy in R, and the win-rate × payoff balance.',
    metrics: { profit_factor: 0.40, expectancy_r: 0.40, win_payoff: 0.20 },
  },
  risk_adjusted: {
    weight: 0.25,
    label: 'Risk-Adjusted Return',
    description: 'Return per unit of risk taken — Sharpe, Calmar, and Sortino computed on daily R-multiples.',
    metrics: { r_sharpe: 0.40, r_calmar: 0.30, r_sortino: 0.30 },
  },
  drawdown_curve: {
    // Ulcer Index dropped from v1; its 0.20 redistributed per review.
    weight: 0.15,
    label: 'Drawdown & Curve',
    description: 'How smooth is your equity growth? Worst drawdown, recovery factor, and linearity of the cumulative-R curve.',
    metrics: { max_r_drawdown: 0.45, recovery_factor: 0.25, equity_r2: 0.30 },
  },
  discipline: {
    weight: 0.25,
    label: 'Discipline',
    description: 'How well do you protect profits? Give-back ratios, single-trade loss controls, and edge concentration.',
    metrics: {
      weekly_giveback:        0.25,
      closed_trade_giveback:  0.12,
      largest_loss_vs_win:    0.22,
      loss_vs_daily_win:      0.16,
      edge_concentration:     0.25,
    },
  },
  consistency: {
    weight: 0.15,
    label: 'Consistency',
    description: 'How often do you produce green days, weeks, and months? Penalizes lumpy, all-or-nothing returns.',
    metrics: {
      pct_profitable_days:    0.30,
      pct_profitable_weeks:   0.30,
      pct_profitable_months:  0.20,
      pf_cov:                 0.20,
    },
  },
};

// Trust gates — if false, the card renders the value but suppresses the letter
// grade (shown as "—") and the metric is dropped from category scoring.
const TRUST_GATES = {
  closed_trade_giveback: (counts) =>
    counts.green_days >= 5 && (counts.avg_closed_trades_per_green_day || 0) >= 5,
  pf_cov: (counts) => counts.full_weeks >= 4,
};

const TRAJECTORY = {
  up_threshold: 5,
  down_threshold: -5,
};

const DOCTOR_CONFIG = { SCORES, BANDS, CATEGORIES, TRUST_GATES, TRAJECTORY };

// ----------------------------------------------------------------------------
// Grading helpers
// ----------------------------------------------------------------------------

function gradeMetric(metricKey, value) {
  if (value == null || !Number.isFinite(value)) return null;
  const b = BANDS[metricKey];
  if (!b) return null;
  for (const [letter, threshold] of b.tiers) {
    if (b.dir === 'high' ? value >= threshold : value <= threshold) {
      return { letter, score: SCORES[letter] };
    }
  }
  return { letter: 'F', score: SCORES.F };
}

function letterFromScore(score) {
  if (score == null || !Number.isFinite(score)) return null;
  // Pick the nearest letter from SCORES.
  let best = 'F', bestDist = Infinity;
  for (const [letter, s] of Object.entries(SCORES)) {
    const d = Math.abs(s - score);
    if (d < bestDist) { bestDist = d; best = letter; }
  }
  return best;
}

// ----------------------------------------------------------------------------
// Date / period helpers (all keyed off the ET date portion of entry_dt)
// ----------------------------------------------------------------------------

const dayKey   = (t) => (t.entry_dt || '').slice(0, 10);
const monthKey = (dateStr) => dateStr.slice(0, 7);

function weekKey(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();              // 0=Sun..6=Sat
  const offset = dow === 0 ? -6 : 1 - dow; // shift to Monday
  dt.setUTCDate(dt.getUTCDate() + offset);
  return dt.toISOString().slice(0, 10);
}

function weekdayIdx(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function daysBetween(aStr, bStr) {
  const a = Date.parse(aStr + 'T00:00:00Z');
  const b = Date.parse(bStr + 'T00:00:00Z');
  return Math.round((b - a) / 86400_000);
}

// ----------------------------------------------------------------------------
// Stats primitives
// ----------------------------------------------------------------------------

const sum = (arr) => arr.reduce((s, x) => s + x, 0);
const mean = (arr) => arr.length ? sum(arr) / arr.length : null;

function stdev(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  return Math.sqrt(sum(arr.map(x => (x - m) ** 2)) / (arr.length - 1));
}

// Downside deviation vs threshold 0: sqrt(sum(min(0,x)^2) / N).
function downsideStdev(arr) {
  if (arr.length < 2) return null;
  const neg = arr.map(x => x < 0 ? x : 0);
  return Math.sqrt(sum(neg.map(x => x * x)) / arr.length);
}

function linregR2(ys) {
  const n = ys.length;
  if (n < 3) return null;
  const xMean = (n - 1) / 2;
  const yMean = mean(ys);
  let num = 0, dx2 = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (ys[i] - yMean);
    dx2 += (i - xMean) ** 2;
  }
  if (dx2 === 0) return null;
  const slope = num / dx2;
  const intercept = yMean - slope * xMean;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    const yhat = slope * i + intercept;
    ssRes += (ys[i] - yhat) ** 2;
    ssTot += (ys[i] - yMean) ** 2;
  }
  if (ssTot === 0) return null;
  return { r2: 1 - ssRes / ssTot, slope, intercept };
}

function linregSlope(ys) {
  const r = linregR2(ys);
  return r ? r.slope : null;
}

// Coefficient of variation. Always non-negative (we use the mean's absolute
// value to keep the metric defined when the series straddles zero).
function coefficientOfVariation(arr) {
  const sd = stdev(arr);
  const m = mean(arr);
  if (sd == null || m == null || m === 0) return null;
  return sd / Math.abs(m);
}

// Profit factor for an array of trade-level PnL numbers.
function profitFactor(pnls) {
  let gp = 0, gl = 0;
  for (const p of pnls) { if (p > 0) gp += p; else if (p < 0) gl += -p; }
  if (gl === 0) return gp > 0 ? Infinity : null;
  return gp / gl;
}

// ----------------------------------------------------------------------------
// Core derived series
// ----------------------------------------------------------------------------

// Group trades by ET date, sort chronologically within day, and build:
//   { date, trades:[...], dayClose, dayPeak (cum max through day), dayR }
function buildDailySeries(trades, rValue) {
  const byDay = new Map();
  for (const t of trades) {
    if (t.net_pnl == null) continue;
    const d = dayKey(t);
    if (!d) continue;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(t);
  }
  const out = [];
  for (const [date, group] of [...byDay].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sorted = [...group].sort((a, b) => (a.entry_dt || '').localeCompare(b.entry_dt || ''));
    let cum = 0, peak = 0;
    for (const t of sorted) { cum += t.net_pnl; if (cum > peak) peak = cum; }
    out.push({
      date,
      trades: sorted,
      tradeCount: sorted.length,
      dayClose: cum,
      dayPeak: peak,
      dayR: cum / rValue,
    });
  }
  return out;
}

// Group daily rows into weeks; build per-week peak cum vs close.
function buildWeeklySeries(daily) {
  const byWeek = new Map();
  for (const d of daily) {
    const k = weekKey(d.date);
    if (!byWeek.has(k)) byWeek.set(k, []);
    byWeek.get(k).push(d);
  }
  const out = [];
  for (const [weekStart, days] of [...byWeek].sort((a, b) => a[0].localeCompare(b[0]))) {
    let cum = 0, peak = 0;
    const pnls = [];
    for (const d of days) {
      cum += d.dayClose;
      if (cum > peak) peak = cum;
      for (const t of d.trades) pnls.push(t.net_pnl);
    }
    out.push({
      weekStart,
      days,
      dayCount: days.length,
      tradeCount: pnls.length,
      weekClose: cum,
      weekPeak: peak,
      profitFactor: profitFactor(pnls),
    });
  }
  return out;
}

function buildMonthlySeries(daily, rValue) {
  const byMonth = new Map();
  for (const d of daily) {
    const k = monthKey(d.date);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(d);
  }
  const out = [];
  for (const [month, days] of [...byMonth].sort((a, b) => a[0].localeCompare(b[0]))) {
    const totalR = sum(days.map(d => d.dayR));
    const totalPnl = sum(days.map(d => d.dayClose));
    out.push({ month, dayCount: days.length, totalR, totalPnl });
  }
  return out;
}

// ----------------------------------------------------------------------------
// Individual metric functions
// Each returns either a number, or null if not enough data.
// ----------------------------------------------------------------------------

function calcProfitFactor(trades) { return profitFactor(trades.map(t => t.net_pnl || 0)); }

function calcWinRate(trades) {
  let w = 0, n = 0;
  for (const t of trades) {
    if (t.net_pnl == null) continue;
    n++; if (t.net_pnl > 0) w++;
  }
  return n ? w / n : null;
}

function calcPayoffRatio(trades) {
  const wins = trades.filter(t => t.net_pnl > 0).map(t => t.net_pnl);
  const losses = trades.filter(t => t.net_pnl < 0).map(t => -t.net_pnl);
  if (!wins.length || !losses.length) return null;
  const aw = mean(wins), al = mean(losses);
  if (!al) return null;
  return aw / al;
}

// Per-trade expectancy in R — informational/displayed but not graded.
function calcPerTradeExpectancyR(trades, rValue) {
  const rs = trades.filter(t => t.net_pnl != null).map(t => t.net_pnl / rValue);
  return rs.length ? mean(rs) : null;
}
// Daily expectancy in R — the graded value. Total R divided by trading days.
function calcDailyExpectancyR(daily) {
  if (!daily.length) return null;
  return sum(daily.map(d => d.dayR)) / daily.length;
}

function calcLargestLossVsWin(trades) {
  const pnls = trades.map(t => t.net_pnl).filter(v => v != null);
  if (!pnls.length) return null;
  const maxWin = Math.max(...pnls);
  const maxLoss = Math.min(...pnls);
  if (maxWin <= 0 || maxLoss >= 0) return null;
  return Math.abs(maxLoss) / maxWin;
}

function calcLargestLossVsAvgDailyWin(trades, daily) {
  const pnls = trades.map(t => t.net_pnl).filter(v => v != null);
  if (!pnls.length) return null;
  const maxLoss = Math.min(...pnls);
  if (maxLoss >= 0) return null;
  const greenDayCloses = daily.filter(d => d.dayClose > 0).map(d => d.dayClose);
  const avgGreen = mean(greenDayCloses);
  if (!avgGreen) return null;
  return Math.abs(maxLoss) / avgGreen;
}

// Closed-trade give-back (per spec, with the trust gate the user approved).
// Ratio = average over green days of (peak - close) / peak.
function calcClosedTradeGiveback(daily) {
  const green = daily.filter(d => d.dayClose > 0 && d.dayPeak > 0);
  if (!green.length) return { value: null, green_days: 0, avg_closed_trades_per_green_day: 0 };
  const ratios = green.map(d => (d.dayPeak - d.dayClose) / d.dayPeak);
  const avgTrades = mean(green.map(d => d.tradeCount));
  return {
    value: mean(ratios),
    green_days: green.length,
    avg_closed_trades_per_green_day: avgTrades,
  };
}

function calcWeeklyGiveback(weekly) {
  const green = weekly.filter(w => w.weekClose > 0 && w.weekPeak > 0);
  if (!green.length) return null;
  return mean(green.map(w => (w.weekPeak - w.weekClose) / w.weekPeak));
}

// Edge concentration = sum of top-10% trades' PnL ÷ total PnL.
// Undefined when:
//   - total ≤ 0  (your edge isn't generating PnL — denominator nonsensical)
//   - topSum/total > 1.0  (bottom 90% is net negative, so top-10% overshoots
//     the total — the "% of edge" interpretation breaks)
// In both cases we return null and the card displays "—" + a tooltip note.
function calcEdgeConcentration(trades) {
  const pnls = trades.map(t => t.net_pnl).filter(v => v != null);
  if (pnls.length < 10) return null;
  const total = sum(pnls);
  if (total <= 0) return null;
  const sorted = [...pnls].sort((a, b) => b - a);
  const topN = Math.max(1, Math.floor(sorted.length * 0.10));
  const topSum = sum(sorted.slice(0, topN));
  const ratio = topSum / total;
  if (!(ratio >= 0 && ratio <= 1)) return null;
  return ratio;
}

function calcPctProfitableDays(daily) {
  if (!daily.length) return null;
  const green = daily.filter(d => d.dayClose > 0).length;
  return green / daily.length;
}

function calcPctProfitableWeeks(weekly) {
  if (!weekly.length) return null;
  return weekly.filter(w => w.weekClose > 0).length / weekly.length;
}

function calcPctProfitableMonths(monthly) {
  if (!monthly.length) return null;
  return monthly.filter(m => m.totalPnl > 0).length / monthly.length;
}

function calcBestWorstWeekday(daily) {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const buckets = Array.from({ length: 7 }, (_, i) => ({ idx: i, name: names[i], net: 0, days: 0 }));
  for (const d of daily) {
    const i = weekdayIdx(d.date);
    buckets[i].net += d.dayClose;
    buckets[i].days++;
  }
  const populated = buckets.filter(b => b.days > 0);
  if (!populated.length) return null;
  for (const b of populated) b.avg = b.net / b.days;
  populated.sort((a, b) => b.avg - a.avg);
  return { best: populated[0], worst: populated[populated.length - 1], all: populated };
}

// --- Timezone contract for entry_dt / exit_dt ---
// CLAUDE.md historically claimed times were stored in Eastern (per the legacy
// dashboard's parseSourceMs() with SOURCE_TZ='America/New_York'). The actual
// imported data tells a different story: IBKR Flex Queries and Webull both
// export in the user's configured local TZ, not New York, and that's what
// landed in the DB. We treat stored times as wall-clock in BUCKET_TZ below.
//
// If a future import source is known to deliver true-ET times, the fix is
// per-trade tagging at import (a `source_tz` column) — not a global flip here.
const BUCKET_TZ_LABEL = 'CT';
const STORED_TZ_OFFSET_TO_BUCKET_HOURS = 0; // stored times are already wall-clock
                                            // in the user's local TZ — no shift.

// Time-of-day cumulative PnL by 30-min bucket. Stored hour is used directly.
// Returns null if no trades have entry_dt.
// Defensive guards added after a pnl.js bug produced -$6.7M on a single
// unmatched-execution trade. The fix is upstream; these checks stay as belt-
// and-braces so a similar regression can't silently poison the heatmap again.
function calcTimeOfDayBuckets(trades) {
  const buckets = new Map(); // key 'HH:MM' (CT, 30-min)
  const TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
  const OUTLIER_ABS = 50_000; // $50K on a single trade is far past anything plausible
  let outliers = 0;
  for (const t of trades) {
    if (!t.entry_dt || !TS_RE.test(t.entry_dt)) continue;
    const pnl = Number(t.net_pnl);
    if (!Number.isFinite(pnl)) continue;
    if (Math.abs(pnl) > OUTLIER_ABS) { outliers++; continue; }
    const hhStored = parseInt(t.entry_dt.slice(11, 13), 10);
    const mmStored = parseInt(t.entry_dt.slice(14, 16), 10);
    if (Number.isNaN(hhStored) || Number.isNaN(mmStored)) continue;
    const hhBucket = ((hhStored + STORED_TZ_OFFSET_TO_BUCKET_HOURS) % 24 + 24) % 24;
    const bucketMin = mmStored < 30 ? 0 : 30;
    const key = `${String(hhBucket).padStart(2, '0')}:${String(bucketMin).padStart(2, '0')}`;
    const cur = buckets.get(key) || { net: 0, count: 0 };
    cur.net += pnl;
    cur.count += 1;
    buckets.set(key, cur);
  }
  if (!buckets.size) return null;
  const cells = [...buckets].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([time, v]) => ({ time, net: v.net, count: v.count }));
  return { cells, outliers_excluded: outliers, tz_label: BUCKET_TZ_LABEL };
}

// Max drawdown on a cumulative series (positive number = magnitude of DD).
function maxDrawdown(cumSeries) {
  let peak = -Infinity, dd = 0;
  for (const v of cumSeries) {
    if (v > peak) peak = v;
    if (peak - v > dd) dd = peak - v;
  }
  return dd;
}

// Returns the date at which the max drawdown bottomed (worst trough date).
// Used by the temporally-framed large-drawdown rule.
function findMaxDrawdownEndDate(daily) {
  if (!daily.length) return null;
  let cum = 0, peak = -Infinity, dd = 0, endDate = null;
  for (const d of daily) {
    cum += d.dayR;
    if (cum > peak) peak = cum;
    if (peak - cum > dd) { dd = peak - cum; endDate = d.date; }
  }
  return endDate;
}

// Max drawdown computed only on the trailing N calendar days. Compares
// against the full-period DD to detect "current risk control is better than
// what's in the historical record."
function calcRecentMaxDrawdown(daily, windowDays) {
  if (!daily.length) return null;
  const { slice } = calendarSliceAt(daily, daily.length - 1, windowDays);
  if (slice.length < 3) return null;
  let cum = 0;
  const cumR = [];
  for (const d of slice) { cum += d.dayR; cumR.push(cum); }
  return maxDrawdown(cumR);
}

function calcMaxRDrawdown(daily) {
  if (!daily.length) return null;
  let cum = 0;
  const cumR = [];
  for (const d of daily) { cum += d.dayR; cumR.push(cum); }
  return maxDrawdown(cumR);
}

function calcRecoveryFactor(daily) {
  const totalR = sum(daily.map(d => d.dayR));
  const dd = calcMaxRDrawdown(daily);
  if (!dd) return totalR > 0 ? Infinity : null;
  return totalR / dd;
}

// Returns { r2, slope } so the slope can downgrade the grade for negative-
// trend equity curves (R² of 0.90 with negative slope = consistent bleeding,
// not consistent profit). slope is per-trading-day R units.
function calcEquityR2(daily) {
  if (daily.length < 5) return null;
  let cum = 0;
  const ys = daily.map(d => (cum += d.dayR));
  const r = linregR2(ys);
  return r ? { r2: r.r2, slope: r.slope } : null;
}

function calcRSharpe(daily) {
  const dailyR = daily.map(d => d.dayR);
  const m = mean(dailyR), s = stdev(dailyR);
  if (m == null || !s) return null;
  return (m / s) * Math.sqrt(252);
}

function calcRCalmar(daily) {
  const dailyR = daily.map(d => d.dayR);
  const m = mean(dailyR);
  const dd = calcMaxRDrawdown(daily);
  if (m == null || !dd) return null;
  const annualizedR = m * 252;
  return annualizedR / dd;
}

function calcRSortino(daily) {
  const dailyR = daily.map(d => d.dayR);
  const m = mean(dailyR), ds = downsideStdev(dailyR);
  if (m == null || !ds) return null;
  return (m / ds) * Math.sqrt(252);
}

function calcGainToPain(monthly) {
  if (!monthly.length) return null;
  const totalR = sum(monthly.map(m => m.totalR));
  const lossR = sum(monthly.filter(m => m.totalR < 0).map(m => Math.abs(m.totalR)));
  if (!lossR) return totalR > 0 ? Infinity : null;
  return totalR / lossR;
}

function calcPfCoV(weekly) {
  if (weekly.length < 4) return null;
  const pfs = weekly.map(w => w.profitFactor).filter(v => v != null && Number.isFinite(v));
  if (pfs.length < 4) return null;
  return coefficientOfVariation(pfs);
}

// ----------------------------------------------------------------------------
// Build the metrics object — one place to edit if a metric definition changes.
// ----------------------------------------------------------------------------

function buildMetrics(trades, daily, weekly, monthly, { rValue }) {
  const ctgb = calcClosedTradeGiveback(daily);
  const ctgbTrusted = TRUST_GATES.closed_trade_giveback({
    green_days: ctgb.green_days,
    avg_closed_trades_per_green_day: ctgb.avg_closed_trades_per_green_day,
  });

  const pfCovValue = calcPfCoV(weekly);
  const pfCovTrusted = TRUST_GATES.pf_cov({ full_weeks: weekly.length });

  const winRate = calcWinRate(trades);
  const payoff  = calcPayoffRatio(trades);
  const wrG = gradeMetric('win_rate', winRate);
  const poG = gradeMetric('payoff_ratio', payoff);
  // win × payoff sub-composite for Edge Quality (avoids double-counting).
  let winPayoffScore = null;
  if (wrG && poG) winPayoffScore = (wrG.score + poG.score) / 2;
  else if (wrG) winPayoffScore = wrG.score;
  else if (poG) winPayoffScore = poG.score;

  const totalR = sum(daily.map(d => d.dayR));

  // Each metric envelope: value, formatted, letter, score, trusted, explanation.
  const m = {
    profit_factor: pack('profit_factor', calcProfitFactor(trades)),
    win_rate:      pack('win_rate', winRate),
    payoff_ratio:  pack('payoff_ratio', payoff),
    win_payoff:    { value: winPayoffScore, letter: letterFromScore(winPayoffScore), score: winPayoffScore, trusted: !!winPayoffScore },
    expectancy_r:  { ...pack('expectancy_r', calcDailyExpectancyR(daily)),
                     per_trade: calcPerTradeExpectancyR(trades, rValue),
                     trades_count: trades.length,
                     days_count: daily.length },
    largest_loss_vs_win: pack('largest_loss_vs_win', calcLargestLossVsWin(trades)),
    loss_vs_daily_win:   pack('loss_vs_daily_win', calcLargestLossVsAvgDailyWin(trades, daily)),

    closed_trade_giveback: {
      ...pack('closed_trade_giveback', ctgb.value),
      trusted: ctgbTrusted,
      green_days: ctgb.green_days,
      avg_closed_trades_per_green_day: ctgb.avg_closed_trades_per_green_day,
    },
    edge_concentration:  pack('edge_concentration', calcEdgeConcentration(trades)),
    weekly_giveback:     pack('weekly_giveback', calcWeeklyGiveback(weekly)),

    pct_profitable_days:   pack('pct_profitable_days', calcPctProfitableDays(daily)),
    pct_profitable_weeks:  pack('pct_profitable_weeks', calcPctProfitableWeeks(weekly)),
    pct_profitable_months: pack('pct_profitable_months', calcPctProfitableMonths(monthly)),
    pf_cov:                { ...pack('pf_cov', pfCovValue), trusted: pfCovTrusted },

    max_r_drawdown:  pack('max_r_drawdown', calcMaxRDrawdown(daily)),
    recovery_factor: pack('recovery_factor', calcRecoveryFactor(daily)),
    equity_r2:       packEquityR2(calcEquityR2(daily)),

    r_sharpe:    pack('r_sharpe', calcRSharpe(daily)),
    r_calmar:    pack('r_calmar', calcRCalmar(daily)),
    r_sortino:   pack('r_sortino', calcRSortino(daily)),
    gain_to_pain: pack('gain_to_pain', calcGainToPain(monthly)),

    cumulative_r: totalR,
  };

  // Suppress letter+score for low-trust metrics so they don't influence scoring.
  if (m.closed_trade_giveback && !m.closed_trade_giveback.trusted) {
    m.closed_trade_giveback.letter = null;
    m.closed_trade_giveback.score = null;
  }
  if (m.pf_cov && !m.pf_cov.trusted) {
    m.pf_cov.letter = null;
    m.pf_cov.score = null;
  }

  return m;
}

function pack(key, value) {
  const g = gradeMetric(key, value);
  return {
    value,
    letter: g?.letter ?? null,
    score:  g?.score ?? null,
    trusted: g != null,
  };
}

// Equity R² gets a sign-conditioned grade: a perfectly linear DOWN curve is
// the worst outcome, not the best. If slope is negative, cap the letter at C
// (score 73) regardless of R² — "linearity" is only a virtue going up.
function packEquityR2(payload) {
  if (!payload) return { value: null, letter: null, score: null, trusted: false, slope: null, downgraded: false };
  const { r2, slope } = payload;
  const base = pack('equity_r2', r2);
  const negative = slope < 0;
  let { letter, score } = base;
  let downgraded = false;
  if (negative && score != null && score > SCORES['C']) {
    letter = 'C';
    score = SCORES['C'];
    downgraded = true;
  }
  return { ...base, letter, score, slope, downgraded };
}

// ----------------------------------------------------------------------------
// Category scoring with sub-weight renormalization
// ----------------------------------------------------------------------------

function scoreCategory(catKey, metrics) {
  const cat = CATEGORIES[catKey];
  let totalWeight = 0, weightedSum = 0;
  const breakdown = [];
  for (const [mKey, w] of Object.entries(cat.metrics)) {
    const mm = metrics[mKey];
    if (!mm || mm.score == null) { breakdown.push({ metric: mKey, weight: w, score: null }); continue; }
    weightedSum += w * mm.score;
    totalWeight += w;
    breakdown.push({ metric: mKey, weight: w, score: mm.score });
  }
  if (totalWeight === 0) return { score: null, letter: null, breakdown };
  const score = weightedSum / totalWeight;
  return { score, letter: letterFromScore(score), breakdown };
}

function scoreOverall(categoryScores) {
  let totalWeight = 0, weightedSum = 0;
  for (const [key, def] of Object.entries(CATEGORIES)) {
    const c = categoryScores[key];
    if (!c || c.score == null) continue;
    weightedSum += def.weight * c.score;
    totalWeight += def.weight;
  }
  if (totalWeight === 0) return { score: null, letter: null };
  const score = weightedSum / totalWeight;
  return { score, letter: letterFromScore(score) };
}

// ----------------------------------------------------------------------------
// Trajectory: rolling 30d vs rolling 60d category scores
// ----------------------------------------------------------------------------

function filterTradesWithinDays(trades, daily, nDays) {
  if (!daily.length) return [];
  const lastDate = daily[daily.length - 1].date;
  const minDate = (() => {
    const [y, m, d] = lastDate.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - (nDays - 1));
    return dt.toISOString().slice(0, 10);
  })();
  return trades.filter(t => {
    const k = dayKey(t);
    return k && k >= minDate && k <= lastDate;
  });
}

function categoryScoresForWindow(trades, daily, nDays, opts) {
  const sub = filterTradesWithinDays(trades, daily, nDays);
  if (sub.length < 10) return null;
  const subDaily = buildDailySeries(sub, opts.rValue);
  const subWeekly = buildWeeklySeries(subDaily);
  const subMonthly = buildMonthlySeries(subDaily, opts.rValue);
  const m = buildMetrics(sub, subDaily, subWeekly, subMonthly, opts);
  const out = {};
  for (const key of Object.keys(CATEGORIES)) out[key] = scoreCategory(key, m).score;
  return out;
}

// Trajectory direction from CATEGORY-SCORE deltas: re-score every category
// at the 10-day and 30-day windows and count up/down categories. A category
// is up if 10d score > 30d score by >5 pts; down if < -5; else stable.
// Per audit: this is a richer signal than 3 snapshot points, even though
// short-window metrics are noisier — the up_threshold filters small swings.
function buildTrajectory(trades, daily, opts) {
  const win10 = categoryScoresForWindow(trades, daily, 10, opts);
  const win30 = categoryScoresForWindow(trades, daily, 30, opts);
  const out = {
    categories: {}, up_count: 0, down_count: 0, stable_count: 0,
    window_current: 10, window_baseline: 30,
  };
  for (const key of Object.keys(CATEGORIES)) {
    const a = win10?.[key], b = win30?.[key];
    let direction = 'stable', delta = null;
    if (a != null && b != null) {
      delta = a - b;
      if (delta > TRAJECTORY.up_threshold) direction = 'up';
      else if (delta < TRAJECTORY.down_threshold) direction = 'down';
    }
    out.categories[key] = { current: a, baseline: b, delta, direction };
    if (direction === 'up') out.up_count++;
    else if (direction === 'down') out.down_count++;
    else out.stable_count++;
  }
  if (out.up_count >= 2 && out.down_count === 0) out.modifier = '↑↑';
  else if (out.down_count >= 2 && out.up_count === 0) out.modifier = '↓↓';
  else if (out.up_count > out.down_count) out.modifier = '↑';
  else if (out.down_count > out.up_count) out.modifier = '↓';
  else out.modifier = '→';
  return out;
}

// ----------------------------------------------------------------------------
// Trajectory data series (for charts)
// ----------------------------------------------------------------------------

// All rolling windows are CALENDAR DAYS, anchored at each trading day in the
// daily series. A "30-day window" at trading day D means: all trading days
// whose date is in [D - 29 calendar days, D]. This matches how traders read
// "last 30 days" on a P&L curve. Trading-day windows (sliced by index) are
// strictly more time when markets are closed and produce results that don't
// line up with the visible cumulative-PnL chart.
function calendarWindowStart(endDateStr, windowDays) {
  const [y, m, d] = endDateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - (windowDays - 1));
  return dt.toISOString().slice(0, 10);
}

// Walk each anchor index and return the calendar-day slice of `daily`.
function calendarSliceAt(daily, anchorIdx, windowDays) {
  const endDate = daily[anchorIdx].date;
  const startDate = calendarWindowStart(endDate, windowDays);
  const out = [];
  for (let j = anchorIdx; j >= 0; j--) {
    if (daily[j].date < startDate) break;
    out.unshift(daily[j]);
  }
  return { startDate, endDate, slice: out };
}

// Rolling PF on the TRADE level (gross winning trades / |gross losing trades|),
// not on daily aggregates. Daily-close PF was producing different values from
// the canonical Always-On metric for the same trade set — confusing and wrong.
function rollingProfitFactor(daily, windowDays) {
  const out = [];
  for (let i = 0; i < daily.length; i++) {
    const { slice, startDate, endDate } = calendarSliceAt(daily, i, windowDays);
    const tradePnls = [];
    for (const d of slice) {
      if (!d.trades) continue;
      for (const t of d.trades) {
        const v = Number(t.net_pnl);
        if (Number.isFinite(v)) tradePnls.push(v);
      }
    }
    const pf = profitFactor(tradePnls);
    out.push({ date: endDate, value: pf == null || !Number.isFinite(pf) ? null : pf, startDate });
  }
  return out;
}

// Rolling Sharpe; if `minTrades` is supplied, points where the window has
// fewer total trades than the threshold are emitted as null (the chart
// still renders the time axis but skips the unstable points).
function rollingSharpe(daily, windowDays, opts = {}) {
  const minTrades = opts.minTrades || 0;
  const out = [];
  for (let i = 0; i < daily.length; i++) {
    const { slice, startDate, endDate } = calendarSliceAt(daily, i, windowDays);
    const trades = slice.reduce((s, d) => s + (d.tradeCount || 0), 0);
    if (slice.length < 5 || trades < minTrades) { out.push({ date: endDate, value: null, startDate }); continue; }
    const rs = slice.map(d => d.dayR);
    const m = mean(rs), s = stdev(rs);
    out.push({ date: endDate, value: (m != null && s) ? (m / s) * Math.sqrt(252) : null, startDate });
  }
  return out;
}

function rollingEdgeConcentration(allTrades, daily, windowDays) {
  const tradesByDay = new Map();
  for (const t of allTrades) {
    if (t.net_pnl == null) continue;
    const k = dayKey(t);
    if (!tradesByDay.has(k)) tradesByDay.set(k, []);
    tradesByDay.get(k).push(t);
  }
  const out = [];
  for (let i = 0; i < daily.length; i++) {
    const { slice, startDate, endDate } = calendarSliceAt(daily, i, windowDays);
    const ts = [];
    for (const d of slice) ts.push(...(tradesByDay.get(d.date) || []));
    out.push({ date: endDate, value: calcEdgeConcentration(ts), startDate });
  }
  return out;
}

// Compute a snapshot of a calendar-day window: PF, expectancy R, % green days,
// cum R, trade counts. Used both by the headline 30-day snapshot card and by
// the turnaround diagnostic rule.
function calendarWindowSnapshot(closed, daily, windowDays, rValue) {
  if (!daily.length) return null;
  const lastIdx = daily.length - 1;
  const { slice, startDate, endDate } = calendarSliceAt(daily, lastIdx, windowDays);
  if (!slice.length) return null;

  const trades = [];
  for (const t of closed) {
    const k = dayKey(t);
    if (k && k >= startDate && k <= endDate) trades.push(t);
  }
  const pnls = trades.map(t => Number(t.net_pnl));
  const rs = pnls.map(p => p / rValue);
  const wins = pnls.filter(p => p > 0).length;
  // PF = per-trade PF (gross winners ÷ |gross losers|), matching the canonical
  // definition and the Always-On metric. Daily-close PF on a list of day-sums
  // is a different stat ("session PF") and shouldn't be labeled simply "PF."
  const pf = profitFactor(pnls);
  const perTradeExp = rs.length ? mean(rs) : null;
  const dailyExp = slice.length ? sum(slice.map(d => d.dayR)) / slice.length : null;
  const wr = trades.length ? wins / trades.length : null;
  const pctDays = slice.length ? slice.filter(d => d.dayClose > 0).length / slice.length : null;

  return {
    windowDays,
    startDate, endDate,
    days: slice.length,
    green_days: slice.filter(d => d.dayClose > 0).length,
    trades: trades.length,
    pf,
    expectancy_r: dailyExp,
    expectancy_r_per_trade: perTradeExp,
    win_rate: wr,
    pct_profitable_days: pctDays,
    cum_r: sum(slice.map(d => d.dayR)),
  };
}

// Trade-count thresholds for the state-ladder. Long windows previously had
// no gate, which let d90 duplicate d30 when the user's date filter contained
// less than 90 days of data. Per audit: gate both long windows so they only
// display when there's enough history to be a real baseline.
const LADDER_MIN_TRADES = { d5: 30, d10: 50, d30: 100, d90: 200 };

function cumulativeRSeries(daily) {
  let cum = 0;
  const out = daily.map(d => { cum += d.dayR; return { date: d.date, value: cum }; });
  // Regression line over the same x-axis.
  const ys = out.map(p => p.value);
  const fit = linregR2(ys);
  if (!fit) return { points: out, fit: null };
  return {
    points: out,
    fit: { slope: fit.slope, intercept: fit.intercept, r2: fit.r2 },
  };
}

// ----------------------------------------------------------------------------
// Diagnostic rules engine
// ----------------------------------------------------------------------------

const DIAGNOSTIC_RULES = [
  // 1. Strong edge, leaky exits. (Unchanged: this is a long-run pattern.)
  { id: 'sharpe_giveback', type: 'opportunity', impact: 90,
    when: ({ m }) =>
      m.r_sharpe?.value > 2.0 &&
      m.closed_trade_giveback?.value > 0.35 &&
      m.closed_trade_giveback?.trusted,
    render: ({ m }) => `Your edge is strong (R-Sharpe ${m.r_sharpe.value.toFixed(2)}) but you're donating roughly `
                     + `${Math.round(m.closed_trade_giveback.value * 100)}% of peak realized PnL by day's end on green days. `
                     + `Tightening trailing stops or sizing down after the first profitable exits could materially improve results.`,
  },

  // 2. Wins often, cuts winners — only fires if daily expectancy is also weak
  //    (below the B/C boundary). A "normal scalper" with positive daily R
  //    doesn't get falsely flagged.
  { id: 'win_payoff_skew', type: 'weakness', impact: 85,
    when: ({ m }) =>
      m.win_rate?.value > 0.65 &&
      m.payoff_ratio?.value < 0.8 &&
      m.expectancy_r?.value < 0.5,
    render: ({ m }) => `You win ${Math.round(m.win_rate.value * 100)}% of trades but your average win is only `
                     + `${m.payoff_ratio.value.toFixed(2)}× your average loss, and daily expectancy is only `
                     + `${m.expectancy_r.value.toFixed(2)}R/day. You're cutting winners short relative to losers — `
                     + `letting winners breathe would shift expectancy meaningfully.`,
  },

  // 3. Edge concentration.
  { id: 'thin_baseline_edge', type: 'weakness', impact: 80,
    when: ({ m }) => m.edge_concentration?.value > 0.70,
    render: ({ m }) => `Your top 10% of trades generate ${Math.round(m.edge_concentration.value * 100)}% of your PnL. `
                     + `Your baseline edge is thin — losing one or two big winners changes everything.`,
  },

  // 4. Edge compression: 10d PF materially below 30d baseline AND recent
  //    window is in the red. Detects a fresh slip, not a long-stale average.
  { id: 'edge_compression', type: 'weakness', impact: 95,
    when: ({ m, gates }) =>
      gates.has_10d_sample && gates.has_30d_sample &&
      m.rolling_pf_10 != null && m.rolling_pf_30 != null &&
      m.rolling_pf_30 > 0 && (m.rolling_pf_10 / m.rolling_pf_30) < 0.70 &&
      m.snapshots?.d10?.cum_r < 0,
    render: ({ m }) => `Edge compression detected. Your 10-day profit factor (${m.rolling_pf_10.toFixed(2)}) is `
                     + `${Math.round((1 - m.rolling_pf_10 / m.rolling_pf_30) * 100)}% below your 30-day baseline `
                     + `(${m.rolling_pf_30.toFixed(2)}), and the last 10 days are net ${m.snapshots.d10.cum_r.toFixed(1)}R.`,
  },

  // 5. Worst loss > best win.
  { id: 'loss_exceeds_win', type: 'weakness', impact: 75,
    when: ({ m }) => m.largest_loss_vs_win?.value > 1.5,
    render: ({ m }) => `Your worst loss exceeds your best win by ${m.largest_loss_vs_win.value.toFixed(2)}×. `
                     + `You're letting losers run longer than winners.`,
  },

  // 6. Risk-control / drawdown — temporally framed. If the worst DD is old
  //    AND the recent 30-day DD is much smaller, the message acknowledges the
  //    improvement instead of weaponizing the historical record.
  { id: 'large_drawdown', type: 'weakness', impact: 70,
    when: ({ m }) => m.max_r_drawdown?.value > 25,
    render: ({ m }) => {
      const dd  = m.max_r_drawdown.value;
      const date = m.historical_dd_date ? ` (around ${m.historical_dd_date})` : '';
      const recent = m.recent_30d_max_r_drawdown;
      const recentBetter = recent != null && recent < dd * 0.25;
      if (recentBetter) {
        return `Your largest drawdown of ${dd.toFixed(1)}R occurred${date}. Recent 30-day max drawdown is `
             + `${recent.toFixed(1)}R — meaningfully better controlled. The historical drawdown remains in your `
             + `record but does not reflect current risk management.`;
      }
      return `Your largest drawdown of ${dd.toFixed(1)}R${date} suggests risk-control breakdowns at the `
           + `position-size or stop-loss level. Review your largest losing days.`;
    },
  },

  // 7. Per-trade expectancy positive but cumulative R negative — decisions
  //    are good on average, but outsized losers are eating the curve. Reads
  //    the per-trade expectancy (not the graded daily one) since the sign
  //    contradiction is only meaningful at the per-trade level.
  { id: 'expectancy_positive_curve_negative', type: 'opportunity', impact: 88,
    when: ({ m, gates }) =>
      gates.has_10d_sample &&
      m.snapshots?.d10?.expectancy_r_per_trade > 0 && m.snapshots?.d10?.cum_r < 0,
    render: ({ m }) => `Per-trade expectancy over the last 10 days is positive (`
                     + `${m.snapshots.d10.expectancy_r_per_trade.toFixed(2)}R/trade) but cumulative R over the same `
                     + `window is ${m.snapshots.d10.cum_r.toFixed(1)}R — a few outsized losers are overpowering an `
                     + `otherwise positive per-trade edge. Cap downside on individual trades.`,
  },

  // 8. Discipline strength — fires when both give-back metrics are in A-band
  //    territory. Replaces the old all_improving rule which couldn't fire
  //    after the trajectory refactor (had max 3 signals instead of 5).
  { id: 'discipline_strength', type: 'strength', impact: 78,
    when: ({ m }) =>
      m.weekly_giveback?.score >= 90 &&
      m.closed_trade_giveback?.score >= 80 && m.closed_trade_giveback?.trusted,
    render: ({ m }) => `Your weekly give-back (${Math.round((m.weekly_giveback.value || 0) * 100)}%) and `
                     + `closed-trade give-back (${Math.round((m.closed_trade_giveback.value || 0) * 100)}%) are `
                     + `both in strong territory. You're protecting profits well — a real discipline strength.`,
  },

  // 8b. Time-of-day weakness — habitual losing window, sample-gated to avoid
  //     flagging a single outlier bucket.
  { id: 'tod_weakness', type: 'weakness', impact: 80,
    when: ({ m }) => !!m.worst_tod,
    render: ({ m }) => `Your worst time-of-day window is ${m.worst_tod.time} across ${m.worst_tod.count} trades, `
                     + `averaging $${m.worst_tod.perTrade.toFixed(0)} per trade `
                     + `(window net $${m.worst_tod.net.toFixed(0)}). Consider sizing down or sitting out this window.`,
  },

  // 9a. Recent turnaround vs SHORT baseline — 10d PF materially above 30d.
  //     Captures an *accelerating* recovery (current state still pulling away
  //     from the recent baseline).
  { id: 'recent_turnaround_short', type: 'strength', impact: 92,
    when: ({ m, gates }) =>
      gates.has_10d_sample && gates.has_30d_sample &&
      m.rolling_pf_10 != null && m.rolling_pf_30 != null &&
      m.rolling_pf_30 > 0 && (m.rolling_pf_10 / m.rolling_pf_30) > 1.30 &&
      m.snapshots?.d10?.cum_r > 0,
    render: ({ m }) => `Your last 10 days show a meaningful acceleration. 10-day profit factor `
                     + `(${m.rolling_pf_10.toFixed(2)}) is materially above your 30-day baseline `
                     + `(${m.rolling_pf_30.toFixed(2)}), and you're net +${m.snapshots.d10.cum_r.toFixed(1)}R `
                     + `over the window.`,
  },

  // 9b. Recent turnaround vs LONG baseline — 10d PF materially above 90d.
  //     Captures the bigger story: recent state vs historical pattern. Will
  //     fire even when 10d ≈ 30d (steady recovery, both windows already in
  //     the new regime) as long as the 90d baseline is still in the old one.
  { id: 'recent_turnaround_long', type: 'strength', impact: 94,
    when: ({ m, gates }) =>
      gates.has_10d_sample && gates.has_90d_sample &&
      m.rolling_pf_10 != null && m.rolling_pf_90 != null &&
      m.rolling_pf_90 > 0 && (m.rolling_pf_10 / m.rolling_pf_90) > 1.50 &&
      m.snapshots?.d10?.cum_r > 0,
    render: ({ m }) => `Your recent state is materially better than your historical baseline. 10-day `
                     + `profit factor (${m.rolling_pf_10.toFixed(2)}) is `
                     + `${((m.rolling_pf_10 / m.rolling_pf_90 - 1) * 100).toFixed(0)}% above your 90-day baseline `
                     + `(${m.rolling_pf_90.toFixed(2)}), and you're net +${m.snapshots.d10.cum_r.toFixed(1)}R `
                     + `over the recent window. Decision quality has shifted.`,
  },
];

function runDiagnostics(ctx, trajectoryModifier) {
  const out = [];
  for (const rule of DIAGNOSTIC_RULES) {
    let fired = false;
    try { fired = !!rule.when(ctx); } catch (_) { fired = false; }
    if (!fired) continue;
    out.push({ id: rule.id, type: rule.type, impact: rule.impact, message: rule.render(ctx) });
  }
  // Sort by impact; when trajectory is ↑/↑↑, surface strengths first so the
  // diagnostic list mirrors the trajectory-aware headline choice.
  const trajectoryPositive = trajectoryModifier === '↑' || trajectoryModifier === '↑↑';
  return out.sort((a, b) => {
    if (trajectoryPositive) {
      const aStrength = a.type === 'strength' ? 0 : 1;
      const bStrength = b.type === 'strength' ? 0 : 1;
      if (aStrength !== bStrength) return aStrength - bStrength;
    }
    return b.impact - a.impact;
  }).slice(0, 4);
}

// Pick the headline finding. Default = highest-impact. Trajectory-aware
// override: when the overall trajectory modifier is ↑ or ↑↑ AND at least
// one strength finding fired, surface the highest-impact strength so the
// headline reflects what's improving, not the historical weakness.
function pickHeadlineFinding(findings, trajectoryModifier) {
  if (!findings.length) return null;
  const trajectoryPositive = trajectoryModifier === '↑' || trajectoryModifier === '↑↑';
  if (trajectoryPositive) {
    const strengths = findings.filter(f => f.type === 'strength');
    if (strengths.length) return strengths.sort((a, b) => b.impact - a.impact)[0];
  }
  return findings[0];
}

// ----------------------------------------------------------------------------
// Tier resolution
// ----------------------------------------------------------------------------

function resolveTier({ trades, days, weeks, months }) {
  if (trades < 10) return 'insufficient';
  if (days >= 60) return 'long_term';
  if (days >= 20) return 'monthly';
  if (weeks >= 2) return 'weekly';
  // Intraday: enough trades and days to surface intraday cards, but no full
  // weeks yet for weekly analysis.
  if (days >= 5) return 'intraday';
  return 'always_on';
}

const TIER_ORDER = ['insufficient', 'always_on', 'intraday', 'weekly', 'monthly', 'long_term'];

function tierMessage(tier, counts) {
  if (tier === 'insufficient') return 'Need at least 10 trades to evaluate.';
  if (tier === 'always_on') {
    const need = Math.max(0, 5 - counts.days);
    return `Always-on tier · ${need ? `${need} more trading day${need===1?'':'s'} to unlock intraday analysis` : 'intraday analysis unlocks soon'}.`;
  }
  if (tier === 'intraday') {
    const need = Math.max(0, 2 - counts.weeks);
    return `Intraday tier · ${need ? `${need} more week${need===1?'':'s'} to unlock weekly analysis` : 'weekly analysis unlocks soon'}.`;
  }
  if (tier === 'weekly') {
    const need = Math.max(0, 20 - counts.days);
    return `Weekly tier · ${need} more trading day${need===1?'':'s'} to unlock monthly analysis.`;
  }
  if (tier === 'monthly') {
    const need = Math.max(0, 60 - counts.days);
    return `Monthly tier · ${need} more trading day${need===1?'':'s'} to unlock long-term analysis.`;
  }
  return 'Long-term tier · full evaluation enabled.';
}

// ----------------------------------------------------------------------------
// Public entry point
// ----------------------------------------------------------------------------

// Median of a numeric array. Returns null for empty input.
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Informational stats shown above the grades — no letter grade, just numbers
// the user can read their own style from (scalper vs day-trader vs swing).
function buildInfoStats(closed, counts) {
  const holds = closed.map(t => t.duration_min).filter(v => v != null && Number.isFinite(v));
  return {
    median_hold_min: median(holds),
    avg_trades_per_day: counts.days ? counts.trades / counts.days : null,
    avg_trades_per_green_day: counts.avg_closed_trades_per_green_day || null,
  };
}

export function computeDoctor(trades, { rValue, from, to } = {}) {
  if (!Number.isFinite(rValue) || rValue <= 0) {
    return { error: 'rValue must be a positive number' };
  }
  if (!CATEGORIES) throw new Error('config missing'); // dev guardrail

  // Filter to closed round-trips only. Match the legacy-dashboard invariant
  // (exit_dt must exist), and date-range-filter once up front so every metric
  // below operates on the same subset and the report is internally consistent.
  let closed = trades.filter(t => t.net_pnl != null && t.exit_dt);
  if (from) closed = closed.filter(t => (t.entry_dt || '').slice(0, 10) >= from);
  if (to)   closed = closed.filter(t => (t.entry_dt || '').slice(0, 10) <= to);

  // Outlier hygiene. A single trade whose |net_pnl / R| exceeds 50 is almost
  // certainly bad data (mis-imported multiplier, busted execution, an open
  // position that slipped through, etc.). Exclude before computing anything
  // and surface the exclusions to the UI so the user can investigate and
  // delete/fix them rather than have their grades silently warped.
  const OUTLIER_R_MULT = 50;
  const excluded = [];
  closed = closed.filter(t => {
    const r = Math.abs(Number(t.net_pnl) / rValue);
    if (Number.isFinite(r) && r > OUTLIER_R_MULT) {
      excluded.push({
        id: t.id,
        symbol: t.symbol,
        entry_dt: t.entry_dt,
        net_pnl: Number(t.net_pnl),
        r_multiple: Number(t.net_pnl) / rValue,
      });
      return false;
    }
    return true;
  });
  const opts = { rValue };

  const daily = buildDailySeries(closed, rValue);
  const weekly = buildWeeklySeries(daily);
  const monthly = buildMonthlySeries(daily, rValue);

  const counts = {
    trades: closed.length,
    days: daily.length,
    weeks: weekly.length,
    // "full_weeks" = weeks with ≥5 trading days observed, i.e. Mon–Fri all
    // present. Used by the pf_cov trust gate; otherwise a short partial
    // week with 1–2 trading days gets counted as a "full week" and pf_cov
    // grades on noisy values.
    full_weeks: weekly.filter(w => w.dayCount >= 5).length,
    months: monthly.length,
    green_days: daily.filter(d => d.dayClose > 0).length,
    avg_closed_trades_per_green_day: 0, // filled in below
  };
  const greenDayTrades = daily.filter(d => d.dayClose > 0).map(d => d.tradeCount);
  counts.avg_closed_trades_per_green_day = greenDayTrades.length ? mean(greenDayTrades) : 0;

  const info_stats = buildInfoStats(closed, counts);
  const tier = resolveTier(counts);

  if (tier === 'insufficient') {
    return {
      inputs: { rValue, from: from || null, to: to || null },
      tier, counts, info_stats,
      tier_message: tierMessage(tier, counts),
      metrics: {}, categories: {}, overall: null,
      trajectory: null, findings: [],
      series: {},
      excluded_outliers: excluded,
    };
  }

  const m = buildMetrics(closed, daily, weekly, monthly, opts);

  // Rolling PF values used by diagnostic rules + UI. The 10d is the new
  // "current" anchor; 30d is the short baseline; 90d is preserved for the
  // long-baseline ladder column even though no chart line uses it.
  const rolling5  = rollingProfitFactor(daily, 5);
  const rolling10 = rollingProfitFactor(daily, 10);
  const rolling30 = rollingProfitFactor(daily, 30);
  const rolling90 = rollingProfitFactor(daily, 90);
  const lastPF = (arr) => arr.length ? arr[arr.length - 1].value : null;
  m.rolling_pf_5  = lastPF(rolling5);
  m.rolling_pf_10 = lastPF(rolling10);
  m.rolling_pf_30 = lastPF(rolling30);
  m.rolling_pf_90 = lastPF(rolling90);

  // State-vs-baseline ladder: 5d / 10d / 30d / 90d calendar windows. The 10d
  // window is the new "primary current state" anchor; 30d is the short baseline
  // and 90d is the long-run baseline. Each is descriptive (no letter grades).
  // Diagnostic rules below operate on these snapshots, NOT on rolling-30d
  // averages, because for an active intraday trader 30d is too laggy to call
  // "current."
  const snapshots = {
    d5:  calendarWindowSnapshot(closed, daily, 5, rValue),
    d10: calendarWindowSnapshot(closed, daily, 10, rValue),
    d30: calendarWindowSnapshot(closed, daily, 30, rValue),
    d90: calendarWindowSnapshot(closed, daily, 90, rValue),
  };
  // Two suppression reasons; both produce displayable=false:
  //   (a) trade count under the LADDER_MIN_TRADES floor for the window
  //   (b) actual data span < 50% of the requested window's calendar size
  //       (so the column would just duplicate a shorter one — common when
  //        the user's date filter is narrower than the window itself)
  // Each snapshot carries a `reason` for the suppression so the UI can
  // explain rather than just leaving an empty card.
  const earliestData = daily[0]?.date;
  for (const [key, snap] of Object.entries(snapshots)) {
    if (!snap) continue;
    const minTrades = LADDER_MIN_TRADES[key] || 0;
    const expectedSpan = snap.windowDays;
    const actualSpan = earliestData ? daysBetween(earliestData > snap.startDate ? earliestData : snap.startDate, snap.endDate) + 1 : 0;
    const spanInsufficient = actualSpan < expectedSpan * 0.5;
    const tradesInsufficient = (snap.trades || 0) < minTrades;
    snap.displayable = !spanInsufficient && !tradesInsufficient;
    if (!snap.displayable) {
      snap.suppress_reason = tradesInsufficient
        ? `Only ${snap.trades} trades — need ≥${minTrades} for a meaningful baseline`
        : `Selected range only spans ~${actualSpan} days — need ~${snap.windowDays} for a real ${snap.windowDays}-day window`;
    }
  }
  m.snapshots = snapshots;

  // Category & overall scores.
  const categories = {};
  for (const key of Object.keys(CATEGORIES)) {
    categories[key] = {
      ...scoreCategory(key, m),
      label: CATEGORIES[key].label,
      description: CATEGORIES[key].description,
      weight: CATEGORIES[key].weight,
    };
  }
  const overall = scoreOverall(categories);

  // Trajectory — category-score-based, see buildTrajectory().
  const trajectory = TIER_ORDER.indexOf(tier) >= TIER_ORDER.indexOf('weekly')
    ? buildTrajectory(closed, daily, opts)
    : null;
  m.trajectory = trajectory;

  // Inputs for new diagnostic rules.
  // Worst TOD bucket — for the time-of-day weakness rule. We look at $/trade
  // average so a single huge-loss bucket doesn't beat a habitual-bad-window
  // bucket. Minimum trade count gate prevents single-outlier buckets firing.
  const tod = calcTimeOfDayBuckets(closed);
  let worstBucket = null;
  if (tod) {
    for (const c of tod.cells) {
      if (c.count < 20) continue;
      const perTrade = c.net / c.count;
      if (perTrade < -50 && (!worstBucket || perTrade < worstBucket.perTrade)) {
        worstBucket = { time: c.time, count: c.count, net: c.net, perTrade };
      }
    }
  }
  m.worst_tod = worstBucket;

  // Historical drawdown date + recent-30d drawdown — used by large_drawdown
  // rule to add temporal framing when the worst DD is old and current control
  // is meaningfully better.
  m.historical_dd_date = findMaxDrawdownEndDate(daily);
  m.recent_30d_max_r_drawdown = calcRecentMaxDrawdown(daily, 30);

  // Diagnostic gates. Match the ladder thresholds so a window that's "too
  // thin to display" is also "too thin to fire a rule on."
  const trades10 = snapshots.d10?.trades || 0;
  const trades30 = snapshots.d30?.trades || 0;
  const trades90 = snapshots.d90?.trades || 0;
  const gates = {
    tier,
    has_10d_sample: trades10 >= LADDER_MIN_TRADES.d10,
    has_30d_sample: trades30 >= 50,  // 30d should have at least 5×10d-floor of data
    has_90d_sample: trades90 >= 100,
  };
  const findings = runDiagnostics({ m, gates }, trajectory?.modifier);
  const headlineFinding = pickHeadlineFinding(findings, trajectory?.modifier);

  // Series for charts. Rolling-PF chart shows 5/10/30; rolling-Sharpe shows
  // 5/10/30 with trade-count gating on the short windows (5d needs ≥30
  // trades; 10d needs ≥50) so unstable points don't pollute the line.
  const series = {
    daily: daily.map(d => ({ date: d.date, close: d.dayClose, peak: d.dayPeak, dayR: d.dayR })),
    rolling_pf_5: rolling5,
    rolling_pf_10: rolling10,
    rolling_pf_30: rolling30,
    rolling_sharpe_5:  rollingSharpe(daily, 5,  { minTrades: LADDER_MIN_TRADES.d5 }),
    rolling_sharpe_10: rollingSharpe(daily, 10, { minTrades: LADDER_MIN_TRADES.d10 }),
    rolling_sharpe_30: rollingSharpe(daily, 30),
    rolling_edge_concentration_30: rollingEdgeConcentration(closed, daily, 30),
    cumulative_r: cumulativeRSeries(daily),
    weekday: calcBestWorstWeekday(daily),
    tod: calcTimeOfDayBuckets(closed),
    weekly_pfs: weekly.map(w => ({ weekStart: w.weekStart, profitFactor: w.profitFactor, weekClose: w.weekClose })),
    monthly_r: monthly.map(mo => ({ month: mo.month, totalR: mo.totalR, totalPnl: mo.totalPnl })),
  };

  return {
    inputs: { rValue, from: from || null, to: to || null },
    tier, counts, info_stats,
    tier_message: tierMessage(tier, counts),
    overall,
    categories,
    metrics: m,
    snapshots,
    trajectory,
    findings,
    headline_finding: headlineFinding,
    series,
    excluded_outliers: excluded,
    config: { categories: CATEGORIES }, // expose for UI grouping if needed
  };
}

export { DOCTOR_CONFIG };
