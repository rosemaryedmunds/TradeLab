import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import helmet from 'helmet';
import { db } from './db.js';
import { enrichTrades } from './pnl.js';
import { importCsv } from './csvImport.js';
import { renderOverall, renderToday, renderCsv } from './template.js';
import { buildChartPayload } from './chartData.js';
import { settlementPrice } from './settlement.js';
import { computeDoctor } from './doctor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4173;

app.set('trust proxy', 1);

// ---------- security headers ----------
// CSP allows inline scripts because the legacy dashboard HTML embeds inline
// blocks (the trade-data JSON injection + chart-rendering code). 'unsafe-inline'
// is the price of preserving that contract; tightening to nonces is tech debt.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
      baseUri: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-site' },
}));

app.use(express.json({ limit: '5mb' }));

// ---------- pages ----------
// TradeLab is a single-user app. The DB lives on disk wherever TRADELAB_DATA_DIR
// (or TRADELAB_DB) points — typically the user's own machine. No accounts, no
// sessions, no login.
function html(res) {
  res.set('Cache-Control', 'no-cache, max-age=0, must-revalidate');
  res.type('html');
}
app.get('/',                  (req, res) => { html(res); res.send(renderOverall()); });
app.get(/^\/csv\/?$/,         (req, res) => { html(res); res.send(renderCsv()); });
app.get(/^\/today\/?$/,       (req, res) => { html(res); res.send(renderToday()); });
app.get(['/manage', '/trades'], (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'manage.html')));
app.get('/doctor',            (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'doctor.html')));

// Dynamic SPX chart data — replaces the legacy per-day static JSON file.
app.get(/^\/data\/interactive-charts\/SPX_(\d{4}-\d{2}-\d{2})_(\d+m)_trade_arrows\.json$/, async (req, res) => {
  const date = req.params[0], tf = req.params[1];
  try {
    const payload = await buildChartPayload(date, tf);
    res.set('Cache-Control', 'no-cache, max-age=0, must-revalidate');
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------- helpers ----------
function fetchExecutionsByTrade(tradeIds) {
  if (!tradeIds.length) return new Map();
  const placeholders = tradeIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT * FROM executions WHERE trade_id IN (${placeholders}) ORDER BY dt`
  ).all(...tradeIds);
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.trade_id)) m.set(r.trade_id, []);
    m.get(r.trade_id).push(r);
  }
  return m;
}

function allEnrichedTrades(where = '', params = []) {
  const trades = db.prepare(`SELECT * FROM trades ${where} ORDER BY entry_dt`).all(...params);
  const execs = fetchExecutionsByTrade(trades.map(t => t.id));
  return enrichTrades(trades, execs);
}

function nextManualId() {
  const row = db.prepare(
    "SELECT id FROM trades WHERE id LIKE 'man-%' ORDER BY id DESC LIMIT 1"
  ).get();
  const n = row ? parseInt(row.id.slice(4), 10) : 0;
  return `man-${String(n+1).padStart(4,'0')}`;
}

// ---------- trades CRUD ----------
app.get('/api/trades', (req, res) => {
  const { from, to, root, limit } = req.query;
  const where = [];
  const params = [];
  if (from) { where.push('substr(entry_dt,1,10) >= ?'); params.push(from); }
  if (to)   { where.push('substr(entry_dt,1,10) <= ?'); params.push(to); }
  if (root) { where.push('root = ?'); params.push(root); }
  const whereStr = where.length ? `WHERE ${where.join(' AND ')}` : '';
  let trades = allEnrichedTrades(whereStr, params);
  if (limit) trades = trades.slice(0, Math.max(1, Math.min(parseInt(limit, 10) || 0, 10000)));
  res.json({ trades, count: trades.length });
});

// Per-fill executions in the broker "tape" shape the importer accepts.
app.get('/api/executions/export.csv', (req, res) => {
  let { from, to, days } = req.query;
  if (days && !from) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - parseInt(days, 10));
    from = d.toISOString().slice(0, 10);
  }
  const where = [];
  const params = [];
  if (from) { where.push('substr(e.dt,1,10) >= ?'); params.push(from); }
  if (to)   { where.push('substr(e.dt,1,10) <= ?'); params.push(to); }
  const whereStr = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT t.symbol AS symbol, e.dt AS dt, e.side AS side, e.qty AS qty,
           e.price AS price, e.commission AS commission
    FROM executions e JOIN trades t ON t.id = e.trade_id
    ${whereStr}
    ORDER BY e.dt, e.side
  `).all(...params);

  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = ['Symbol,Side,Fill Price,Time,Qty,Net Amount,Commission'];
  for (const r of rows) {
    const signed = (r.side === 'SELL' ? 1 : -1) * r.qty * r.price * 100;
    lines.push([
      esc(r.symbol), r.side, r.price, r.dt, r.qty,
      Math.round(signed * 100) / 100, r.commission
    ].join(','));
  }
  const tag = days ? `last${days}d` : (from || 'all') + (to ? `_to_${to}` : '');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="tradelab_tape_${tag}.csv"`);
  res.set('Cache-Control', 'no-store');
  res.send(lines.join('\n') + '\n');
});

app.get('/api/trades/export.csv', (req, res) => {
  const where = [];
  const params = [];
  let { from, to, days } = req.query;
  if (days && !from) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - parseInt(days, 10));
    from = d.toISOString().slice(0, 10);
  }
  if (from) { where.push('substr(entry_dt,1,10) >= ?'); params.push(from); }
  if (to)   { where.push('substr(entry_dt,1,10) <= ?'); params.push(to); }
  const whereStr = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const trades = allEnrichedTrades(whereStr, params);

  const cols = ['id','symbol','root','expiry','strike','right','direction','quantity',
                'entry_dt','exit_dt','entry_price','exit_price',
                'gross_pnl','net_pnl','pnl_pct','commission','duration_min','synthetic_exit'];
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(',')];
  for (const t of trades) lines.push(cols.map(c => esc(t[c])).join(','));
  const csv = lines.join('\n') + '\n';

  const tag = days ? `last${days}d` : (from || 'all') + (to ? `_to_${to}` : '');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="tradelab_${tag}.csv"`);
  res.set('Cache-Control', 'no-store');
  res.send(csv);
});

app.get('/api/trades/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM trades WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const execs = db.prepare('SELECT * FROM executions WHERE trade_id = ? ORDER BY dt').all(req.params.id);
  const [enriched] = enrichTrades([t], new Map([[t.id, execs]]));
  res.json({ trade: enriched, executions: execs });
});

app.post('/api/trades', (req, res) => {
  const b = req.body || {};
  if (!b.symbol || !b.entry_dt || b.entry_price == null || b.quantity == null) {
    return res.status(400).json({ error: 'symbol, entry_dt, entry_price, quantity required' });
  }
  const id = b.id || nextManualId();
  db.prepare(`
    INSERT INTO trades (id, symbol, root, expiry, strike, right, direction, quantity,
      entry_dt, exit_dt, entry_price, exit_price, commission, notes, synthetic_exit)
    VALUES (@id, @symbol, @root, @expiry, @strike, @right, @direction, @quantity,
      @entry_dt, @exit_dt, @entry_price, @exit_price, @commission, @notes, 0)
  `).run({
    id,
    symbol: b.symbol,
    root: b.root || (String(b.symbol).match(/^[A-Z]+/) || [null])[0],
    expiry: b.expiry || null,
    strike: b.strike ?? null,
    right: b.right || null,
    direction: b.direction || 'long',
    quantity: Math.abs(b.quantity),
    entry_dt: b.entry_dt,
    exit_dt: b.exit_dt || null,
    entry_price: b.entry_price,
    exit_price: b.exit_price ?? null,
    commission: b.commission || 0,
    notes: b.notes || null
  });
  const t = db.prepare('SELECT * FROM trades WHERE id = ?').get(id);
  res.status(201).json({ trade: enrichTrades([t], new Map())[0] });
});

app.patch('/api/trades/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM trades WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const editable = ['symbol','root','expiry','strike','right','direction','quantity',
                    'entry_dt','exit_dt','entry_price','exit_price','commission','notes'];
  const updates = [];
  const params = {};
  for (const k of editable) {
    if (k in req.body) { updates.push(`${k} = @${k}`); params[k] = req.body[k]; }
  }
  if (!updates.length) return res.status(400).json({ error: 'no editable fields supplied' });
  params.id = req.params.id;
  db.prepare(`UPDATE trades SET ${updates.join(', ')} WHERE id = @id`).run(params);
  const updated = db.prepare('SELECT * FROM trades WHERE id = ?').get(req.params.id);
  const execs = db.prepare('SELECT * FROM executions WHERE trade_id = ? ORDER BY dt').all(req.params.id);
  res.json({ trade: enrichTrades([updated], new Map([[updated.id, execs]]))[0] });
});

app.delete('/api/trades/:id', (req, res) => {
  const r = db.prepare('DELETE FROM trades WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'not found' });
  res.json({ deleted: req.params.id });
});

app.delete('/api/trades', (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  const stmt = db.prepare('DELETE FROM trades WHERE id = ?');
  const tx = db.transaction((arr) => { let n = 0; for (const id of arr) n += stmt.run(id).changes; return n; });
  res.json({ deleted: tx(ids) });
});

// ---------- CSV import ----------
// preview=1 (or dryRun=1) returns the proposed trades without committing.
app.post('/api/trades/import', upload.single('file'), async (req, res) => {
  try {
    const text = req.file ? req.file.buffer.toString('utf8') : (req.body?.csv || '');
    if (!text.trim()) return res.status(400).json({ error: 'csv body required (file upload or csv field)' });
    const format = (req.body?.format || req.query?.format || 'auto').toString().toLowerCase();
    const dryRun = req.query.preview === '1' || req.query.dryRun === '1' || req.body?.preview === '1' || req.body?.preview === true;

    let importId = null;
    if (!dryRun) {
      const fn = req.file?.originalname || null;
      const ir = db.prepare(
        `INSERT INTO imports (filename, mode) VALUES (?, ?)`
      ).run(fn, format);
      importId = ir.lastInsertRowid;
    }

    const result = await importCsv(text, { format, dryRun, importId });

    if (!dryRun && importId) {
      db.prepare(`UPDATE imports SET mode = ?, inserted = ?, updated = ?, skipped = ? WHERE id = ?`)
        .run(result.mode, result.inserted || 0, result.updated || 0, result.skipped || 0, importId);
      result.import_id = importId;
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/imports', (req, res) => {
  const rows = db.prepare(
    `SELECT id, filename, mode, inserted, updated, skipped, created_at
       FROM imports ORDER BY id DESC LIMIT 50`
  ).all();
  res.json({ imports: rows });
});

// ---------- metrics ----------
function summarize(trades) {
  let net = 0, gross = 0, commission = 0, wins = 0, losses = 0, scratches = 0, longest_win = 0, longest_loss = 0;
  let cur_win_streak = 0, cur_loss_streak = 0;
  let biggest_win = 0, biggest_loss = 0;
  let total_duration = 0, durations = 0;
  for (const t of trades) {
    if (t.net_pnl == null) continue;
    net += t.net_pnl; gross += t.gross_pnl || 0; commission += t.commission || 0;
    if (t.net_pnl > 0.005) { wins++; cur_win_streak++; cur_loss_streak = 0; longest_win = Math.max(longest_win, cur_win_streak); biggest_win = Math.max(biggest_win, t.net_pnl); }
    else if (t.net_pnl < -0.005) { losses++; cur_loss_streak++; cur_win_streak = 0; longest_loss = Math.max(longest_loss, cur_loss_streak); biggest_loss = Math.min(biggest_loss, t.net_pnl); }
    else { scratches++; }
    if (t.duration_min != null) { total_duration += t.duration_min; durations++; }
  }
  const closed = wins + losses + scratches;
  const total_winnings = trades.filter(t => t.net_pnl > 0).reduce((s,t)=>s+t.net_pnl,0);
  const total_losses = trades.filter(t => t.net_pnl < 0).reduce((s,t)=>s+t.net_pnl,0);
  return {
    count: trades.length, closed, open: trades.length - closed,
    wins, losses, scratches,
    win_rate: closed ? wins / closed : 0,
    net_pnl: r2(net), gross_pnl: r2(gross), commission: r2(commission),
    avg_pnl: closed ? r2(net / closed) : 0,
    avg_win: wins ? r2(total_winnings / wins) : 0,
    avg_loss: losses ? r2(total_losses / losses) : 0,
    profit_factor: total_losses !== 0 ? r2(total_winnings / Math.abs(total_losses)) : null,
    biggest_win: r2(biggest_win), biggest_loss: r2(biggest_loss),
    expectancy: closed ? r2(net / closed) : 0,
    longest_win_streak: longest_win, longest_loss_streak: longest_loss,
    avg_duration_min: durations ? r2(total_duration / durations) : 0
  };
}

function r2(n) { return Math.round(n * 100) / 100; }
function dayKey(t) { return (t.entry_dt || '').slice(0,10); }
function hourKey(t) { return (t.entry_dt || '').slice(11,13); }

function dailyAgg(trades) {
  const m = new Map();
  for (const t of trades) {
    const d = dayKey(t); if (!d) continue;
    if (!m.has(d)) m.set(d, []);
    m.get(d).push(t);
  }
  const out = [];
  let cum = 0;
  for (const [date, group] of [...m].sort((a,b)=>a[0].localeCompare(b[0]))) {
    const s = summarize(group);
    cum += s.net_pnl;
    out.push({ date, ...s, cum_pnl: r2(cum) });
  }
  return out;
}

app.get('/api/metrics/overall', (req, res) => {
  const trades = allEnrichedTrades();
  const summary = summarize(trades);
  const daily = dailyAgg(trades);

  let peak = 0, maxDD = 0, curDD = 0;
  for (const d of daily) {
    peak = Math.max(peak, d.cum_pnl);
    const dd = d.cum_pnl - peak;
    if (dd < maxDD) maxDD = dd;
    curDD = dd;
  }

  const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(n => ({ name: n, count: 0, net: 0, wins: 0 }));
  for (const t of trades) {
    if (!t.entry_dt) continue;
    const d = new Date(t.entry_dt + 'Z').getUTCDay();
    dow[d].count++; dow[d].net += t.net_pnl || 0;
    if (t.net_pnl > 0) dow[d].wins++;
  }
  for (const d of dow) { d.net = r2(d.net); d.win_rate = d.count ? d.wins / d.count : 0; }

  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0, net: 0, wins: 0 }));
  for (const t of trades) {
    const h = parseInt(hourKey(t), 10);
    if (Number.isNaN(h)) continue;
    hours[h].count++; hours[h].net += t.net_pnl || 0;
    if (t.net_pnl > 0) hours[h].wins++;
  }
  for (const h of hours) { h.net = r2(h.net); h.win_rate = h.count ? h.wins / h.count : 0; }

  const roots = new Map();
  for (const t of trades) {
    const k = t.root || '—';
    if (!roots.has(k)) roots.set(k, []);
    roots.get(k).push(t);
  }
  const rootStats = [...roots].map(([root, list]) => ({ root, ...summarize(list) }))
    .sort((a,b)=>b.net_pnl - a.net_pnl);

  res.json({
    summary: { ...summary, max_drawdown: r2(maxDD), current_drawdown: r2(curDD) },
    daily, dow, hours, roots: rootStats,
    date_range: daily.length ? { from: daily[0].date, to: daily[daily.length-1].date, days: daily.length } : null
  });
});

app.get('/api/metrics/daily/:date', (req, res) => {
  const date = req.params.date;
  const trades = allEnrichedTrades('WHERE substr(entry_dt,1,10) = ?', [date]);
  const summary = summarize(trades);

  const sorted = [...trades].sort((a,b)=>(a.entry_dt||'').localeCompare(b.entry_dt||''));
  let cum = 0;
  const curve = sorted.map(t => {
    cum += t.net_pnl || 0;
    return { entry_dt: t.entry_dt, exit_dt: t.exit_dt, id: t.id, net_pnl: t.net_pnl, cum_pnl: r2(cum) };
  });

  const prev = db.prepare(`SELECT DISTINCT substr(entry_dt,1,10) AS d FROM trades WHERE substr(entry_dt,1,10) < ? ORDER BY d DESC LIMIT 1`).get(date);
  const next = db.prepare(`SELECT DISTINCT substr(entry_dt,1,10) AS d FROM trades WHERE substr(entry_dt,1,10) > ? ORDER BY d ASC LIMIT 1`).get(date);

  res.json({
    date, summary, trades: sorted, curve,
    prev: prev?.d || null, next: next?.d || null
  });
});

// ---------- audit / expired ----------
app.get('/api/audit/expired', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const open = db.prepare(`
    SELECT id, symbol, root, expiry, strike, right, entry_dt, entry_price, quantity, commission
    FROM trades
    WHERE (exit_dt IS NULL OR exit_price IS NULL)
      AND expiry IS NOT NULL AND expiry <= ?
    ORDER BY entry_dt
  `).all(today);
  res.json({ count: open.length, trades: open });
});

app.post('/api/audit/close-expired', async (req, res) => {
  const dryRun = req.query.dryRun === '1';
  const today = new Date().toISOString().slice(0, 10);
  const open = db.prepare(`
    SELECT id, symbol, root, expiry, strike, right, entry_dt, entry_price, quantity, commission
    FROM trades
    WHERE (exit_dt IS NULL OR exit_price IS NULL)
      AND expiry IS NOT NULL AND expiry <= ?
    ORDER BY entry_dt
  `).all(today);

  const plan = [];
  for (const t of open) {
    let exit_price = 0;
    let source = '$0 worthless';
    try {
      const settle = await settlementPrice({ right: t.right, strike: t.strike, expiry: t.expiry });
      if (settle != null && Number.isFinite(settle)) {
        exit_price = Math.round(settle * 100) / 100;
        source = exit_price > 0 ? `SPX intrinsic = ${exit_price}` : 'SPX OTM @ $0';
      }
    } catch (e) { source = `fallback $0 (${e.message})`; }
    plan.push({
      id: t.id, symbol: t.symbol, expiry: t.expiry, strike: t.strike, right: t.right,
      entry_price: t.entry_price,
      proposed_exit_dt: `${t.expiry}T16:00:00`,
      proposed_exit_price: exit_price,
      net_pnl: Math.round(((exit_price - t.entry_price) * t.quantity * 100 + (t.commission || 0)) * 100) / 100,
      source
    });
  }

  if (dryRun) return res.json({ dryRun: true, count: plan.length, plan });

  const upd = db.prepare(`UPDATE trades SET exit_dt = ?, exit_price = ?, synthetic_exit = 1 WHERE id = ?`);
  const tx = db.transaction((rows) => { for (const r of rows) upd.run(r.proposed_exit_dt, r.proposed_exit_price, r.id); });
  tx(plan);
  res.json({ dryRun: false, count: plan.length, plan });
});

// ---------- trade doctor ----------
app.get('/api/doctor', (req, res) => {
  const rValue = parseFloat(req.query.r);
  if (!Number.isFinite(rValue) || rValue < 1 || rValue > 100_000) {
    return res.status(400).json({ error: 'r query param (typical $ risk per trade) must be between 1 and 100000' });
  }
  const validDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const from = validDate(req.query.from) ? req.query.from : null;
  const to   = validDate(req.query.to)   ? req.query.to   : null;
  const trades = allEnrichedTrades();
  const result = computeDoctor(trades, { rValue, from, to });
  res.json(result);
});

app.get('/api/dates', (req, res) => {
  const rows = db.prepare(`SELECT DISTINCT substr(entry_dt,1,10) AS d FROM trades ORDER BY d DESC`).all();
  res.json({ dates: rows.map(r => r.d) });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`tradelab listening on http://127.0.0.1:${PORT}`);
});
