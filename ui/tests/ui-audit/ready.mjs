import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const p = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out', 'cmd', 'result.txt');
const t0 = Date.now();
while (Date.now() - t0 < 120000) { if (fs.existsSync(p)) { console.log(fs.readFileSync(p, 'utf8').trim()); process.exit(0); } await new Promise((r) => setTimeout(r, 500)); }
console.log('not ready'); process.exit(1);
