/**
 * server/webullSync.js
 *
 * GET /api/sync/webull?date=YYYY-MM-DD          — sync single date
 * GET /api/sync/webull?dryRun=1                 — preview
 * GET /api/sync/webull/bulk?from=YYYY-MM-DD&to=YYYY-MM-DD  — bulk import
 * GET /api/sync/accounts                        — test connectivity
 */

import express   from 'express';
import { spawn } from 'child_process';
import path      from 'node:path';
import { fileURLToPath } from 'node:url';

const router    = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT    = path.join(__dirname, '..', 'scripts', 'webull_fetch.py');
const PYTHON    = '/app/.venv/bin/python3';

// ── Run script, collect stdout lines ─────────────────────────────────────────

function runScript(args) {
  return new Promise((resolve, reject) => {
    const py = spawn(PYTHON, [SCRIPT, ...args], { env: { ...process.env } });
    let lines = [], stderr = '';
    py.stdout.on('data', d => lines.push(...d.toString().split('\n').filter(Boolean)));
    py.stderr.on('data', d => stderr += d.toString());
    py.on('close', code => {
      if (code !== 0) reject(new Error(`Script failed: ${stderr.trim()}`));
      else resolve(lines);
    });
    py.on('error', err => reject(new Error(`spawn failed: ${err.message}`)));
  });
}

// ── Import a single CSV into TradeLab ────────────────────────────────────────

async function importCSV(csv) {
  const PORT = process.env.PORT || 4173;
  const res  = await fetch(`http://localhost:${PORT}/api/trades/import`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ csv }),
  });
  return res.json();
}

// ── GET /api/sync/webull?date=YYYY-MM-DD ─────────────────────────────────────

router.get('/webull', async (req, res) => {
  if (!process.env.WEBULL_APP_KEY || !process.env.WEBULL_APP_SECRET) {
    return res.status(500).json({ error: 'WEBULL_APP_KEY / WEBULL_APP_SECRET not set' });
  }

  const dateStr = req.query.date || null;
  const dryRun  = req.query.dryRun === '1';
  const args    = dateStr ? [dateStr] : [];

  try {
    const lines = await runScript(args);
    const row   = lines.find(l => l.startsWith('{'));
    if (!row) return res.json({ message: 'No data returned', inserted: 0 });

    const { date, csv } = JSON.parse(row);
    const fills = csv ? csv.split('\n').slice(1).filter(Boolean) : [];

    if (!csv || fills.length === 0) {
      return res.json({ date, message: 'No filled options orders found.', inserted: 0 });
    }
    if (dryRun) {
      return res.json({ date, dryRun: true, orderCount: fills.length, csv });
    }
    const result = await importCSV(csv);
    res.json({ date, orderCount: fills.length, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/sync/webull/bulk?from=YYYY-MM-DD&to=YYYY-MM-DD ──────────────────

router.get('/webull/bulk', async (req, res) => {
  if (!process.env.WEBULL_APP_KEY || !process.env.WEBULL_APP_SECRET) {
    return res.status(500).json({ error: 'WEBULL_APP_KEY / WEBULL_APP_SECRET not set' });
  }

  const from = req.query.from || '2026-01-02';
  const to   = req.query.to   || new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  // Set long timeout — this can take a while for many dates
  res.setTimeout(600000);

  try {
    const lines = await runScript([from, to]);
    const results = [];
    let totalInserted = 0;
    let tradingDays   = 0;

    for (const line of lines) {
      if (!line.startsWith('{')) continue;
      const { date, csv } = JSON.parse(line);
      const fills = csv ? csv.split('\n').slice(1).filter(Boolean) : [];

      if (!csv || fills.length === 0) {
        results.push({ date, inserted: 0, orderCount: 0 });
        continue;
      }

      const result = await importCSV(csv);
      const inserted = result.inserted || 0;
      totalInserted += inserted;
      if (fills.length > 0) tradingDays++;
      results.push({ date, orderCount: fills.length, inserted, updated: result.updated || 0 });
    }

    res.json({ from, to, tradingDays, totalInserted, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/sync/accounts ────────────────────────────────────────────────────

router.get('/accounts', async (req, res) => {
  if (!process.env.WEBULL_APP_KEY || !process.env.WEBULL_APP_SECRET) {
    return res.status(500).json({ error: 'WEBULL_APP_KEY / WEBULL_APP_SECRET not set' });
  }
  try {
    const result = await new Promise((resolve, reject) => {
      const py = spawn(PYTHON, ['-c', `
import os, io, sys, logging
logging.disable(logging.CRITICAL)
sys.stdout = io.StringIO()
from webull.core.client import ApiClient
from webull.trade.trade_client import TradeClient
sys.stdout = sys.__stdout__
api_client = ApiClient(os.environ['WEBULL_APP_KEY'], os.environ['WEBULL_APP_SECRET'], 'us')
api_client.add_endpoint('us', 'api.webull.com')
client = TradeClient(api_client)
sys.stdout = io.StringIO()
res = client.account_v2.get_account_list()
sys.stdout = sys.__stdout__
print(res.text)
`], { env: { ...process.env } });
      let out = '', err = '';
      py.stdout.on('data', d => out += d);
      py.stderr.on('data', d => err += d);
      py.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err.trim())));
      py.on('error', e => reject(new Error(`spawn failed: ${e.message}`)));
    });
    res.json({ raw: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
