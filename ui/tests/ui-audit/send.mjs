// node send.mjs <commandFile.mjs> [timeoutSec]  -> runs it in the serve.mjs driver and prints the result.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CMD = path.join(HERE, 'out', 'cmd');
const file = process.argv[2]; const to = Number(process.argv[3] || 120) * 1000;
const resultPath = path.join(CMD, 'result.txt');
const before = fs.existsSync(resultPath) ? fs.readFileSync(resultPath, 'utf8') : '';
fs.writeFileSync(path.join(CMD, 'next.tmp'), path.resolve(file));
fs.renameSync(path.join(CMD, 'next.tmp'), path.join(CMD, 'next.mjs'));
const t0 = Date.now();
for (;;) {
  await new Promise((r) => setTimeout(r, 300));
  const cur = fs.existsSync(resultPath) ? fs.readFileSync(resultPath, 'utf8') : '';
  if (cur !== before && /^(DONE|ERROR)/.test(cur)) { console.log(cur); break; }
  if (Date.now() - t0 > to) { console.log('TIMEOUT waiting for result'); break; }
}
