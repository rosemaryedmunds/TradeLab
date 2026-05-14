# Deploy TradeLab on Railway

Railway runs the app in the cloud so you don't need to install Node, Git, or anything else on your computer. You get a private URL like `https://your-app.up.railway.app` that only you (and anyone you share it with) can open.

**Cost:** Railway's free trial covers a small app like this for a while. Past that it's roughly **$5/month** for the compute + a tiny disk for your trade database.

**Privacy heads-up:** your trades will be stored on Railway's servers (inside a private volume only your account can access). If you want zero cloud involvement, use the desktop `.exe` build instead — see the main README.

---

## Option A — Click-to-deploy (5 minutes, no terminal)

### 1. Click the button

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https%3A%2F%2Fgithub.com%2Fprsdro%2FTradeLab)

Sign in with GitHub. Railway will fork the repo into your account and start building.

### 2. Add a volume so your trades survive restarts

This step is **mandatory**. Without it, your database gets wiped every time Railway restarts the app (which happens on every code update, every deploy, and roughly weekly anyway).

1. In the Railway dashboard, click your service (the box labeled `TradeLab`).
2. Go to the **Settings** tab.
3. Scroll to **Volumes** → click **+ New Volume**.
4. Set **Mount Path** to: `/app/data`
5. Set **Size** to 1 GB (more than enough — the DB is well under 10 MB even with years of trades).
6. Click **Add**. Railway will redeploy automatically.

### 3. (Optional) Add your Massive.com API key for SPX charts

If you want the per-trade SPX intraday chart to show candles (not just trade markers):

1. Get a free key at [massive.com](https://massive.com) or [polygon.io](https://polygon.io).
2. In Railway, go to **Variables** → **+ New Variable**.
3. Name: `MASSIVE_API_KEY`, Value: your key.
4. Click **Add**. It redeploys.

You can skip this — the rest of the dashboard works fine without it.

### 4. Open your URL

In the **Settings** tab, scroll to **Networking** → click **Generate Domain**. You get something like `tradelab-production.up.railway.app`. Open it in your browser.

The dashboard will be empty. Go to `/trades`, click **↑ upload csv**, and import your broker's trade log. Done.

---

## Option B — One-prompt Claude Code deploy

If you have [Claude Code](https://claude.com/claude-code) installed and the Railway CLI, paste this whole block into Claude and it will deploy the app for you end-to-end:

```
Deploy TradeLab to Railway.

Steps:
1. Run `railway login` if I'm not already logged in. (If it needs to open a browser, tell me to click the link it prints.)
2. Run `railway init` and name the project "tradelab". Pick "Empty Project" if it asks.
3. Run `git clone https://github.com/prsdro/TradeLab.git` into a fresh directory and cd into it.
4. Run `railway up` from inside the repo to push and deploy.
5. After it deploys, run `railway volume add --mount-path /app/data --size 1` to attach a persistent volume so my SQLite DB survives restarts. (If that flag isn't supported, tell me to add the volume manually in the Railway dashboard at https://railway.com — Settings → Volumes → Mount Path /app/data, 1 GB.)
6. Run `railway domain` to generate a public URL.
7. Print the URL clearly so I can open it.

Do NOT ask me about a Massive.com API key — I'll add that later in the dashboard if I want SPX chart candles.

After deploying, remind me:
- My trade data lives in the Railway volume — back it up by downloading data/tradelab.db periodically.
- To upload trades: open the URL, go to /trades, click "↑ upload csv".
```

That's the entire prompt. Claude will run the Railway CLI, deploy, and give you back a URL.

---

## Updating after the first deploy

The repo is cloned into **your** GitHub account, so:

- New features upstream? Pull from `prsdro/TradeLab` and Railway redeploys on every push.
- Want to back up your DB? Railway CLI: `railway run cat /app/data/tradelab.db > local-backup.db`. Or use the Railway dashboard's volume browser.
- App not responding? Railway dashboard → service → **Deployments** → click the latest → check logs.

---

## Troubleshooting

**"My trades disappeared after a redeploy."** You skipped step 2. The volume is mandatory — without it, every restart wipes the DB. Add the volume at `/app/data`, then re-import your CSV.

**"Build fails with `better-sqlite3` errors."** Railway's Nixpacks builder handles native modules automatically. If it still fails, check the build log for the actual error — usually it's a Node version mismatch. The app needs Node ≥ 20.

**"The URL loads but `/charts/spx-trade/` shows no candles."** Expected if you didn't set `MASSIVE_API_KEY`. Add it in **Variables** and redeploy.

**"I want to move my Railway DB to my own server later."** `railway run cat /app/data/tradelab.db > tradelab.db`, then drop that file into a self-hosted setup as documented in the main README.
