// JS ports of /root/spy/indicators.py — Saty Pivot Ribbon, Phase Oscillator,
// Saty ATR levels. Inputs are arrays of {time, open, high, low, close, volume}
// in chronological order. Outputs are arrays of decorated row objects.

const round = (n, p = 4) => n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** p) / 10 ** p;

export function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) { out[i] = prev; continue; }
    prev = prev == null ? v : prev * (1 - k) + v * k;
    out[i] = prev;
  }
  return out;
}

export function rma(values, period) {
  // Wilder's smoothing: alpha = 1/period
  const a = 1 / period;
  const out = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) { out[i] = prev; continue; }
    prev = prev == null ? v : prev * (1 - a) + v * a;
    out[i] = prev;
  }
  return out;
}

export function atrSeries(rows, period = 14) {
  const tr = rows.map((r, i) => {
    if (i === 0) return r.high - r.low;
    const pc = rows[i - 1].close;
    return Math.max(r.high - r.low, Math.abs(r.high - pc), Math.abs(r.low - pc));
  });
  return rma(tr, period);
}

export function stdev(values, period) {
  const out = new Array(values.length).fill(0);
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - period + 1);
    let sum = 0, n = 0;
    for (let j = start; j <= i; j++) if (values[j] != null) { sum += values[j]; n++; }
    if (n < 2) { out[i] = 0; continue; }
    const mean = sum / n;
    let varSum = 0;
    for (let j = start; j <= i; j++) if (values[j] != null) varSum += (values[j] - mean) ** 2;
    out[i] = Math.sqrt(varSum / (n - 1));
  }
  return out;
}

// ──────────────────────────────────────────────
// Saty Pivot Ribbon Pro
// ──────────────────────────────────────────────
export function applyPivotRibbon(rows) {
  const close = rows.map(r => r.close);
  const e8 = ema(close, 8);
  const e13 = ema(close, 13);
  const e21 = ema(close, 21);
  const e48 = ema(close, 48);
  const e200 = ema(close, 200);
  const atr14 = atrSeries(rows, 14);
  const std21 = stdev(close, 21);

  // BB compression vs ATR expansion threshold (matches Pine logic)
  const compressionVal = new Array(rows.length).fill(0);
  const inExpZone     = new Array(rows.length).fill(0);
  for (let i = 0; i < rows.length; i++) {
    if (e21[i] == null || atr14[i] == null) continue;
    const pivot = e21[i];
    const bbOff = 2.0 * std21[i];
    const above = close[i] >= pivot;
    const bbUp = pivot + bbOff;
    const bbDn = pivot - bbOff;
    const compUp = pivot + 2.0 * atr14[i];
    const compDn = pivot - 2.0 * atr14[i];
    const expUp = pivot + 1.854 * atr14[i];
    const expDn = pivot - 1.854 * atr14[i];
    compressionVal[i] = above ? bbUp - compUp : compDn - bbDn;
    inExpZone[i]      = above ? bbUp - expUp  : expDn - bbDn;
  }
  const compression = new Array(rows.length).fill(0);
  for (let i = 1; i < rows.length; i++) {
    const expansion = compressionVal[i - 1] <= compressionVal[i];
    if (expansion && inExpZone[i] > 0)      compression[i] = 0;
    else if (compressionVal[i] <= 0)         compression[i] = 1;
    else                                     compression[i] = 0;
  }

  // Candle bias
  const candleBias = new Array(rows.length).fill(0);
  for (let i = 0; i < rows.length; i++) {
    if (e48[i] == null) continue;
    const above = close[i] >= e48[i];
    const up = rows[i].open < rows[i].close;
    const down = rows[i].open > rows[i].close;
    const comp = compression[i] === 1;
    candleBias[i] = comp && up ? 5 : comp && down ? 6
      : above && up ? 1 : !above && up ? 2
      : above && down ? 3 : !above && down ? 4 : 0;
  }

  // Conviction (13/48 crossover)
  const convBull = new Array(rows.length).fill(0);
  const convBear = new Array(rows.length).fill(0);
  let prevBull = null, prevBear = null;
  for (let i = 0; i < rows.length; i++) {
    if (e13[i] == null || e48[i] == null) continue;
    const bull = e13[i] >= e48[i], bear = e13[i] < e48[i];
    if (bull && !prevBull) convBull[i] = 1;
    if (bear && !prevBear) convBear[i] = 1;
    prevBull = bull; prevBear = bear;
  }

  return rows.map((r, i) => ({
    ...r,
    ema_8:  round(e8[i]),
    ema_13: round(e13[i]),
    ema_21: round(e21[i]),
    ema_48: round(e48[i]),
    ema_200: round(e200[i]),
    fast_cloud_bullish:   e8[i] != null && e21[i] != null && e8[i] >= e21[i] ? 1 : 0,
    slow_cloud_bullish:   e13[i] != null && e48[i] != null && e13[i] >= e48[i] ? 1 : 0,
    pivot_bias_bullish:   e8[i] != null && e21[i] != null && e8[i] >= e21[i] ? 1 : 0,
    longterm_bias_bullish: e21[i] != null && e200[i] != null && e21[i] >= e200[i] ? 1 : 0,
    conviction_bull: convBull[i],
    conviction_bear: convBear[i],
    compression: compression[i],
    candle_bias: candleBias[i],
    atr_14: round(atr14[i])
  }));
}

// ──────────────────────────────────────────────
// Phase Oscillator
// ──────────────────────────────────────────────
export function applyPhaseOscillator(rows) {
  const close = rows.map(r => r.close);
  const a14 = atrSeries(rows, 14);
  const pivot = ema(close, 21);
  const raw = close.map((c, i) => {
    if (c == null || pivot[i] == null || !a14[i]) return null;
    return ((c - pivot[i]) / (3.0 * a14[i])) * 100;
  });
  const oscillator = ema(raw, 3);

  const zoneOf = (v) => {
    if (v == null) return null;
    if (v > 100) return 'extended_up';
    if (v > 61.8) return 'distribution';
    if (v > 23.6) return 'neutral_up';
    if (v > -23.6) return 'neutral';
    if (v > -61.8) return 'neutral_down';
    if (v > -100) return 'accumulation';
    return 'extended_down';
  };

  const leaveAcc = new Array(rows.length).fill(0);
  const leaveDist = new Array(rows.length).fill(0);
  const leaveExtD = new Array(rows.length).fill(0);
  const leaveExtU = new Array(rows.length).fill(0);
  for (let i = 1; i < rows.length; i++) {
    const prev = oscillator[i - 1], cur = oscillator[i];
    if (prev == null || cur == null) continue;
    if (prev <= -61.8 && cur > -61.8) leaveAcc[i] = 1;
    if (prev >=  61.8 && cur <  61.8) leaveDist[i] = 1;
    if (prev <= -100  && cur > -100)  leaveExtD[i] = 1;
    if (prev >=  100  && cur <  100)  leaveExtU[i] = 1;
  }

  return rows.map((r, i) => ({
    ...r,
    phase_oscillator: round(oscillator[i]),
    phase_zone: zoneOf(oscillator[i]),
    leaving_accumulation: leaveAcc[i],
    leaving_distribution: leaveDist[i],
    leaving_extreme_down: leaveExtD[i],
    leaving_extreme_up: leaveExtU[i]
  }));
}

// ──────────────────────────────────────────────
// Saty ATR Levels (day-trading mode)
// dailyRef: array of daily candles {time, open, high, low, close} sorted asc.
// Each intraday row is anchored to its calendar date's prior daily close + prior daily ATR-14.
// ──────────────────────────────────────────────
export function applyAtrLevels(rows, dailyRef, isoDateOfRow) {
  if (!dailyRef || dailyRef.length === 0) return rows;
  // Compute per-daily ATR-14 and shift by 1 to match Saty period_index=1.
  const dailyAtr = atrSeries(dailyRef, 14);
  // Build a map: yyyy-mm-dd -> { prev_close, prev_atr }
  const lookup = new Map();
  for (let i = 1; i < dailyRef.length; i++) {
    const todayDate = isoDateOfRow(dailyRef[i]);
    lookup.set(todayDate, { prev_close: dailyRef[i - 1].close, prev_atr: dailyAtr[i - 1] });
  }
  // Anchor for dates BEYOND the last daily candle (e.g. when target date is "today"
  // and daily history ends with the prior session): use the latest daily entry.
  const lastDaily = dailyRef[dailyRef.length - 1];
  const lastDailyDate = isoDateOfRow(lastDaily);
  const fallback = { prev_close: lastDaily.close, prev_atr: dailyAtr[dailyAtr.length - 1] };

  const trigger = 0.236;
  const fibs = { '0382': 0.382, '050': 0.5, '0618': 0.618, '0786': 0.786, '100': 1.0 };
  const ext  = { '1236': 0.236, '1382': 0.382, '150': 0.5, '1618': 0.618, '1786': 0.786, '200': 1.0 };

  return rows.map(r => {
    const date = isoDateOfRow(r);
    const entry = lookup.get(date) || (date > lastDailyDate ? fallback : null);
    if (!entry || entry.prev_close == null || !entry.prev_atr) return r;
    const pc = entry.prev_close, a = entry.prev_atr;
    const out = { ...r, atr_14: round(a), prev_close: round(pc),
      atr_upper_trigger: round(pc + trigger * a),
      atr_lower_trigger: round(pc - trigger * a)
    };
    for (const [label, f] of Object.entries(fibs)) {
      out[`atr_upper_${label}`] = round(pc + f * a);
      out[`atr_lower_${label}`] = round(pc - f * a);
    }
    // Extension levels (1x..2x)
    const u1 = pc + a, l1 = pc - a;
    for (const [label, e] of Object.entries(ext)) {
      out[`atr_upper_${label}`] = round(u1 + e * a);
      out[`atr_lower_${label}`] = round(l1 - e * a);
    }
    return out;
  });
}
