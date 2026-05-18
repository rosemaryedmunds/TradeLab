"""
scripts/webull_fetch.py
=======================
Fetches filled options orders from Webull and prints broker-tape CSV to stdout.
Authenticates once and fetches all requested dates in a single session.

Usage:
  python3 scripts/webull_fetch.py 2026-05-15              # single date
  python3 scripts/webull_fetch.py 2026-01-02 2026-05-15   # date range
  python3 scripts/webull_fetch.py                         # today CT

Output: one JSON object per line, each with:
  {"date": "YYYY-MM-DD", "csv": "Symbol,Side,...\n..."}
"""

import os
import sys
import io
import json
from datetime import datetime, date, timezone, timedelta

import logging
logging.disable(logging.CRITICAL)

_real_stdout = sys.stdout
sys.stdout = io.StringIO()

from webull.core.client import ApiClient
from webull.trade.trade_client import TradeClient

for _name in list(logging.root.manager.loggerDict.keys()):
    logging.getLogger(_name).setLevel(logging.CRITICAL)
    logging.getLogger(_name).handlers = []

sys.stdout = _real_stdout

APP_KEY    = os.environ["WEBULL_APP_KEY"]
APP_SECRET = os.environ["WEBULL_APP_SECRET"]
ACCOUNT_ID = os.environ.get("WEBULL_ACCOUNT_ID", "NDG6AMU0P88C6IG0T9NTE8L1A8")

# ── Date args ─────────────────────────────────────────────────────────────────

def get_dates():
    today_ct = (datetime.now(timezone.utc) - timedelta(hours=5)).date()
    if len(sys.argv) == 1:
        return [today_ct]
    elif len(sys.argv) == 2:
        return [datetime.strptime(sys.argv[1], "%Y-%m-%d").date()]
    else:
        start = datetime.strptime(sys.argv[1], "%Y-%m-%d").date()
        end   = datetime.strptime(sys.argv[2], "%Y-%m-%d").date()
        dates = []
        cur = start
        while cur <= end:
            if cur.weekday() < 5:  # Mon-Fri only
                dates.append(cur)
            cur += timedelta(days=1)
        return dates

# ── Helpers ───────────────────────────────────────────────────────────────────

def parse_ts(ts):
    if not ts:
        return None
    if isinstance(ts, (int, float)) or (isinstance(ts, str) and str(ts).isdigit()):
        try:
            return datetime.fromtimestamp(int(ts) / 1000, tz=timezone.utc) \
                           .astimezone(timezone(timedelta(hours=-4))) \
                           .replace(tzinfo=None)
        except Exception:
            pass
    ts_clean = str(ts).replace("Z", "").replace("T", " ").strip()
    for tz_label in [" EST", " CST", " EDT", " CDT", " PST", " PDT"]:
        ts_clean = ts_clean.replace(tz_label, "")
    for fmt in ["%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%m/%d/%Y %H:%M:%S"]:
        try:
            return datetime.strptime(ts_clean, fmt)
        except ValueError:
            continue
    return None


def fmt_time(dt):
    return f"{dt.month}/{dt.day}/{dt.year} {dt.hour:02d}:{dt.minute:02d}"


def build_symbol(order, leg):
    root_raw   = str(order.get("symbol", "")).strip().upper()
    underlying = root_raw.rstrip("W") if root_raw.endswith("W") and len(root_raw) > 3 else root_raw
    opt_type   = str(leg.get("option_type", "")).capitalize()
    strike_raw = leg.get("strike_price", "")
    expiry_raw = leg.get("option_expire_date", "")
    try:
        strike = int(float(strike_raw))
    except (TypeError, ValueError):
        strike = ""
    try:
        exp_dt     = datetime.strptime(expiry_raw, "%Y-%m-%d")
        exp_str    = f"{exp_dt.strftime('%b')}{exp_dt.day} '{exp_dt.strftime('%y')}"
    except Exception:
        exp_str = expiry_raw
    return f"{underlying} ({root_raw}) {exp_str} {strike} {opt_type}".strip()


# ── Init client (once) ────────────────────────────────────────────────────────

def init_client():
    sys.stdout = io.StringIO()
    try:
        api_client = ApiClient(APP_KEY, APP_SECRET, "us")
        api_client.add_endpoint("us", "api.webull.com")
        client = TradeClient(api_client)
    finally:
        sys.stdout = _real_stdout
    return client


# ── Fetch ALL orders (paginated, no date filter) ──────────────────────────────

def fetch_all_orders(client):
    all_combos = []
    page_token = None

    while True:
        kwargs = {"account_id": ACCOUNT_ID, "page_size": 100}
        if page_token:
            kwargs["last_client_order_id"] = page_token

        sys.stdout = io.StringIO()
        try:
            res = client.order_v2.get_order_history(**kwargs)
        finally:
            sys.stdout = _real_stdout

        if res.status_code != 200:
            print(f"ERROR: {res.status_code}: {res.text}", file=sys.stderr)
            break

        data = res.json()
        if isinstance(data, list):
            combos, has_more, page_token = data, False, None
        else:
            combos     = data.get("items", data.get("data", data.get("orders", [])))
            has_more   = data.get("has_more", False)
            page_token = data.get("next_page_token")

        if not combos:
            break
        all_combos.extend(combos)
        if not has_more or not page_token:
            break

    # Flatten fills
    fills = []
    for combo in all_combos:
        for order in combo.get("orders", [combo]):
            status = str(order.get("status", "")).upper()
            if status not in ("FILLED", "FILL", "ALL_FILLED"):
                continue
            ts_raw = (order.get("filled_time_at") or order.get("filled_time") or
                      order.get("place_time_at") or order.get("place_time", ""))
            dt = parse_ts(ts_raw)
            if dt is None:
                continue
            order["_dt"]   = dt
            order["_legs"] = order.get("legs", [])
            fills.append(order)

    return fills


# ── Build CSV for a specific date ─────────────────────────────────────────────

def fills_for_date(fills, target_date):
    rows = ["Symbol,Side,Fill Price,Time,Net Amount,Commission"]
    for order in fills:
        if order["_dt"].date() != target_date:
            continue
        leg  = order["_legs"][0] if order["_legs"] else {}
        symbol = build_symbol(order, leg)
        intent = str(order.get("position_intent", order.get("side", ""))).upper()
        side   = "BUY" if "BUY" in intent else "SELL"
        try:
            fill_price = float(order.get("filled_price", order.get("avg_filled_price", 0)))
        except (TypeError, ValueError):
            fill_price = 0.0
        try:
            qty = int(float(order.get("filled_quantity", order.get("filled_qty", 1))))
        except (TypeError, ValueError):
            qty = 1
        try:
            commission = abs(float(order.get("commission", 0)))
        except (TypeError, ValueError):
            commission = 0.0
        net = fill_price * qty * 100
        if side == "BUY":
            net = -net
        rows.append(f"{symbol},{side},{fill_price},{fmt_time(order['_dt'])},{net},{-commission}")
    return "\n".join(rows) if len(rows) > 1 else ""


# ── Main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    dates  = get_dates()
    client = init_client()

    print(f"FETCHING {len(dates)} date(s)...", file=sys.stderr)
    all_fills = fetch_all_orders(client)
    print(f"Got {len(all_fills)} total fills", file=sys.stderr)

    for d in dates:
        csv = fills_for_date(all_fills, d)
        print(json.dumps({"date": str(d), "csv": csv}))
        sys.stdout.flush()
