// Summarises console output from the audit runs: renderer warnings/errors + main/engine lines that look like errors, grouped by [Prefix].
// Inputs: out/console-session-*.json (driver-side capture of one session) and the app's own session logs in the audit profiles (last 8000 lines each).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const groups = new Map();
const add = (src, level, text) => {
  const m = text.match(/^\s*(?:\[(?:engine:err|engine|renderer|main)\]\s*)?(\[[A-Za-z][\w :.\/-]{0,30}\])/);
  const prefix = m ? m[1] : (/Canvas2D/.test(text) ? '[Canvas2D]' : '(no prefix)');
  const norm = text.replace(/\d+(\.\d+)?/g, 'N').slice(0, 170);
  const key = `${level}|${prefix}|${norm}`;
  const g = groups.get(key) || { level, prefix, text: text.slice(0, 220), count: 0, sources: new Set() };
  g.count += 1; g.sources.add(src); groups.set(key, g);
};
const isBad = (level, text) => level === 'renderer/error' || level === 'renderer/warning' || level === 'pageerror' || level === 'warning' || level === 'error' || (/main\//.test(level) && /\b(error|failed|exception|fatal|cannot|could not|unhandled)\b/i.test(text) && !/error=0|errors=0|ErrorCount/i.test(text));

// 1. driver-side capture
for (const f of fs.readdirSync(OUT).filter((x) => /^console-session-.*\.json$/.test(x))) {
  for (const l of JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'))) {
    const level = l.tag === 'main' ? 'main/' + l.type : l.type === 'warning' || l.type === 'error' || l.type === 'pageerror' ? l.type : 'info';
    if (isBad(level, l.text)) add('driver:' + f.slice(16, 29), level, l.text);
  }
}
// 2. the app's own session logs
const tmp = os.tmpdir();
let logFiles = 0;
for (const d of fs.readdirSync(tmp).filter((x) => x.startsWith('xleth-audit-profile-'))) {
  const ld = path.join(tmp, d, 'logs');
  if (!fs.existsSync(ld)) continue;
  for (const f of fs.readdirSync(ld).filter((x) => x.endsWith('.txt'))) {
    logFiles += 1;
    for (const line of fs.readFileSync(path.join(ld, f), 'utf8').split('\n')) {
      const m = line.match(/^\[\d\d:\d\d:\d\d\.\d+\] \[([^\]]+)\] (.*)$/);
      if (!m) continue;
      if (isBad(m[1], m[2])) add('log:' + f.slice(21, 36), m[1], m[2]);
    }
  }
}
const byPrefix = new Map();
for (const g of groups.values()) { const a = byPrefix.get(g.prefix) || []; a.push(g); byPrefix.set(g.prefix, a); }
let md = `# Console warnings and errors seen during capture\n\nSources: ${logFiles} app session logs (each holds only the LAST 8000 lines of its session; about 180,000 earlier lines were dropped by the app's ring buffer) plus the driver-side capture of the final 1366x768 session.\n\n`;
for (const [prefix, arr] of [...byPrefix.entries()].sort((a, b) => b[1].reduce((s, g) => s + g.count, 0) - a[1].reduce((s, g) => s + g.count, 0))) {
  md += `## ${prefix} (${arr.reduce((s, g) => s + g.count, 0)} lines, ${arr.length} distinct)\n`;
  for (const g of arr.sort((a, b) => b.count - a.count).slice(0, 8)) md += `- x${g.count} [${g.level}] ${g.text.replace(/\s+/g, ' ')}\n`;
  md += '\n';
}
fs.writeFileSync(path.join(OUT, 'console-summary.md'), md);
console.log(md.slice(0, 6000));
