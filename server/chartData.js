// Builds the SPX-trade chart payload on demand from the DB + Massive.com candles.
// Output shape matches the legacy static JSON the chart page expects, with
// indicators (EMAs, ATR levels, Phase Oscillator) computed server-side.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { applyPivotRibbon, applyPhaseOscillator, applyAtrLevels } from './indicators.js';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', 'data', 'candle-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const MASSIVE_BASE = 'https://api.massive.com';
const MASSIVE_KEY  = process.env.MASSIVE_API_KEY || process.env.POLYGON_API_KEY || '';
const SYMBOL = 'I:SPX';

const inFlight = new Map();

function fmtTZ(d, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
  if (parts.hour === '24') parts.hour = '00';
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
function tzShortName(d, tz) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
    .formatToParts(d).find(p => p.type === 'timeZoneName');
  return part ? part.value : '';
}
function isoDateInET(epochSec) {
  const d = new Date(epochSec * 1000);
  return fmtTZ(d, 'America/New_York').slice(0, 10);
}
function round4(n) { return n == null ? null : Math.round(n * 1e4) / 1e4; }

async function massiveGet(urlPath) {
  if (!MASSIVE_KEY) throw new Error('MASSIVE_API_KEY not set');
  const url = `${MASSIVE_BASE}${urlPath}${urlPath.includes('?') ? '&' : '?'}apiKey=${MASSIVE_KEY}`;
  const { stdout } = await execFileP('curl', [
    '-s', '--compressed', '--max-time', '20', '-A', 'Mozilla/5.0', url
  ], { maxBuffer: 16 * 1024 * 1024 });
  if (!stdout) throw new Error('Massive: empty response');
  let json;
  try { json = JSON.parse(stdout); }
  catch (e) { throw new Error(`Massive: invalid JSON (${stdout.slice(0,80)})`); }
  if (json.status === 'ERROR') throw new Error(`Massive: ${json.error || 'unknown'}`);
  return json;
}

async function fetchAggregates(symbol, multiplier, span, from, to) {
  // Returns merged results across pagination. Massive caps `limit` at 50000.
  let urlPath = `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${multiplier}/${span}/${from}/${to}?adjusted=false&sort=asc&limit=50000`;
  let all = [];
  let safety = 5;
  while (urlPath && safety-- > 0) {
    const j = await massiveGet(urlPath);
    if (Array.isArray(j.results)) all = all.concat(j.results);
    if (!j.next_url) break;
    // next_url already includes parameters; strip host + reuse apiKey injection
    const u = new URL(j.next_url);
    urlPath = u.pathname + u.search;
  }
  return all.map(r => ({
    time: Math.floor(r.t / 1000),
    open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v || 0
  }));
}

async function fetchIntraday(dateISO) {
  return fetchAggregates(SYMBOL, 1, 'minute', dateISO, dateISO);
}
async function fetchDailyHistory(dateISO, lookbackDays = 90) {
  // From `dateISO - lookbackDays` to `dateISO` (inclusive). Gives the indicator
  // enough warm-up for a 14-period ATR + 21-period pivot.
  const dt = new Date(dateISO + 'T00:00:00Z');
  const from = new Date(dt.getTime() - lookbackDays * 86400_000).toISOString().slice(0, 10);
  return fetchAggregates(SYMBOL, 1, 'day', from, dateISO);
}

async function getCandles(dateISO) {
  const cachePath = path.join(CACHE_DIR, `SPX_${dateISO}_1m.json`);
  const dailyCachePath = path.join(CACHE_DIR, `SPX_${dateISO}_1m_daily.json`);
  const today = new Date().toISOString().slice(0, 10);
  const isToday = dateISO >= today; // never cache today's session — markets still ticking
  if (!isToday && fs.existsSync(cachePath) && fs.existsSync(dailyCachePath)) {
    try {
      return {
        intraday: JSON.parse(fs.readFileSync(cachePath, 'utf8')),
        daily:    JSON.parse(fs.readFileSync(dailyCachePath, 'utf8'))
      };
    } catch {}
  }
  if (inFlight.has(cachePath)) return inFlight.get(cachePath);
  const p = (async () => {
    const [intraday, daily] = await Promise.all([fetchIntraday(dateISO), fetchDailyHistory(dateISO)]);
    if (intraday.length && !isToday) {
      fs.writeFileSync(cachePath, JSON.stringify(intraday));
      fs.writeFileSync(dailyCachePath, JSON.stringify(daily));
    }
    return { intraday, daily };
  })();
  inFlight.set(cachePath, p);
  try { return await p; } finally { inFlight.delete(cachePath); }
}

function anchorClose(rows, epochSec) {
  if (!rows.length) return null;
  let lo = 0, hi = rows.length - 1, ans = rows[0];
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (rows[m].time <= epochSec) { ans = rows[m]; lo = m + 1; }
    else hi = m - 1;
  }
  return ans.close;
}

function legacyDt(s) { return s ? s.replace('T', ' ') : null; }

function decorateRows(rows) {
  return rows.map(r => {
    const d = new Date(r.time * 1000);
    return {
      ...r,
      timestamp:    fmtTZ(d, 'America/New_York'),
      timestamp_et: fmtTZ(d, 'America/New_York') + ' ET',
      timestamp_ct: fmtTZ(d, 'America/Chicago') + ' CT',
      open: round4(r.open), high: round4(r.high), low: round4(r.low), close: round4(r.close)
    };
  });
}

export async function buildChartPayload(dateISO, tf = '1m') {
  let intraday = [], daily = [], candleError = null;
  try {
    const { intraday: it, daily: dly } = await getCandles(dateISO);
    intraday = it; daily = dly;
  } catch (e) { candleError = e.message; }

  // Indicator chain: pivot ribbon (EMAs + compression) → phase oscillator → daily-anchored ATR levels.
  let rows = decorateRows(intraday);
  if (rows.length) {
    rows = applyPivotRibbon(rows);
    rows = applyPhaseOscillator(rows);
    if (daily.length) {
      // Daily ref needs decorated rows? No — applyAtrLevels just needs OHLC.
      rows = applyAtrLevels(rows, daily, (r) => {
        // r is either a daily candle {time, open, ...} OR an intraday row with `timestamp`.
        if (r.timestamp) return r.timestamp.slice(0, 10);
        return isoDateInET(r.time);
      });
    }
  }

  // Pull DB trades + executions for the date.
  const trades = db.prepare(`
    SELECT * FROM trades WHERE substr(entry_dt,1,10) = ? OR substr(exit_dt,1,10) = ?
    ORDER BY entry_dt
  `).all(dateISO, dateISO);

  const tradeIds = trades.map(t => t.id);
  const execs = tradeIds.length
    ? db.prepare(`SELECT * FROM executions WHERE trade_id IN (${tradeIds.map(()=>'?').join(',')}) ORDER BY dt`).all(...tradeIds)
    : [];

  const execsByTrade = new Map();
  for (const e of execs) {
    if (!execsByTrade.has(e.trade_id)) execsByTrade.set(e.trade_id, []);
    execsByTrade.get(e.trade_id).push(e);
  }
  const tradeMeta = new Map();
  for (const t of trades) {
    const list = execsByTrade.get(t.id) || [];
    let cash = 0, commission = 0;
    for (const e of list) {
      const sign = e.side === 'SELL' ? 1 : -1;
      cash += sign * e.qty * e.price * 100;
      commission += e.commission || 0;
    }
    const net = list.length ? cash + commission : (t.exit_price != null
      ? (t.exit_price - t.entry_price) * t.quantity * 100 + (t.commission || 0)
      : null);
    const entryCost = Math.abs(t.entry_price * t.quantity * 100);
    const pct = net != null && entryCost > 0 ? (net / entryCost) * 100 : null;
    tradeMeta.set(t.id, { net_pnl: net, pnl_pct: pct, entry_price: t.entry_price, exit_price: t.exit_price });
  }

  const tfSec = parseInt(tf, 10) * 60 || 60;
  const events = [];
  let eventId = 0;
  for (const e of execs) {
    const epoch = Math.floor(Date.parse(e.dt + 'Z') / 1000);
    if (Number.isNaN(epoch)) continue;
    const barTime = Math.floor(epoch / tfSec) * tfSec;
    const t = trades.find(t => t.id === e.trade_id);
    const meta = tradeMeta.get(e.trade_id) || {};
    const action = e.side === 'BUY' ? 'BUY' : 'SELL';
    const isOpen = action === 'BUY';
    const anchor = anchorClose(rows, barTime) ?? anchorClose(rows, epoch);
    const d = new Date(epoch * 1000);
    events.push({
      id: `e${String(++eventId).padStart(3, '0')}`,
      timestamp: legacyDt(e.dt),
      action,
      contract: t?.symbol || '',
      qty: e.qty,
      price: e.price,
      trade_id: e.trade_id,
      right: t?.right ?? null,
      strike: t?.strike ?? null,
      commission: e.commission || 0,
      netcash: (e.side === 'SELL' ? 1 : -1) * e.qty * e.price * 100 + (e.commission || 0),
      net_pnl: !isOpen ? round4(meta.net_pnl) : null,
      pnl_pct: !isOpen ? round4(meta.pnl_pct) : null,
      entry_price: meta.entry_price,
      exit_price: meta.exit_price,
      time: epoch,
      bar_time: barTime,
      timestamp_et: legacyDt(e.dt) + ' ' + tzShortName(d, 'America/New_York'),
      timestamp_ct: fmtTZ(d, 'America/Chicago') + ' ' + tzShortName(d, 'America/Chicago'),
      qty_abs: e.qty,
      option_price: e.price,
      marker_position: isOpen ? 'belowBar' : 'aboveBar',
      marker_shape: isOpen ? 'arrowUp' : 'arrowDown',
      marker_color: isOpen ? '#30d158' : (meta.net_pnl != null && meta.net_pnl < 0 ? '#ff453a' : '#66a3ff'),
      action_label: isOpen ? 'Bought' : 'Sold',
      anchor_price: anchor,
      bar_close: anchor
    });
  }

  const outTrades = trades.map(t => {
    const m = tradeMeta.get(t.id) || {};
    const entryEpoch = t.entry_dt ? Math.floor(Date.parse(t.entry_dt + 'Z') / 1000) : null;
    const exitEpoch  = t.exit_dt  ? Math.floor(Date.parse(t.exit_dt  + 'Z') / 1000) : null;
    return {
      id: t.id,
      symbol: t.symbol,
      root: t.root,
      expiry: t.expiry,
      strike: t.strike,
      right: t.right,
      quantity: t.quantity,
      entry_dt: legacyDt(t.entry_dt),
      exit_dt: legacyDt(t.exit_dt),
      entry_price: t.entry_price,
      exit_price: t.exit_price,
      net_pnl: round4(m.net_pnl),
      pnl_pct: round4(m.pnl_pct),
      entry_time: entryEpoch,
      exit_time: exitEpoch,
      entry_underlying: entryEpoch != null ? anchorClose(rows, entryEpoch) : null,
      exit_underlying:  exitEpoch  != null ? anchorClose(rows, exitEpoch)  : null
    };
  });

  const defaultRange = rows.length
    ? { from: rows[0].time, to: rows[rows.length - 1].time }
    : null;

  return {
    version: 'tradelab-dynamic-massive-1',
    symbol: 'SPX',
    data_symbol: SYMBOL,
    scale_note: candleError
      ? `Candle data unavailable (${candleError}). Trade markers shown without underlying chart.`
      : 'True SPX cash-index 1-minute candles (Massive.com). Indicators: Saty Pivot Ribbon EMAs, Phase Oscillator, daily-anchored ATR levels.',
    date: dateISO,
    tf,
    timezone_source: 'America/New_York',
    timezone_display: 'America/Chicago',
    source: candleError ? 'TradeLab DB (candles unavailable)' : 'Massive.com I:SPX 1m + TradeLab DB',
    rows_count: rows.length,
    trade_count: outTrades.length,
    event_count: events.length,
    default_range: defaultRange,
    rows,
    events,
    trades: outTrades,
    notes: candleError ? [`Candle fetch failed: ${candleError}`] : [],
    source_vendor: 'Massive.com',
    source_note: candleError || 'Candles from Massive.com I:SPX 1-minute; indicators computed locally with Saty/Milkman formulas.'
  };
}
