// Build a portable Windows distribution as TradeLab-windows.zip.
//
// What's inside the zip:
//   TradeLab-windows/
//     Start TradeLab.bat        ← user double-clicks this
//     node.exe                  ← official Windows Node 22 runtime
//     app/
//       package.json
//       server/
//       public/
//       scripts/launcher.mjs
//       node_modules/           ← production deps, with Windows better-sqlite3
//
// Why this shape instead of a single .exe:
//   pkg can't run ESM at runtime (CJS-only loader), and Node SEA needs
//   native modules sidecar'd anyway. Shipping node.exe + source is the
//   approach the Node ecosystem (electron, atom, vscode) actually uses
//   for production. It also lets the user inspect / back up / move
//   the app folder as ordinary files.

import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const execFileP = promisify(execFile);
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const buildCache = path.join(root, 'build-cache');
const stage = path.join(root, 'dist', 'TradeLab-windows');
const outZip = path.join(root, 'dist', 'TradeLab-windows.zip');

const NODE_VERSION = '22.17.0';
const NODE_ABI = 127;

async function sh(cmd, args, opts = {}) {
  await new Promise((resolve, reject) => {
    const cp = spawn(cmd, args, { stdio: 'inherit', ...opts });
    cp.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}`))));
  });
}

async function ensureWindowsNode() {
  fs.mkdirSync(buildCache, { recursive: true });
  const fname = `node-v${NODE_VERSION}-win-x64.zip`;
  const cached = path.join(buildCache, fname);
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${fname}`;

  if (!fs.existsSync(cached)) {
    console.log(`[build:portable] downloading ${fname}`);
    await execFileP('curl', ['-fsSL', '-o', cached, url]);
  } else {
    console.log(`[build:portable] using cached ${fname}`);
  }

  const extractDir = path.join(buildCache, 'node-win');
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  await sh('unzip', ['-q', cached, '-d', extractDir]);
  const nodeExe = path.join(extractDir, `node-v${NODE_VERSION}-win-x64`, 'node.exe');
  if (!fs.existsSync(nodeExe)) throw new Error(`node.exe not at ${nodeExe}`);
  return nodeExe;
}

async function ensureWindowsBetterSqlite3() {
  const bsqVersion = require(path.join(root, 'node_modules', 'better-sqlite3', 'package.json')).version;
  const fname = `better-sqlite3-v${bsqVersion}-node-v${NODE_ABI}-win32-x64.tar.gz`;
  const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${bsqVersion}/${fname}`;
  const cached = path.join(buildCache, fname);

  if (!fs.existsSync(cached)) {
    console.log(`[build:portable] downloading ${fname}`);
    await execFileP('curl', ['-fsSL', '-o', cached, url]);
  } else {
    console.log(`[build:portable] using cached ${fname}`);
  }

  const extractDir = path.join(buildCache, 'bsq-win');
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  await execFileP('tar', ['-xzf', cached, '-C', extractDir]);
  return path.join(extractDir, 'build', 'Release', 'better_sqlite3.node');
}

async function stageApp() {
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });

  // Copy node.exe to the zip root.
  const nodeExe = await ensureWindowsNode();
  fs.copyFileSync(nodeExe, path.join(stage, 'node.exe'));

  // Copy app source (excluding dev junk).
  const appDir = path.join(stage, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  for (const item of ['server', 'public', 'scripts', 'package.json', 'package-lock.json', '.env.example']) {
    const src = path.join(root, item);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(appDir, item);
    await execFileP('cp', ['-r', src, dst]);
  }

  // Install production deps inside the staged app (uses the host's npm).
  console.log('[build:portable] npm install --omit=dev (inside staged app)');
  await sh('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: appDir });

  // Swap better-sqlite3 native binary for the Windows prebuild.
  const winBsq = await ensureWindowsBetterSqlite3();
  const bsqDest = path.join(appDir, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  fs.mkdirSync(path.dirname(bsqDest), { recursive: true });
  fs.copyFileSync(winBsq, bsqDest);
  console.log('[build:portable] better-sqlite3.node → win32-x64');

  // Write the launcher .bat.
  const bat = [
    '@echo off',
    'setlocal',
    'cd /d "%~dp0"',
    'title TradeLab',
    'echo Starting TradeLab...',
    'node.exe app\\scripts\\launcher.mjs',
    'echo.',
    'echo TradeLab stopped. Press any key to close.',
    'pause >nul',
  ].join('\r\n') + '\r\n';
  fs.writeFileSync(path.join(stage, 'Start TradeLab.bat'), bat);

  // Plain README for the zip.
  const readme = [
    'TradeLab — portable Windows build',
    '=================================',
    '',
    '1. Double-click "Start TradeLab.bat".',
    '2. Your browser opens automatically to http://localhost:4173.',
    '3. To stop TradeLab, close the black console window.',
    '',
    'Your trade database lives in the "data" folder that gets created',
    'next to this file. Back it up by copying that folder.',
    '',
    'No installation needed. Move this folder anywhere. Delete it to',
    'fully uninstall.',
    '',
    'Optional: for SPX chart candles, paste a Massive.com or Polygon.io',
    'API key into a file named ".env" next to this README, like so:',
    '    MASSIVE_API_KEY=your_key_here',
  ].join('\r\n') + '\r\n';
  fs.writeFileSync(path.join(stage, 'README.txt'), readme);
}

async function makeZip() {
  fs.rmSync(outZip, { force: true });
  console.log('[build:portable] zipping…');
  await sh('zip', ['-rq', outZip, path.basename(stage)], { cwd: path.dirname(stage) });
  const size = (fs.statSync(outZip).size / (1024 * 1024)).toFixed(1);
  console.log(`[build:portable] ✓ built ${outZip} (${size} MB)`);
}

await stageApp();
await makeZip();
