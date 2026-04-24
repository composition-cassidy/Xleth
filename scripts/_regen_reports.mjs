// Regenerates theming-enrichment-review.md and theming-catalog-gaps.md
// from the already-mutated theming-audit-enriched.json.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(__dirname, 'theming-audit-enriched.json');
const data = JSON.parse(fs.readFileSync(src, 'utf8'));

const matches = data.matches;
const cc = data.confidenceCounts;
const tot = matches.length;

function pct(n) { return ((100 * n) / tot).toFixed(1) + '%'; }
function mdEscape(s) { return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' '); }
function truncate(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '\u2026' : s; }

// ── 1. Enrichment-review.md ──────────────────────────────────────────────────

const highMediumCount = cc.high + cc.medium;
const ds = data.dispatchStats?.bySubsystem ?? {};

// Recompute rule counts and assignment counts from mutated matches
const ruleCounts = {};
const assignmentCounts = new Map();
for (const m of matches) {
  if (m.assignmentRule) ruleCounts[m.assignmentRule] = (ruleCounts[m.assignmentRule] ?? 0) + 1;
  if (m.proposedTokenName) assignmentCounts.set(m.proposedTokenName, (assignmentCounts.get(m.proposedTokenName) ?? 0) + 1);
}

let rev = '';
rev += `# Theming Audit Enrichment — Review Document\n\n`;
rev += `Generated: ${new Date().toISOString()}\n\n`;
rev += `_Note: confidence counts and subsystem assignments reflect post-mutation state as of ${data._mutatedAt ?? 'unknown'}_\n\n`;
rev += `## Summary\n\n`;
rev += `- **Color matches enriched:** ${tot}\n\n`;
rev += `### Confidence tier breakdown\n\n`;
rev += `| Tier | Count | % |\n|---|---:|---:|\n`;
rev += `| HIGH | ${cc.high} | ${pct(cc.high)} |\n`;
rev += `| MEDIUM | ${cc.medium} | ${pct(cc.medium)} |\n`;
rev += `| LOW (must review) | ${cc.low} | ${pct(cc.low)} |\n`;
rev += `| NO-FIT (catalog gap) | ${cc['no-fit']} | ${pct(cc['no-fit'])} |\n`;
rev += `| FALSE-POSITIVE | ${cc['false-positive']} | ${pct(cc['false-positive'])} |\n`;
rev += `| **Rule-based (HIGH + MEDIUM)** | **${highMediumCount}** | **${pct(highMediumCount)}** |\n\n`;

rev += `### Subsystem distribution\n\n`;
rev += `| Subsystem | Count |\n|---|---:|\n`;
for (const [k, v] of Object.entries(ds).sort((a, b) => b[1] - a[1])) {
  rev += `| ${k} | ${v} |\n`;
}
rev += `\n`;

rev += `### Rule usage\n\n`;
rev += `| Rule | Count |\n|---|---:|\n`;
for (const [k, v] of Object.entries(ruleCounts).sort((a, b) => b[1] - a[1])) {
  rev += `| ${k} | ${v} |\n`;
}
rev += `\n`;

rev += `### Top 20 most-frequent assignments\n\n`;
rev += `| Token | Count |\n|---|---:|\n`;
for (const [k, v] of [...assignmentCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  rev += `| \`${k}\` | ${v} |\n`;
}
rev += `\n`;

// HIGH summary
rev += `## High-confidence assignments (summary)\n\n`;
const highByToken = new Map();
for (const m of matches) {
  if (m.confidence !== 'high') continue;
  const key = m.proposedTokenName ?? '(none)';
  if (!highByToken.has(key)) highByToken.set(key, { count: 0, rule: m.assignmentRule, samples: [] });
  const e = highByToken.get(key);
  e.count++;
  if (e.samples.length < 3) e.samples.push(`${m.path}:${m.line}`);
}
rev += `| Token | Count | Rule | Sample locations |\n|---|---:|---|---|\n`;
for (const [tok, info] of [...highByToken.entries()].sort((a, b) => b[1].count - a[1].count)) {
  rev += `| \`${tok}\` | ${info.count} | ${info.rule ?? ''} | ${info.samples.join(', ')} |\n`;
}
rev += `\n`;

// MEDIUM sample
rev += `## Medium-confidence assignments (first 100)\n\n`;
rev += `| File | Line | Value | Token | Rule | Rationale |\n|---|---:|---|---|---|---|\n`;
let medCount = 0;
for (const m of matches) {
  if (m.confidence !== 'medium') continue;
  if (medCount++ >= 100) break;
  rev += `| ${m.path} | ${m.line} | \`${mdEscape(truncate(m.matchedText, 40))}\` | \`${m.proposedTokenName ?? ''}\` | ${m.assignmentRule ?? ''} | ${mdEscape(truncate(m.rationale, 80))} |\n`;
}
rev += `\n`;

// LOW all
rev += `## Low-confidence assignments (all — review required)\n\n`;
rev += `| File | Line | Value | Token | Rationale |\n|---|---:|---|---|---|\n`;
for (const m of matches) {
  if (m.confidence !== 'low') continue;
  rev += `| ${m.path} | ${m.line} | \`${mdEscape(truncate(m.matchedText, 40))}\` | \`${m.proposedTokenName ?? ''}\` | ${mdEscape(truncate(m.rationale, 120))} |\n`;
}
rev += `\n`;

// NO-FIT all
rev += `## No-fit matches (all — catalog gaps)\n\n`;
rev += `| File | Line | Value | Subsystem | Element hint |\n|---|---:|---|---|---|\n`;
for (const m of matches) {
  if (m.confidence !== 'no-fit') continue;
  rev += `| ${m.path} | ${m.line} | \`${mdEscape(truncate(m.matchedText, 40))}\` | ${m.subsystem ?? ''} | ${m.elementHint ?? ''} |\n`;
}
rev += `\n`;

fs.writeFileSync(path.resolve(__dirname, 'theming-enrichment-review.md'), rev, 'utf8');
console.log('Wrote theming-enrichment-review.md');

// ── 2. theming-catalog-gaps.md ───────────────────────────────────────────────

const noFits = matches.filter(m => m.confidence === 'no-fit');
const groups = new Map();
for (const m of noFits) {
  const key = `${m.subsystem}::${m.elementHint ?? '(no hint)'}`;
  if (!groups.has(key)) groups.set(key, { subsystem: m.subsystem, element: m.elementHint ?? '(no hint)', items: [] });
  groups.get(key).items.push(m);
}

const bySub = new Map();
for (const g of groups.values()) {
  if (!bySub.has(g.subsystem)) bySub.set(g.subsystem, []);
  bySub.get(g.subsystem).push(g);
}

let gaps = '';
gaps += `# Catalog Gap Report\n\n`;
gaps += `Generated: ${new Date().toISOString()}\n\n`;
gaps += `## Summary\n\n`;
gaps += `- NO-FIT matches: ${noFits.length}\n`;
gaps += `- Unique (subsystem, element) gap groups: ${groups.size}\n\n`;
gaps += `Per rule: false-positive matches are NOT listed here — they are audit errors, not catalog gaps.\n\n`;
gaps += `## Gaps by subsystem\n\n`;

const subsSorted = [...bySub.entries()].sort((a, b) => {
  const ca = a[1].reduce((x, g) => x + g.items.length, 0);
  const cb = b[1].reduce((x, g) => x + g.items.length, 0);
  return cb - ca;
});

for (const [sub, groupsForSub] of subsSorted) {
  const total = groupsForSub.reduce((x, g) => x + g.items.length, 0);
  gaps += `### ${sub} (${total} matches across ${groupsForSub.length} groups)\n\n`;
  groupsForSub.sort((a, b) => b.items.length - a.items.length);
  for (const g of groupsForSub) {
    gaps += `- **Element "${g.element}"** — ${g.items.length} occurrence(s)\n`;
    const samples = g.items.slice(0, 3).map(i => `${i.path}:${i.line}`);
    gaps += `  - Samples: ${samples.join(', ')}\n`;
    const elementSlug = String(g.element).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
    gaps += `  - Proposed addition: \`--theme-${sub.replace(/\./g, '-')}-${elementSlug}\` *(suggestion only — requires approval)*\n`;
  }
  gaps += `\n`;
}

fs.writeFileSync(path.resolve(__dirname, 'theming-catalog-gaps.md'), gaps, 'utf8');
console.log('Wrote theming-catalog-gaps.md');
console.log(`NO-FIT groups: ${groups.size}  |  NO-FIT matches: ${noFits.length}`);
