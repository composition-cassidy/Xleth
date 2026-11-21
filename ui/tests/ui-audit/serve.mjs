// Exploration driver: launches the app once, then runs command modules dropped into out/cmd/.
//   node tests/ui-audit/serve.mjs <projectCopyDir> [w h]
// A command is out/cmd/next.mjs exporting `default async (ctx) => any`. Its return value / error goes to out/cmd/result.txt.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as lib from './lib.mjs';

const projectDir = process.argv[2];
const W = Number(process.argv[3] || 1920); const H = Number(process.argv[4] || 1080);
const CMD = path.join(lib.OUT, 'cmd');
fs.mkdirSync(CMD, { recursive: true });
for (const f of fs.readdirSync(CMD)) fs.rmSync(path.join(CMD, f), { force: true });

const { app, page, profile } = await lib.launch({ projectDir });
console.log('launched', await lib.setViewport(app, page, W, H), 'profile', profile);
fs.writeFileSync(path.join(CMD, 'result.txt'), 'READY\n');

let n = 0;
for (;;) {
  const next = path.join(CMD, 'next.mjs');
  if (fs.existsSync(next)) {
    n += 1;
    const target = fs.readFileSync(next, 'utf8').trim();
    fs.rmSync(next, { force: true });
    let out;
    try {
      const mod = await import(pathToFileURL(target).href + '?run=' + n);
      const r = await mod.default({ app, page, ...lib, W, H });
      out = typeof r === 'string' ? r : JSON.stringify(r, null, 1);
    } catch (e) { out = 'ERROR: ' + (e && e.stack || e); }
    fs.writeFileSync(path.join(CMD, 'result.txt'), `DONE ${n}\n` + (out ?? '') + '\n');
  }
  if (fs.existsSync(path.join(CMD, 'quit'))) break;
  await lib.sleep(250);
}
await app.close();
