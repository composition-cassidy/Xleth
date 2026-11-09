// UI audit capture entry point (read-only against product code). ONE launch runs the whole chain.
//   node tests/ui-audit/copy-project.mjs <PROJECT_PATH> <tempParent>          # never opens the original
//   node tests/ui-audit/mk-missing.mjs                                         # builds <tempParent>/tiki-missing for p141
//   node tests/ui-audit/capture.mjs <projectCopyDir> [--phases a,b,...] [--no-finish]
// Launches the built Electron app (XLETH_PLAYWRIGHT=1 -> ui/dist) against the COPY in an isolated profile, then runs the phase
// modules in tests/ui-audit/phases/ in CHAIN order. Output (PNGs, metrics.partial.json) goes to the gitignored tests/ui-audit/out/.
// At the end it runs inventory.mjs, assemble.mjs and console-summary.mjs (skip with --no-finish).
//
// The chain order encodes the state each phase leaves for the next one; do not reorder without reading the notes:
//   p01  fresh project, nothing selected (shots 01-06 must see an untouched Inspector)
//   p00  puts one of every stock effect in the base track's chain (p10 / p50 depend on it)
//   p20  collapses the dock, normalises zoom to 40 px/beat, makes the arrangement the reference layout for the pixel clicks below
//   p19  timeline polish; restores the default lane height (p80 clicks pixels)
//   p41  sampler at the DEFAULT dock height; must run BEFORE p30, which drags the dock taller
//   p60  FX Graph adds Macro / LFO / Envelope / Sidechain nodes on ch1; p61 (after p80) then adds the macro automation lane,
//        because a lane under ch1 shifts every track below it
//   p100 -> p105: Unsaved-changes dialog, then File > New Project (Discard) = the empty project; p105 reloads the SAVED copy
//   p141 last: opens a different project (tiki-missing)
// '@WxH' entries change the window size; low-res runs inside the same launch and returns to the main size.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as lib from './lib.mjs';

const args = process.argv.slice(2);
const projectDir = args[0] && !args[0].startsWith('--') ? args[0] : null;
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
if (!projectDir) { console.error('usage: capture.mjs <projectCopyDir> [--size WxH] [--phases a,b] [--no-finish]'); process.exit(2); }
const [W, H] = opt('size', '1920x1080').split('x').map(Number);

export const CHAIN = [
  'p01-shell-tabs', 'p00-chain-setup', 'p10-devices',
  'p20-timeline', 'p19-timeline-polish',
  'p41-sampler-default-dock', 'p30-pianoroll', 'p40-sampler',
  'p50-mixer', 'p60-fxgraph',
  'p70-preview', 'p75-visualfx', 'p76-visualfx-scroll',
  'p80-inspector', 'p61-macro-lane',
  'p90-browser', 'p05-shell-extras', 'p150-popovers', 'p210-ctx-convert',
  'p100-menus', 'p105-reload',
  '@1366x768', 'p200-lowres', '@' + W + 'x' + H,
  'p120-export-midi', 'p130-settings', 'p141-open-project',
];
const phases = opt('phases', null) ? opt('phases').split(',') : CHAIN;
const TIMEOUT = { 'p00-chain-setup': 20, 'p10-devices': 25 };   // minutes; default 12

const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}: timed out after ${Math.round(ms / 60000)} min`)), ms))]);
const sleep = lib.sleep;

const { app, page } = await lib.launch({ projectDir });
console.log('viewport', await lib.setViewport(app, page, W, H));
let curW = W; let curH = H; let aborted = false;
for (const p of phases) {
  if (p.startsWith('@')) {
    [curW, curH] = p.slice(1).split('x').map(Number);
    console.log(`== resize ${curW}x${curH}`, JSON.stringify(await lib.setViewport(app, page, curW, curH)));
    await sleep(800);
    continue;
  }
  const file = path.join(lib.HERE, 'phases', p + '.mjs');
  if (!fs.existsSync(file)) { console.log(`== ${p}: missing`); continue; }
  console.log(`== ${p}`);
  const t0 = Date.now();
  try {
    await page.keyboard.up('Control').catch(() => {}); await page.keyboard.up('Alt').catch(() => {}); await page.keyboard.up('Shift').catch(() => {});
    const mod = await import(pathToFileURL(file).href);
    console.log(await withTimeout(mod.default({ app, page, ...lib, W: curW, H: curH, projectDir }), (TIMEOUT[p] || 12) * 60000, p));
  } catch (e) { console.log(`${p}: ERROR ${e && e.message}`); }
  console.log(`   (${Math.round((Date.now() - t0) / 1000)} s)`);
  // The next phase starts from a quiet UI: no menus, no held modifiers. A dead renderer ends the run, keeping what was captured.
  try {
    await page.keyboard.up('Control'); await page.keyboard.up('Alt'); await page.keyboard.up('Shift');
    for (let i = 0; i < 2; i++) { await page.keyboard.press('Escape'); await sleep(120); }
    await withTimeout(page.evaluate(() => 1), 15000, 'liveness');
  } catch (e) { console.log(`renderer not responding after ${p}: ${e.message}; stopping the chain`); aborted = true; break; }
}
fs.writeFileSync(path.join(lib.OUT, `console-session-${Date.now()}.json`), JSON.stringify(lib.consoleLog));
await app.close().catch(() => {});

if (!args.includes('--no-finish') && !opt('phases', null)) {
  for (const s of ['inventory.mjs', 'assemble.mjs', 'console-summary.mjs']) {
    const r = spawnSync(process.execPath, [path.join(lib.HERE, s)], { cwd: lib.UI_DIR, encoding: 'utf8' });
    console.log(`== ${s}: exit ${r.status}\n${(r.stdout || '').slice(-1200)}${(r.stderr || '').slice(-600)}`);
  }
}
if (aborted) process.exit(1);
