// Finds (and with --apply deletes) rules in the frozen legacy stylesheet whose class selectors match nothing the renderer can render.
//   node scripts/prune-dead-css.mjs            report only
//   node scripts/prune-dead-css.mjs --apply    rewrite src/styles/app.css, then run `npm run check:legacy-css -- --update`
// A class is LIVE if its name appears in any non-test source file under src/ (or index.html), or if it starts with a dynamic
// prefix that source builds at run time (`'track-' + type`, `fx-${id}`). A selector is dead when it needs a dead class
// (classes inside :not() are not required). A rule is deleted when every selector in its list is dead; a list with some dead
// selectors loses just those. @keyframes are deleted when no stylesheet or source file names them. Nothing else is touched.
import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import { UI_ROOT } from './legacy-css-lib.mjs';

const NL = String.fromCharCode(10); const NL1 = NL + '  '; const NL2 = NL + NL + '  ';
const apply = process.argv.includes('--apply');
const CSS = path.join(UI_ROOT, 'src/styles/app.css');
const SRC = path.join(UI_ROOT, 'src');

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '__tests__' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};
const files = walk(SRC);
const isCss = (f) => f.endsWith('.css');
const corpus = [...files.filter((f) => !isCss(f) && !/\.test\./.test(f)), path.join(UI_ROOT, 'index.html')]
  .filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const otherCss = files.filter((f) => isCss(f) && path.resolve(f) !== path.resolve(CSS)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');

// dynamic prefixes: 'abc-' + x   "abc-" + x   `abc-${x}`
const prefixes = new Set();
for (const m of corpus.matchAll(/([A-Za-z][\w-]*-)(?=\$\{|['"`]\s*\+)/g)) if (m[1].length >= 4) prefixes.add(m[1]);
const esc = (c) => c.replace(/[.*+?^${}()|[\]\\-]/g, (m) => '\\' + m);
const tokenCache = new Map();
// whole-token match (so `eq-band` is not kept alive by `eq-band-popup`); xyflow's own classes are generated in node_modules
const classLive = (c) => {
  if (/^(react-flow|xy-)/.test(c)) return true;
  if (!tokenCache.has(c)) tokenCache.set(c, new RegExp('(^|[^\\w-])' + esc(c) + '(?![\\w-])').test(corpus) || [...prefixes].some((p) => c.startsWith(p)));
  return tokenCache.get(c);
};

const src = fs.readFileSync(CSS, 'utf8');
const root = postcss.parse(src, { from: CSS });
const stats = { rulesRemoved: 0, selectorsTrimmed: 0, keyframesRemoved: 0, atrulesRemoved: 0, linesBefore: src.split('\n').length };
const removedClasses = new Set();

function selectorDead(sel) {
  let dead = false;
  try {
    selectorParser((root2) => {
      root2.walkClasses((n) => {
        let p = n.parent; let inNot = false;
        while (p) { if (p.type === 'pseudo' && p.value === ':not') { inNot = true; break; } p = p.parent; }
        if (!inNot && !classLive(n.value)) { dead = true; removedClasses.add(n.value); }
      });
    }).processSync(sel);
  } catch { return false; }
  return dead;
}

root.walkRules((rule) => {
  if (rule.parent && rule.parent.type === 'atrule' && /keyframes/.test(rule.parent.name)) return;
  const sels = rule.selectors;
  const keep = sels.filter((s) => !selectorDead(s));
  if (keep.length === sels.length) return;
  if (!keep.length) { rule.remove(); stats.rulesRemoved += 1; } else { rule.selectors = keep; stats.selectorsTrimmed += sels.length - keep.length; }
});
root.walkAtRules(/keyframes$/, (at) => {
  const name = at.params.trim();
  const used = new RegExp(`(^|[^\\w-])${name.replace(/[-]/g, '\\-')}([^\\w-]|$)`);
  const inThisSheet = root.toString().replace(at.toString(), '');
  if (!used.test(inThisSheet) && !used.test(otherCss) && !corpus.includes(name)) { at.remove(); stats.keyframesRemoved += 1; }
});
root.walkAtRules((at) => { if (/^(media|supports|layer)$/.test(at.name) && at.nodes && !at.nodes.some((n) => n.type !== 'comment')) { at.remove(); stats.atrulesRemoved += 1; } });
// Duplicate :root blocks: fold every top-level `:root { ... }` into the first one (only when no custom property is declared twice,
// so the cascade cannot change). The comment that headed a later block moves in with its declarations.
{
  const roots = root.nodes.filter((n) => n.type === 'rule' && n.selector.trim() === ':root');
  const seen = new Map(); let clash = null;
  for (const r of roots) for (const d of r.nodes.filter((x) => x.type === 'decl')) { if (seen.has(d.prop)) clash = d.prop; seen.set(d.prop, true); }
  stats.rootBlocks = roots.length;
  if (roots.length > 1 && !clash) {
    const [first, ...rest] = roots;
    for (const r of rest) {
      const prev = r.prev();
      const head = prev && prev.type === 'comment' ? prev : null;
      if (head) { first.append(head.clone({ raws: { before: NL2 } })); head.remove(); }
      for (const n of [...r.nodes]) { n.raws.before = n.raws.before && n.raws.before.includes(NL) ? n.raws.before : NL1; first.append(n); }
      r.remove();
    }
    stats.rootMerged = rest.length;
  } else if (clash) stats.rootClash = clash;
}
// a comment that headed a now-empty section: drop block comments directly followed by another comment-only gap is too risky; report instead
let out = root.toString();
const CRLF = String.fromCharCode(13, 10);
if (src.includes(CRLF)) out = out.split(CRLF).join(NL).split(NL).join(CRLF);   // the sheet is CRLF throughout
stats.linesAfter = out.split('\n').length;
console.log(JSON.stringify({ ...stats, deadClassCount: removedClasses.size, sampleDeadClasses: [...removedClasses].slice(0, 40) }, null, 1));
if (apply) { fs.writeFileSync(CSS, out); console.log('app.css rewritten'); }
