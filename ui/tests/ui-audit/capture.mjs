// UI audit capture entry point (read-only against product code).
//   node tests/ui-audit/copy-project.mjs <PROJECT_PATH> <tempParent>          # never opens the original
//   node tests/ui-audit/capture.mjs <projectCopyDir> [--size 1920x1080] [--phases p01,p00,p10,...]
// Launches the built Electron app (XLETH_PLAYWRIGHT=1 -> ui/dist) against the COPY in an isolated profile, then runs the
// phase modules in tests/ui-audit/phases/ in order. Output (PNGs, metrics.partial.json) goes to the gitignored tests/ui-audit/out/.
// Then: node inventory.mjs && node assemble.mjs && node console-summary.mjs.
//
// NOTE: the phases were developed and run one by one through serve.mjs/send.mjs (a persistent driver) and some depend on
// state left by an earlier phase (p00 before p10/p50, p100 leaves an empty project that p105 reloads). The DEFAULT order below
// follows the order they were run in; the single-launch chain has not been run end to end.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as lib from './lib.mjs';

const args = process.argv.slice(2);
const projectDir = args.find((a) => !a.startsWith('--'));
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
if (!projectDir) { console.error('usage: capture.mjs <projectCopyDir> [--size WxH] [--phases a,b]'); process.exit(2); }
const [W, H] = opt('size', '1920x1080').split('x').map(Number);
const DEFAULT = ['p01-shell-tabs', 'p00-chain-setup', 'p10-devices', 'p20-timeline', 'p30-pianoroll', 'p40-sampler', 'p50-mixer', 'p60-fxgraph', 'p70-preview', 'p75-visualfx', 'p76-visualfx-scroll', 'p80-inspector', 'p90-browser', 'p05-shell-extras', 'p150-popovers', 'p151-color', 'p100-menus', 'p105-reload', 'p110-dialogs', 'p120-export-midi', 'p121-midi', 'p122-midi-dialog', 'p130-settings', 'p141-open-project'];
const LOWRES = ['p200-lowres'];
const phases = (opt('phases', null) ? opt('phases').split(',') : (W < 1500 ? LOWRES : DEFAULT));

const { app, page } = await lib.launch({ projectDir });
console.log('viewport', await lib.setViewport(app, page, W, H));
for (const p of phases) {
  const file = path.join(lib.HERE, 'phases', p + '.mjs');
  if (!fs.existsSync(file)) { console.log(`== ${p}: missing`); continue; }
  console.log(`== ${p}`);
  try { const mod = await import(pathToFileURL(file).href); console.log(await mod.default({ app, page, ...lib, W, H })); }
  catch (e) { console.log(`${p}: ERROR ${e && e.message}`); }
}
fs.writeFileSync(path.join(lib.OUT, `console-session-${Date.now()}.json`), JSON.stringify(lib.consoleLog));
await app.close();
