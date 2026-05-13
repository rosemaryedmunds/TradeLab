# TradeLab

A portable, DB-backed dashboard for tracking, importing, and analyzing options trades. SQLite + Node/Express + vanilla JS. No build step.

**Features**
- Upload broker tape CSVs (one row per fill); FIFO-matched into round trips with proper dedup
- 0DTE auto-expiry settles at actual SPX intrinsic value (via Massive.com API), not blindly at $0
- Per-trade SPX intraday chart with Saty Pivot Ribbon EMAs, Phase Oscillator, daily-anchored ATR levels
- Manage page with sortable/filterable table, add/edit/delete, CSV upload
- Overall and daily dashboards with calendar heatmaps, equity curve, scatter, scenario "move below the line", session/hour breakdowns
- Audit endpoint to close expired open positions at their real intrinsic value

---

## Quick start (local, in ~60 seconds)

```bash
git clone <repo-url> tradelab
cd tradelab
npm install
cp .env.example .env       # then open .env and fill in MASSIVE_API_KEY (optional, see below)
node server/index.js
```

Open `http://localhost:4173`. That's it — the DB self-creates on first run.

Without a Massive API key, everything works except the per-trade SPX chart (which won't have candle data — it still plots your trade markers). You can add the key later by editing `.env` and restarting.

---

## Upload your trades

The fastest way to get going is to upload a broker tape CSV:

1. Open `http://localhost:4173/trades`
2. Click **↑ upload csv**
3. Pick a file or paste rows directly

### Supported CSV formats (auto-detected)

**1. Broker tape — one row per fill** (e.g. IBKR Trade Log, ThinkorSwim Order History)
```csv
Symbol,Side,Fill Price,Time,Net Amount,Commission
SPX (SPXW) May12 '26 7340 Put,Sell,6.9,5/12/2026 10:37,690,1.64
SPX (SPXW) May12 '26 7340 Put,Buy,7.5,5/12/2026 10:35,750,1.64
...
```
- Tab- or comma-delimited; either works
- BUYs and SELLs FIFO-matched per contract into closed round trips
- Quantity inferred from `Net Amount ÷ (Fill Price × 100)` if not provided
- Commission stored as negative (it's a cost)
- Unmatched BUYs after end-of-import → if the contract has expired, auto-closed at SPX intrinsic value (PM settlement). Else recorded as open positions.

**2. Per-trade flat rows** — one row per closed round trip
```csv
symbol,entry_dt,exit_dt,quantity,entry_price,exit_price,commission
SPY 06JAN26 690 C,2026-01-06T11:57:58,2026-01-06T12:17:52,3,0.28,0.48,-4.11
```

**3. Execution ladder grouped by `round_trip_id`** (IBKR Flex Query style)
```csv
round_trip_id,symbol,dt,side,qty,price,commission
all-0001,SPY 06JAN26 690 C,2026-01-06T11:57:58,BUY,3,0.28,-1.52
all-0001,SPY 06JAN26 690 C,2026-01-06T12:17:52,SELL,3,0.48,-2.58
```

### Dedup behavior

Re-uploading the exact same CSV is safe — trades dedup on `(symbol, entry_dt, exit_dt, exit_price)`. You'll see `updated: N, inserted: 0` in the modal.

If your CSV includes an `id` / `trade_id` / `round_trip_id` column, that's the strongest dedup signal — use it if your broker exposes one.

---

## Deploy to a server

The app is one Node process. Any way you'd run a normal Node service works.

### With PM2 (recommended)

```bash
git clone <repo-url> tradelab
cd tradelab
npm install
cp .env.example .env       # edit
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup                # follow the printed instructions
```

### Behind nginx

Minimal config:
```nginx
server {
    listen 80;
    server_name tradelab.example.com;

    client_max_body_size 25M;   # CSV uploads can be a few MB

    location / {
        proxy_pass http://127.0.0.1:4173;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Add TLS via certbot:
```bash
certbot --nginx -d tradelab.example.com
```

### With Docker (lightweight)

```Dockerfile
FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y curl python3 build-essential && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 4173
CMD ["node", "server/index.js"]
```
Mount `./data` as a volume so the DB persists across container rebuilds.

---

## What's inside

```
server/
  index.js          Express API + static asset host (loads .env via dotenv)
  db.js             SQLite connection, schema, foreign keys
  pnl.js            Per-trade net/gross/duration/pct
  legacyShape.js    Renders trades in the "baked HTML" JSON shape (for legacy dashboards)
  csvImport.js      CSV importer with three format detectors + FIFO matcher
  chartData.js      Per-trade chart payload (Massive candles + DB trades + indicators)
  indicators.js     Saty Pivot Ribbon, Phase Oscillator, daily-anchored ATR levels
  settlement.js     SPX cash close lookup → intrinsic value for expired options
  template.js       Replaces <script id="trade-data"> in legacy HTML at request time
public/
  index.html        Overall dashboard            /
  today/index.html  Daily dashboard              /today, /today/, /day/<date>
  csv/index.html    Same as overall (legacy)     /csv, /csv/
  manage.html       CRUD + CSV upload            /trades, /manage
  charts/spx-trade/ Per-trade interactive chart  /charts/spx-trade/?date=YYYY-MM-DD
  assets/           Shared CSS + helpers + vendor (lightweight-charts)
scripts/
  seed-from-html.js       Optional: bootstrap from a legacy inline-JSON HTML
  restore-historical.js   Optional: restore from a known-good HTML snapshot
data/                     Runtime — gitignored
  tradelab.db             The whole database. Back up this single file.
  candle-cache/           Cached SPX bars from Massive (intraday + daily per date)
.env                      Local secrets — gitignored
.env.example              Template
ecosystem.config.cjs      PM2 process descriptor
```

---

## API reference

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | `{ok, trades}` |
| GET | `/api/trades` | List. Filters: `?from=YYYY-MM-DD&to=…&root=SPY&limit=N` |
| GET | `/api/trades/:id` | Single trade + execution ladder |
| POST | `/api/trades` | Manual add. Required: `symbol, entry_dt, entry_price, quantity` |
| PATCH | `/api/trades/:id` | Edit any editable field |
| DELETE | `/api/trades/:id` | |
| DELETE | `/api/trades` | Bulk delete: body `{ids: [...]}` |
| POST | `/api/trades/import` | CSV import — multipart `file` or JSON `{csv}` |
| GET | `/api/metrics/overall` | All-time KPIs, equity curve, DOW/hour buckets, by-root table |
| GET | `/api/metrics/daily/:date` | Single-day summary + intraday curve |
| GET | `/api/dates` | All distinct trading dates |
| GET | `/api/audit/expired` | List open trades whose contract has expired |
| POST | `/api/audit/close-expired` | Close them all at SPX intrinsic value. Add `?dryRun=1` for preview. |
| GET | `/data/interactive-charts/SPX_<date>_1m_trade_arrows.json` | Per-trade chart payload (candles + markers + indicators) |

---

## Move to a new server

```bash
# On old server
sqlite3 data/tradelab.db ".backup data/tradelab-backup.db"
scp data/tradelab-backup.db newserver:/tmp/

# On new server
git clone <repo-url> tradelab
cd tradelab
npm install
mkdir -p data
mv /tmp/tradelab-backup.db data/tradelab.db
cp .env.example .env  # edit
pm2 start ecosystem.config.cjs
```

That's it. SQLite makes "portable" trivial — one file is the entire database.

---

## Troubleshooting

**Chart shows "Candle data unavailable (Yahoo 429)" or similar.** Massive's rate limiter triggered. Wait a minute and reload — once a date is fetched it's cached forever.

**Per-trade PnL doesn't match my broker.** Common causes (each has a fix in the codebase already):
- 0DTE expired ITM but you uploaded the tape before settlement — re-upload, or run `POST /api/audit/close-expired`
- Partial fills split into multiple round trips — they should land as separate rows; if you see one row where you expected several, the import dedup got too aggressive (file a bug — current version dedups on `(symbol, entry_dt, exit_dt, exit_price)`)
- Broker shows gross while dashboard shows net (or vice versa). Compare against `/api/metrics/daily/<date>` which exposes both.

**Open positions don't appear on `/` overall dashboard.** By design — the historical dashboards filter them because most date-math operations choke on `null` exits. They show on `/trades` and `/api/trades`. Use `/api/audit/close-expired` to settle expired ones.
