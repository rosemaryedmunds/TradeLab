# Run TradeLab on Windows (no install)

For people who'd rather keep their trade history off the cloud entirely. Your data never leaves your computer.

## For end users

1. Download **TradeLab-windows.zip** from the [Releases](https://github.com/prsdro/TradeLab/releases) page.
2. Right-click the zip → **Extract All…** to anywhere (Desktop is fine).
3. Open the extracted `TradeLab-windows` folder.
4. Double-click **Start TradeLab.bat**.
5. A black console window appears, and your browser opens to `http://localhost:4173`.
6. To stop TradeLab, close the black console window.

That's it. No installer, no admin rights, no signup.

### Where's my data?

A `data` folder is created next to `Start TradeLab.bat` on first run. Inside is `tradelab.db` — that's your whole trade history. Back it up by copying the folder. Move the entire `TradeLab-windows` folder to a USB stick and it works there too.

### Want SPX chart candles?

Get a free API key from [massive.com](https://massive.com) or [polygon.io](https://polygon.io), then create a file named `.env` next to `Start TradeLab.bat` containing:

```
MASSIVE_API_KEY=your_key_here
```

Restart TradeLab. The per-trade chart pages will now show real SPX candles.

### "Windows protected your PC" warning

This is SmartScreen reacting to an unsigned binary. Click **More info** → **Run anyway**. The bundle is just official Node.js + this open-source app — you can audit the contents in the zip yourself.

---

## For developers (building the zip)

From a checked-out clone:

```bash
npm install
npm run build:windows
# → dist/TradeLab-windows.zip
```

What the build does:
- Downloads the official Node 22 Windows x64 runtime (~30 MB compressed).
- Stages the app source (`server/`, `public/`, `scripts/launcher.mjs`) into `dist/TradeLab-windows/app/`.
- Runs `npm install --omit=dev` inside the staged app so end users get production deps only.
- Replaces the host's `better-sqlite3` native binary with the Windows x64 prebuild from the upstream GitHub release.
- Writes `Start TradeLab.bat` and a plain-text `README.txt` at the zip root.
- Zips the lot.

Caches downloads in `build-cache/` so reruns are fast (gitignored).

### Why not a single .exe?

Tried `@yao-pkg/pkg` first — its loader is CommonJS-only and the app uses ESM throughout, so dynamic imports fail at runtime with `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`. Node SEA is the modern alternative but doesn't bundle native modules cleanly (you'd ship `better_sqlite3.node` as a sidecar anyway, defeating the "single file" goal). A portable folder with `node.exe` is the shape Electron / VS Code / Atom use in production; it's reliable across all the ESM/native-module corner cases this app actually hits.

### Releasing

Upload `dist/TradeLab-windows.zip` to a new GitHub Release. End users get a one-click download link from the Releases page.

```bash
gh release create v1.0.0 dist/TradeLab-windows.zip --title "v1.0.0" --notes "First Windows portable build."
```
