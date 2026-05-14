// Entry point for the packaged TradeLab.exe build.
// Sets a writable data dir next to the .exe, boots the Express server,
// then opens the user's default browser.

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// process.execPath inside a pkg-built binary points at the .exe itself.
// We put the SQLite DB + candle cache in <exe-dir>/data so the user can
// see / back up / move them as ordinary files. If the user prefers, they
// can override either with TRADELAB_DATA_DIR or TRADELAB_DB in advance.
if (!process.env.TRADELAB_DATA_DIR) {
  const exeDir = path.dirname(process.execPath);
  process.env.TRADELAB_DATA_DIR = path.join(exeDir, 'data');
}
fs.mkdirSync(process.env.TRADELAB_DATA_DIR, { recursive: true });

const PORT = process.env.PORT || 4173;
const URL = `http://localhost:${PORT}`;

function openBrowser(url) {
  const platform = os.platform();
  const [cmd, args] =
    platform === 'win32'  ? ['cmd',      ['/c', 'start', '""', url]] :
    platform === 'darwin' ? ['open',     [url]] :
                            ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});  // best-effort; no-op on headless boxes
    child.unref();
  } catch {
    // best-effort; user can open the URL manually
  }
}

console.log('');
console.log('  ┌────────────────────────────────────────────┐');
console.log('  │  TradeLab                                  │');
console.log(`  │  Open ${URL.padEnd(38)} │`);
console.log(`  │  Data: ${process.env.TRADELAB_DATA_DIR.slice(0, 36).padEnd(36)} │`);
console.log('  │  Closing this window stops TradeLab.       │');
console.log('  └────────────────────────────────────────────┘');
console.log('');

setTimeout(() => openBrowser(URL), 1200);

await import('../server/index.js');
