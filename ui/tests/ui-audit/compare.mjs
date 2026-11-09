// Builds out/COMPARE.md: the 2026-11-07 baseline against the latest full recapture, per surface.
//   node tests/ui-audit/compare.mjs [baseline.json] [after.json]
// Targets for every surface: 0 text nodes below 4.5:1, 0 below 10px, no letter-spaced uppercase, at most 4 distinct font sizes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const basePath = process.argv[2] || path.join(OUT, 'baseline-2026-11-07', 'metrics.json');
const afterPath = process.argv[3] || path.join(OUT, 'metrics.json');
const before = JSON.parse(fs.readFileSync(basePath, 'utf8'));
const after = JSON.parse(fs.readFileSync(afterPath, 'utf8'));
const NOTES = fs.existsSync(path.join(HERE, 'compare-notes.json')) ? JSON.parse(fs.readFileSync(path.join(HERE, 'compare-notes.json'), 'utf8')) : {};

const px = (s) => parseFloat(s);
function agg(shots) {
  const a = { shots: shots.length, text: 0, low: 0, small: 0, caps: 0, fs: 0, fsList: new Set(), borders: 0, style: 0, offenders: [], capSamples: [], names: [] };
  for (const s of shots) {
    a.names.push(s.shot.replace('.png', ''));
    if (!s.text) continue;
    a.text += s.text.total; a.low += s.text.lowContrast; a.small += s.text.small;
    a.caps += s.letterSpacedUppercaseCount || 0;
    a.fs = Math.max(a.fs, s.distinctFontSizes || 0);
    (s.fontSizeList || []).forEach((f) => a.fsList.add(f));
    a.borders = Math.max(a.borders, s.distinctBorderColors || 0);
    a.style += s.styleAttrs || 0;
    for (const e of (s.text.entries || [])) if (a.offenders.length < 400) a.offenders.push({ ...e, shot: s.shot.replace('.png', '') });
    for (const c of (s.letterSpacedSamples || [])) if (a.capSamples.length < 40) a.capSamples.push({ ...c, shot: s.shot.replace('.png', '') });
  }
  a.fsSorted = [...a.fsList].sort((x, y) => px(x) - px(y));
  return a;
}
const bySurface = (m) => { const g = new Map(); for (const s of m.shots) { const k = s.surface || '(none)'; (g.get(k) || g.set(k, []).get(k)).push(s); } return g; };
const B = bySurface(before); const A = bySurface(after);
const surfaces = [...new Set([...B.keys(), ...A.keys()])].sort();
const rows = surfaces.map((k) => ({ k, b: B.has(k) ? agg(B.get(k)) : null, a: A.has(k) ? agg(A.get(k)) : null }));

const fails = (a) => { const r = []; if (a.low) r.push(`${a.low} below 4.5:1`); if (a.small) r.push(`${a.small} under 10px`); if (a.caps) r.push(`${a.caps} letter-spaced caps`); if (a.fs > 4) r.push(`${a.fs} font sizes`); return r; };
const worse = (b, a) => b && a && (a.low > b.low || a.small > b.small || a.caps > b.caps || a.fs > b.fs);
const topWhere = (a) => {
  const m = new Map();
  for (const e of a.offenders) { const k = e.where.replace(/\s+/g, ' '); const v = m.get(k) || { n: 0, ex: e.text, why: new Set() }; v.n += 1; e.reasons.forEach((r) => v.why.add(r === 'size' ? `${e.fontPx}px` : `${e.ratio}:1`)); m.set(k, v); }
  return [...m.entries()].sort((x, y) => y[1].n - x[1].n).slice(0, 3).map(([w, v]) => `\`${w}\` "${v.ex}" (${[...v.why].slice(0, 2).join(', ')})`).join('; ');
};
const cell = (b, a, key) => (b ? b[key] : '-') + ' → ' + (a ? a[key] : '-');
const fmtFs = (a) => (a ? `${a.fs}` : '-');

const tot = (m) => ({ shots: m.totals.shots, text: m.totals.textNodes, low: m.totals.below4_5, small: m.totals.below10px });
const tb = tot(before); const ta = tot(after);
const capsTotal = (m) => m.shots.reduce((n, s) => n + (s.letterSpacedUppercaseCount || 0), 0);
const styleTotal = (m) => m.shots.reduce((n, s) => n + (s.styleAttrs || 0), 0);

let md = `# UI audit comparison: 2026-11-07 baseline → ${after.generated.slice(0, 10)} recapture\n\n`;
md += `Baseline \`${path.relative(OUT, basePath)}\` (${before.generated.slice(0, 10)}, ${tb.shots} shots) against \`${path.relative(OUT, afterPath)}\` (${after.generated.slice(0, 10)}, ${ta.shots} shots). Same project copy (\`SR\\tiki\`), theme \`xleth-default\`, UI scale 100 %, 1920×1080 (+1366×768 low-res).\n`;
md += `Metrics are the harness's: visible text nodes in the shot's scope with WCAG ratio < 4.5 (disabled controls exempt) or computed size < 10 px; letter-spaced = computed letter-spacing > 0 on text that is uppercase by transform or typed in capitals (counted per shot, capped at 40 samples); font sizes / border colours are distinct computed values. Whole-window shots (scope \`null\`) count everything visible, so a surface listed from a dock-scoped shot also counts whatever else sits in that dock. Canvas pixels are not text and are not audited.\n\n`;
md += `## Totals\n\n| | 2026-11-07 | recapture | change |\n|---|---:|---:|---:|\n`;
md += `| shots | ${tb.shots} | ${ta.shots} | ${ta.shots - tb.shots >= 0 ? '+' : ''}${ta.shots - tb.shots} |\n`;
md += `| text nodes audited | ${tb.text} | ${ta.text} | ${ta.text - tb.text >= 0 ? '+' : ''}${ta.text - tb.text} |\n`;
md += `| below 4.5:1 | ${tb.low} | ${ta.low} | ${ta.low - tb.low} |\n`;
md += `| under 10 px | ${tb.small} | ${ta.small} | ${ta.small - tb.small} |\n`;
md += `| letter-spaced uppercase (sum over shots) | ${capsTotal(before)} | ${capsTotal(after)} | ${capsTotal(after) - capsTotal(before)} |\n`;
md += `| \`style=\` attributes (sum over shots) | ${styleTotal(before)} | ${styleTotal(after)} | ${styleTotal(after) - styleTotal(before)} |\n\n`;

// regressions first
const regress = rows.filter((r) => worse(r.b, r.a));
md += `## 1. Regressions (a metric got worse than the baseline)\n\n`;
if (!regress.length) md += `None.\n\n`;
else {
  md += `| Surface | <4.5:1 | <10px | caps | font sizes | Where / why |\n|---|---|---|---|---|---|\n`;
  for (const r of regress) md += `| ${r.k} | ${cell(r.b, r.a, 'low')} | ${cell(r.b, r.a, 'small')} | ${cell(r.b, r.a, 'caps')} | ${cell(r.b, r.a, 'fs')} | ${[NOTES[r.k], topWhere(r.a)].filter(Boolean).join(' | ') || 'more of the same elements are on screen in the new shots'} |\n`;
  md += `\n`;
}

// still missing targets
const missing = rows.filter((r) => r.a && fails(r.a).length);
md += `## 2. Surfaces still missing the targets (0 / 0 / none / ≤4)\n\n`;
if (!missing.length) md += `None.\n\n`;
else {
  md += `| Surface | Missing | Shots | Reason (largest offenders) |\n|---|---|---|---|\n`;
  for (const r of missing.sort((x, y) => (y.a.low + y.a.small + y.a.caps) - (x.a.low + x.a.small + x.a.caps))) {
    const reasons = [NOTES[r.k], topWhere(r.a), r.a.caps ? 'caps: ' + [...new Set(r.a.capSamples.map((c) => `"${c.text}" ${c.where}`))].slice(0, 2).join('; ') : '', r.a.fs > 4 ? 'sizes: ' + r.a.fsSorted.join(' ') : ''].filter(Boolean).join(' | ');
    md += `| ${r.k} | ${fails(r.a).join(', ')} | ${r.a.names.slice(0, 3).join(', ')}${r.a.names.length > 3 ? ` (+${r.a.names.length - 3})` : ''} | ${reasons} |\n`;
  }
  md += `\n`;
}
const clean = rows.filter((r) => r.a && !fails(r.a).length);
md += `Surfaces meeting all four targets: **${clean.length} of ${rows.filter((r) => r.a).length}**.\n\n`;

// per surface table
md += `## 3. Per surface, before → after\n\n`;
md += `Columns: shots · text nodes · below 4.5:1 · under 10px · letter-spaced caps · distinct font sizes (max over the surface's shots) · distinct border colours (max) · \`style=\` attributes.\n\n`;
md += `| Surface | shots | text | <4.5:1 | <10px | caps | font sizes | borders | style= | target |\n|---|---|---|---|---|---|---|---|---|---|\n`;
for (const r of rows) {
  md += `| ${r.k} | ${cell(r.b, r.a, 'shots')} | ${cell(r.b, r.a, 'text')} | ${cell(r.b, r.a, 'low')} | ${cell(r.b, r.a, 'small')} | ${cell(r.b, r.a, 'caps')} | ${cell(r.b, r.a, 'fs')} | ${cell(r.b, r.a, 'borders')} | ${cell(r.b, r.a, 'style')} | ${!r.a ? 'not re-shot' : fails(r.a).length ? 'MISSING' : 'ok'} |\n`;
}
md += `\nFont-size sets (after): \n\n`;
for (const r of rows) if (r.a) md += `- ${r.k}: ${r.a.fsSorted.join(', ')}${r.b ? `  (before: ${r.b.fsSorted.join(', ')})` : ''}\n`;

// shots
const bn = new Set(before.shots.map((s) => s.shot)); const an = new Set(after.shots.map((s) => s.shot));
md += `\n## 4. Shot coverage\n\n`;
md += `Baseline shots not re-taken: ${[...bn].filter((n) => !an.has(n)).map((n) => n.replace('.png', '')).join(', ') || 'none'}\n\n`;
md += `New shots (not in the baseline): ${[...an].filter((n) => !bn.has(n)).map((n) => n.replace('.png', '')).join(', ') || 'none'}\n\n`;
const footer = path.join(HERE, 'compare-footer.md');
if (fs.existsSync(footer)) md += fs.readFileSync(footer, 'utf8');
fs.writeFileSync(path.join(OUT, 'COMPARE.md'), md);
console.log(`COMPARE.md written: ${rows.length} surfaces, ${regress.length} regressed, ${missing.length} missing targets, ${clean.length} clean`);
