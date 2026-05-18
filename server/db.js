import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.TRADELAB_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.TRADELAB_DB || path.join(DATA_DIR, 'tradelab.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// TradeLab is a single-user app: one DB per user, on their own machine.
// The schema reflects that — no users/sessions/invites tables. Older databases
// (from when TradeLab had auth) may still have those tables and a user_id
// column on trades/executions; that's harmless leftover data and gets ignored.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS trades (
  id            TEXT PRIMARY KEY,
  symbol        TEXT NOT NULL,
  root          TEXT,
  expiry        TEXT,
  strike        REAL,
  right         TEXT CHECK(right IN ('C','P') OR right IS NULL),
  direction     TEXT NOT NULL DEFAULT 'long' CHECK(direction IN ('long','short')),
  quantity      REAL NOT NULL,
  entry_dt      TEXT NOT NULL,
  exit_dt       TEXT,
  entry_price   REAL NOT NULL,
  exit_price    REAL,
  commission    REAL NOT NULL DEFAULT 0,
  notes         TEXT,
  synthetic_exit INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_trades_entry_dt ON trades(entry_dt);
CREATE INDEX IF NOT EXISTS idx_trades_root     ON trades(root);
CREATE INDEX IF NOT EXISTS idx_trades_exit_dt  ON trades(exit_dt);

CREATE TABLE IF NOT EXISTS executions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id    TEXT NOT NULL,
  dt          TEXT NOT NULL,
  side        TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
  qty         REAL NOT NULL,
  price       REAL NOT NULL,
  commission  REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (trade_id) REFERENCES trades(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_executions_trade ON executions(trade_id);

CREATE TABLE IF NOT EXISTS imports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  filename      TEXT,
  mode          TEXT,
  inserted      INTEGER NOT NULL DEFAULT 0,
  updated       INTEGER NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER IF NOT EXISTS trades_updated_at
AFTER UPDATE ON trades
BEGIN
  UPDATE trades SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
END;
`;
db.exec(SCHEMA);

// Additive ALTERs (idempotent). Older v1 databases didn't have the
// `import_id` column on trades; new installs get it from the base schema.
function hasColumn(table, col) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some(r => r.name === col);
}
function addColumnIfMissing(table, col, def) {
  if (!hasColumn(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumnIfMissing('trades', 'import_id', 'INTEGER');

// v1→v2: the legacy imports table had `user_id INTEGER NOT NULL` with a FK to
// users(id). Single-user mode never supplies a user_id, so INSERTs fail with
// "NOT NULL constraint failed: imports.user_id". Rebuild the table without it.
// (imports is an audit log of CSV uploads — losing rows here is harmless.)
{
  const importsCols = db.prepare(`PRAGMA table_info(imports)`).all();
  const userIdCol = importsCols.find(c => c.name === 'user_id');
  if (userIdCol && userIdCol.notnull) {
    db.exec(`
      DROP TABLE imports;
      CREATE TABLE imports (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        filename      TEXT,
        mode          TEXT,
        inserted      INTEGER NOT NULL DEFAULT 0,
        updated       INTEGER NOT NULL DEFAULT 0,
        skipped       INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
  }
}

export function tradeCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM trades').get().n;
}
