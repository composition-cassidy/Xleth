#!/usr/bin/env node
// Builds vendor/node/xleth-host/node.exe: a copy of vendor/node/node.exe with
// the XLETH icon and version strings stamped in by rcedit.
//
// The file MUST stay named node.exe. xleth_native.node imports its N-API
// symbols from a module called "node.exe"; the loader only resolves that to
// the running exe when the names match. Renamed, it loads a second Node from
// disk and the worker dies with 0xC0000005 on require(). Volume Mixer and
// Task Manager show the embedded FileDescription and icon, not the filename.
//
// Why: the engine worker (addon-worker.js) is a forked Node process, and it is
// the process that opens the audio device. Windows' Volume Mixer, Task Manager
// and the taskbar's audio overlay take their icon and label from that exe, so
// with a stock node.exe XLETH showed up as "Node.js JavaScript Runtime" with
// the Node icon. electron-main/worker.js prefers the branded copy when it exists.
//
// Usage: node scripts/brand-engine-host.cjs [--strict]
//   Skips work when the output is newer than node.exe and the icon.
//   Without --strict a missing node.exe / rcedit is a warning (dev keeps
//   working on the plain node.exe); with --strict it fails the build.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const strict = process.argv.includes('--strict');
const repoRoot = path.resolve(__dirname, '..', '..');
const nodeExe = path.join(repoRoot, 'vendor', 'node', 'node.exe');
const outDir = path.join(repoRoot, 'vendor', 'node', 'xleth-host');
const outExe = path.join(outDir, 'node.exe');
const iconPath = path.join(repoRoot, 'ui', 'assets', 'icon.ico');

function bail(msg) {
  if (strict) {
    console.error(`[brand-engine-host] ${msg}`);
    process.exit(1);
  }
  console.warn(`[brand-engine-host] ${msg} — engine will run under plain node.exe`);
  process.exit(0);
}

function findRcedit() {
  if (process.env.XLETH_RCEDIT && fs.existsSync(process.env.XLETH_RCEDIT)) {
    return process.env.XLETH_RCEDIT;
  }
  // electron-builder downloads rcedit into its winCodeSign cache on first
  // Windows build; reuse it rather than adding a dependency.
  const cacheRoot = process.env.ELECTRON_BUILDER_CACHE
    || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron-builder', 'Cache');
  const wcs = path.join(cacheRoot, 'winCodeSign');
  if (!fs.existsSync(wcs)) return null;
  for (const dir of fs.readdirSync(wcs).sort().reverse()) {
    const candidate = path.join(wcs, dir, 'rcedit-x64.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

if (process.platform !== 'win32') process.exit(0);
if (!fs.existsSync(nodeExe)) bail(`missing ${nodeExe}`);
if (!fs.existsSync(iconPath)) bail(`missing ${iconPath}`);

if (fs.existsSync(outExe)) {
  const outTime = fs.statSync(outExe).mtimeMs;
  if (outTime >= fs.statSync(nodeExe).mtimeMs && outTime >= fs.statSync(iconPath).mtimeMs) {
    process.exit(0);
  }
}

const rcedit = findRcedit();
if (!rcedit) bail('rcedit not found (set XLETH_RCEDIT or run electron-builder once to populate its cache)');

const nodeVersion = execFileSync(nodeExe, ['-p', 'process.versions.node'], { encoding: 'utf8' }).trim();
fs.mkdirSync(outDir, { recursive: true });
const tmpExe = path.join(outDir, 'node.tmp.exe');
fs.copyFileSync(nodeExe, tmpExe);
try {
  execFileSync(rcedit, [
    tmpExe,
    '--set-icon', iconPath,
    '--set-version-string', 'FileDescription', 'XLETH',
    '--set-version-string', 'ProductName', 'XLETH',
    '--set-version-string', 'CompanyName', 'XLETH',
    '--set-version-string', 'InternalName', 'node',
    '--set-version-string', 'OriginalFilename', 'node.exe',
    '--set-version-string', 'Comments', `XLETH audio/video engine host (Node ${nodeVersion})`,
  ], { stdio: 'inherit' });
  fs.renameSync(tmpExe, outExe);
} catch (err) {
  try { fs.unlinkSync(tmpExe); } catch (_) { /* ignore */ }
  bail(`rcedit failed: ${err.message}`);
}
console.log(`[brand-engine-host] wrote ${outExe}`);
