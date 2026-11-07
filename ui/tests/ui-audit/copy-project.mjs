// Copies a project to a temp folder and rewrites absolute paths that point into the original folder,
// so the engine never reads/writes the user's project. Usage: node copy-project.mjs <srcDir> <destParent>
import fs from 'node:fs';
import path from 'node:path';

const [src, destParent] = process.argv.slice(2);
if (!src || !destParent) { console.error('usage: copy-project.mjs <srcDir> <destParent>'); process.exit(2); }
const dest = path.join(destParent, path.basename(src));
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
const pj = path.join(dest, 'project.json');
let s = fs.readFileSync(pj, 'utf8');
const jsonEsc = (p) => p.replace(/\\/g, '\\\\');
let total = 0;
for (const [a, b] of [[jsonEsc(src), jsonEsc(dest)], [src.replace(/\\/g, '/'), dest.replace(/\\/g, '/')]]) {
  const n = s.split(a).length - 1; total += n; s = s.split(a).join(b);
}
fs.writeFileSync(pj, s);
console.log(JSON.stringify({ dest, rewritten: total }));
