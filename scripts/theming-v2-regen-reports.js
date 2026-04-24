#!/usr/bin/env node
// Step 6 — regenerate theming-enrichment-review.md + theming-catalog-gaps.md from v2.
'use strict';
const fs = require('fs');
const path = require('path');

const v2path = path.resolve(__dirname, 'theming-audit-enriched-v2.json');
const v2 = JSON.parse(fs.readFileSync(v2path, 'utf8'));
const entries = v2.entries;
const today = '2026-04-20';

// Tier + rule breakdowns
const tiers = { high: 0, medium: 0, low: 0, 'no-fit': 0, 'false-positive': 0 };
const rules = new Map();
for (const e of entries) {
  tiers[e.confidence] = (tiers[e.confidence] || 0) + 1;
  rules.set(e.assignmentRule, (rules.get(e.assignmentRule) || 0) + 1);
}
const ruleRows = [...rules.entries()].sort((a, b) => b[1] - a[1]);

// ---------- review.md ----------
function compactCtx(s) {
  return (s || '').split('\n').map(l => l.trim()).filter(Boolean).join(' | ').slice(0, 220);
}

const lows = entries.filter(e => e.confidence === 'low');
const fps = entries.filter(e => e.confidence === 'false-positive');

let review = '';
review += `# Theming Enrichment Review (v2)\n\n`;
review += `Generated: ${today} (Step 6 — v2 classifier output)\n`;
review += `Classifier: ${v2.classifierVersion || 'v2'}\n`;
review += `Source: \`scripts/theming-audit-enriched-v2.json\`\n\n`;

review += `## Tier counts\n\n`;
review += `| Tier | Count |\n|---|---:|\n`;
review += `| HIGH | ${tiers.high} |\n`;
review += `| MEDIUM | ${tiers.medium} |\n`;
review += `| LOW | ${tiers.low} |\n`;
review += `| NO-FIT | ${tiers['no-fit']} |\n`;
review += `| FALSE-POSITIVE | ${tiers['false-positive']} |\n`;
review += `| **Total** | **${entries.length}** |\n\n`;

review += `## Rule usage\n\n`;
review += `| Rule | Count |\n|---|---:|\n`;
for (const [r, c] of ruleRows) review += `| \`${r}\` | ${c} |\n`;
review += `\n`;

review += `## MEDIUM correctness audit (Step 5)\n\n`;
review += `- Sample size: 30 (weighted by subsystem, seeded mulberry32=20260420)\n`;
review += `- Verdict: **27/30 = 90.0%** — meets the ≥90% gate\n`;
review += `- 3 remaining failures are structural catalog gaps (value collides with a\n`;
review += `  semantically-unrelated token). Details under "Known residual catalog gaps".\n\n`;

review += `## LOW entries (${lows.length})\n\n`;
review += `LOW entries failed the priority tie-break at the alphabetical fallback (Rule 4)\n`;
review += `or were demoted by the subsystem-unanchored guard. Each needs human review to\n`;
review += `choose the right token or propose a new one.\n\n`;

const lowsBySub = new Map();
for (const e of lows) {
  if (!lowsBySub.has(e.subsystem)) lowsBySub.set(e.subsystem, []);
  lowsBySub.get(e.subsystem).push(e);
}
const lowSubs = [...lowsBySub.keys()].sort();
for (const sub of lowSubs) {
  const list = lowsBySub.get(sub).sort((a, b) =>
    (a.path + a.line).localeCompare(b.path + b.line)
  );
  review += `### ${sub} (${list.length})\n\n`;
  for (const e of list) {
    review += `- **${e.path}:${e.line}:${e.column}** — \`${e.matchedText}\` (${e.kind}, hint=${e.elementHint})\n`;
    review += `  - proposed: \`${e.proposedTokenName}\`  — rule: \`${e.assignmentRule}\`\n`;
    review += `  - gates: ${e.gatesPassed.join(' → ')}\n`;
    if (e.rationale) review += `  - rationale: ${e.rationale}\n`;
    review += `  - context: \`${compactCtx(e.surroundingContext)}\`\n`;
  }
  review += `\n`;
}

review += `## FALSE-POSITIVE table (${fps.length})\n\n`;
review += `Preserved byte-identical from v1 per integrity assertion 6.\n\n`;
review += `| path:line:col | matchedText | rule |\n|---|---|---|\n`;
for (const e of fps.sort((a, b) => (a.path + a.line).localeCompare(b.path + b.line))) {
  review += `| ${e.path}:${e.line}:${e.column} | \`${e.matchedText}\` | \`${e.assignmentRule}\` |\n`;
}
review += `\n`;

review += `## Known residual catalog gaps (from Step 5 audit)\n\n`;
review += `These are MEDIUM assignments whose *value* matches a catalog token but whose *role*\n`;
review += `does not — the catalog has no semantically-correct token. Flagged for catalog work,\n`;
review += `not for classifier retuning.\n\n`;
review += `1. **SmartBalancePanel band \`#FFD93D\`** — classifier picks \`--theme-label-hihat\`\n`;
review += `   because it is the only catalog token holding that value. The hihat label is\n`;
review += `   semantically unrelated; SmartBalancePanel needs a product-domain token for its\n`;
review += `   frequency-band data color. (Tracked under "G2" in gaps report.)\n`;
review += `2. **LipSyncView selection edge \`#33CED6\`** — classifier picks\n`;
review += `   \`--theme-lipsync-waveform-playhead\` because it shares the accent value.\n`;
review += `   Selection-edge is a different role; add \`--theme-lipsync-selection-edge\`\n`;
review += `   or repoint to \`--theme-accent\`.\n`;
review += `3. **LFO_COLORS.vol \`#33CED6\`** — classifier picks\n`;
review += `   \`--theme-sampler-pitch-envelope-curve\` by tie-break; the LFO_COLORS object\n`;
review += `   line assigns all three LFO tab colors on one multi-color source line, which\n`;
review += `   denies any hint disambiguation. Prefer \`--theme-sampler-lfo-color-volume\`\n`;
review += `   — requires per-match context refinement in the upstream audit, not here.\n\n`;

fs.writeFileSync(path.resolve(__dirname, 'theming-enrichment-review.md'), review);
console.log('Wrote scripts/theming-enrichment-review.md');

// ---------- gaps.md ----------
// Group NO-FIT by (subsystem, role, matchedText)
const noFits = entries.filter(e => e.confidence === 'no-fit');
const grouped = new Map();
for (const e of noFits) {
  const role = e.elementHint || 'unknown';
  const key = `${e.subsystem}||${role}||${e.matchedText}`;
  if (!grouped.has(key)) grouped.set(key, []);
  grouped.get(key).push(e);
}
const gArr = [...grouped.entries()].sort((a, b) => {
  if (b[1].length !== a[1].length) return b[1].length - a[1].length;
  return a[0].localeCompare(b[0]);
});

// Also build subsystem-level counts
const subCounts = new Map();
for (const [k, v] of gArr) {
  const sub = k.split('||')[0];
  subCounts.set(sub, (subCounts.get(sub) || 0) + v.length);
}

// Classification helper — heuristic (a)/(b)/(c)
function classifyGroup(mt, role, groupSize) {
  // Known shared near-black values handled in G1/G5
  if (mt === '#0a0a10' || mt === '#000000' || mt === '#000') return '(c) truly unreachable — near-black decorative; see G5';
  // Generic grays in app.css textual contexts
  if (/^#(?:[0-9a-f])\1\1$/i.test(mt) || /^#(?:[0-9a-f]{2})\1\1$/i.test(mt)) return '(a) new token — generic gray, needs semantic name';
  // rgba with black (translucent shadows/overlays)
  if (/^rgba\(0,\s*0,\s*0,/.test(mt)) return '(a) new token — black overlay/shadow; candidate for shared surface tint';
  // rgba with white (translucent surface tints)
  if (/^rgba\(255,\s*255,\s*255,/.test(mt)) return '(a) new token — white surface tint; consider adding to fx-surface-tint family';
  // rgba accent (51,206,214) — crossSubsystem candidate
  if (/^rgba\(51,\s*206,\s*214,/.test(mt)) return '(a) new token — accent alpha; crossSubsystem candidate (waveform-shared / fx-shared family)';
  // rgba danger (255,71,87)
  if (/^rgba\(255,\s*71,\s*87,/.test(mt)) return '(a) new token — danger alpha; propose --theme-semantic-danger-bg variant';
  // gradient
  if (/gradient\(/i.test(mt)) return '(a) new token — gradient; product-domain name needed';
  // singletons in decorative/marketing roles
  if (groupSize === 1) return '(c) truly unreachable — one-off decorative; accept as NO-FIT';
  return '(a) new token — review value + role and propose a name';
}

let gaps = '';
gaps += `# Catalog Gap Report (v2)\n\n`;
gaps += `Generated: ${today} (Step 6 — regenerated from v2 classifier)\n`;
gaps += `Source: \`scripts/theming-audit-enriched-v2.json\` (${entries.length} match entries)\n\n`;

gaps += `## Summary\n\n`;
gaps += `- NO-FIT matches: **${noFits.length}** across **${gArr.length}** distinct\n`;
gaps += `  (subsystem, role, value) groups.\n`;
gaps += `- Singleton groups: **${gArr.filter(([, v]) => v.length === 1).length}** (one match site each)\n`;
gaps += `- Catalog deltas from Step 2 (drift fixes, renames, new tokens, retirements)\n`;
gaps += `  are preserved from the prior revision of this file — see "Catalog deltas\n`;
gaps += `  (Step 2)" section below.\n\n`;
gaps += `Per rule: false-positive matches are NOT listed here — they are audit errors,\n`;
gaps += `not catalog gaps. Their preservation is asserted by integrity check 6.\n\n`;

gaps += `---\n\n`;
gaps += `## NO-FIT distribution by subsystem\n\n`;
gaps += `| Subsystem | NO-FIT count |\n|---|---:|\n`;
for (const [sub, n] of [...subCounts.entries()].sort((a, b) => b[1] - a[1])) {
  gaps += `| ${sub} | ${n} |\n`;
}
gaps += `\n---\n\n`;

gaps += `## Gaps by (subsystem, role, value)\n\n`;
gaps += `Each row below is a unique (subsystem, inferredRole, matchedText) group.\n`;
gaps += `**Classification**: (a) new token, (b) drift I missed, (c) truly unreachable.\n\n`;

// Print by subsystem, sorted by total NO-FIT count desc
const subsAll = [...new Set(gArr.map(([k]) => k.split('||')[0]))]
  .sort((a, b) => (subCounts.get(b) || 0) - (subCounts.get(a) || 0));

for (const sub of subsAll) {
  const subGroups = gArr.filter(([k]) => k.split('||')[0] === sub);
  gaps += `### ${sub} (${subCounts.get(sub)} NO-FIT across ${subGroups.length} groups)\n\n`;
  gaps += `| × | role | matchedText | classification | example |\n`;
  gaps += `|---:|---|---|---|---|\n`;
  for (const [key, list] of subGroups) {
    const [, role, mt] = key.split('||');
    const ex = `${list[0].path}:${list[0].line}`;
    const cls = classifyGroup(mt, role, list.length);
    const mtEsc = mt.replace(/\|/g, '\\|');
    gaps += `| ${list.length} | ${role} | \`${mtEsc}\` | ${cls} | ${ex} |\n`;
  }
  gaps += `\n`;
}

gaps += `---\n\n`;
gaps += `## Catalog deltas (Step 2) — preserved\n\n`;
gaps += `### Drift fixes (in-place value changes)\n\n`;
gaps += `- \`--theme-sampler-lfo-color-pitch\`  \`#33CED6\` → \`#E8A020\` (swapped with volume — LfoSection.jsx:5 ground truth)\n`;
gaps += `- \`--theme-sampler-lfo-color-volume\` \`#E8A020\` → \`#33CED6\` (swap pair)\n`;
gaps += `- \`--theme-sampler-lfo-bg-pitch\`     \`#1E3A3C\` → \`#3C2E1A\` (swap pair)\n`;
gaps += `- \`--theme-sampler-lfo-bg-volume\`    \`#3C2E1A\` → \`#1E3A3C\` (swap pair)\n`;
gaps += `- \`--theme-sampler-envelope-fill\`    \`rgba(51,206,214,0.08)\` → \`var(--theme-waveform-envelope-fill)\` (0.35 per SamplerWaveform.jsx:110)\n\n`;
gaps += `### Renames\n\n`;
gaps += `- \`--theme-sampler-lfo-color-filter\` → \`--theme-sampler-lfo-color-pan\` (value unchanged \`#9B59B6\`)\n`;
gaps += `- \`--theme-sampler-lfo-bg-filter\`    → \`--theme-sampler-lfo-bg-pan\`    (value unchanged \`#2A1E3A\`)\n`;
gaps += `- \`--theme-lipsync-playback-indicator\` → \`--theme-waveform-envelope-fill\` (moved to \`waveform-shared\` with \`crossSubsystem:true\`)\n`;
gaps += `- \`--theme-lipsync-scroll-thumb\`       → \`--theme-waveform-rms-body\`       (moved to \`waveform-shared\` with \`crossSubsystem:true\`)\n\n`;
gaps += `### New tokens\n\n`;
gaps += `- Base: \`--theme-fg-inverse\` = \`#ffffff\`\n`;
gaps += `- Base: \`--theme-bg-inset\` = \`#0d0d14\`\n`;
gaps += `- Text: \`--theme-text-on-accent\` = \`#0d0d14\`\n`;
gaps += `- Semantic: \`--theme-drag-preview-default\` = \`#6aa9ff\`\n`;
gaps += `- Syllable splitter: \`--theme-syllable-splitter-bg\` = \`#1b1b24\`\n`;
gaps += `- Syllable splitter: \`--theme-syllable-section-alt\` = \`rgba(51,206,214,0.06)\`\n`;
gaps += `- Stock-effects shared (crossSubsystem): \`--theme-fx-surface-tint-subtle\` = \`rgba(255,255,255,0.05)\`\n`;
gaps += `- Waveform-shared (crossSubsystem): \`--theme-waveform-envelope-fill\` = \`rgba(51,206,214,0.35)\` (via rename)\n`;
gaps += `- Waveform-shared (crossSubsystem): \`--theme-waveform-rms-body\` = \`rgba(51,206,214,0.55)\` (via rename)\n\n`;
gaps += `### Retirements\n\n`;
gaps += `- \`--theme-sampler-lfo-fill\` — ghost token; LfoWaveformCanvas.jsx:65 dynamically computes fill as \`color + '18'\`.\n\n`;
gaps += `### Subsystem additions\n\n`;
gaps += `- \`waveform-shared\` (§3.4.26) — cross-subsystem waveform primitives.\n\n`;
gaps += `### Schema additions\n\n`;
gaps += `- \`TokenDef.crossSubsystem?: true\` — bypasses Gate 3 subsystem-equality check.\n\n`;

gaps += `---\n\n`;
gaps += `## Future cleanup (not beta-blocking)\n\n`;
gaps += `These are observations surfaced during Step 1/2/5/6 that would tighten the catalog\n`;
gaps += `but do not block the beta. File for a later wave.\n\n`;
gaps += `### G1 — FX-shared cross-subsystem rgba family\n\n`;
gaps += `Stock-effects subsystems share \`rgba(51,206,214,{0.08,0.12,0.18,0.30})\` and\n`;
gaps += `\`rgba(255,255,255,{0.03,0.05,0.06,0.10,0.25})\` across ~20 tokens. Consolidate\n`;
gaps += `into a richer \`stock-effects.shared\` subsystem with \`crossSubsystem:true\` flags.\n\n`;
gaps += `### G2 — SmartBalancePanel per-data-color tokens\n\n`;
gaps += `\`stock-effects.dynamics.SmartBalancePanel\` uses \`#6bcb77\`, \`#2ea8a0\`, \`#ff8c00\`,\n`;
gaps += `\`#4ecdc4\`, \`#4d96ff\`, \`#FFD93D\` as channel / stereo-field data-encoding colors.\n`;
gaps += `Needs product-domain names (which channel? which stereo lobe?) before tokenization.\n`;
gaps += `**Also covers the residual Step 5 failure #04** (\`#FFD93D\` mapping to label-hihat).\n\n`;
gaps += `### G3 — One-off low-frequency gaps\n\n`;
gaps += `${gArr.filter(([, v]) => v.length === 1).length} match groups with x1 occurrence each — mostly local\n`;
gaps += `decorative values. Accept as NO-FIT in v2; revisit per-component during migration cleanup.\n\n`;
gaps += `### G4 — LFO canvas dynamic-alpha helper\n\n`;
gaps += `\`LfoWaveformCanvas.jsx:65\` applies opacity via hex-alpha suffix: \`ctx.fillStyle = color + '18'\`.\n`;
gaps += `A future \`withAlpha(tokenName, alpha)\` helper would let the LFO canvas consume\n`;
gaps += `\`--theme-sampler-lfo-color-<tab>\` + 0.094 opacity through a theme-aware API.\n\n`;
gaps += `### G5 — LFO canvas \`#0a0a10\` background\n\n`;
gaps += `\`LfoWaveformCanvas.jsx:27,85\` and \`EnvelopeEditor.jsx:79,144\` hardcode \`#0a0a10\`\n`;
gaps += `(canvas background + handle stroke). Distinct from \`#0d0d14\` (\`--theme-bg-inset\`) and\n`;
gaps += `\`#0A0A0F\` (\`--theme-bg-primary\`). A future \`--theme-sampler-canvas-bg\` would cover it.\n\n`;
gaps += `### G6 — \`--theme-text-on-accent\` vs \`--theme-text-inverse\` convergence candidate\n\n`;
gaps += `\`--theme-text-on-accent\` (\`#0d0d14\`) and \`--theme-text-inverse\` (resolves to\n`;
gaps += `\`#0A0A0F\`) serve the same role with near-identical values. A future pass could\n`;
gaps += `repoint the 10 app.css callsites and retire \`--theme-text-on-accent\`.\n\n`;
gaps += `### G7 — LFO \`-color-filter\` / \`-bg-filter\` orphan history\n\n`;
gaps += `The renamed tokens (\`-filter\` → \`-pan\`) had zero component callsites — they were\n`;
gaps += `defined in \`catalog.ts\` and appeared only in generated resolve-dumps. Evidence of\n`;
gaps += `catalog-to-component drift; similar audits of orphan tokens in other subsystems\n`;
gaps += `could surface more such drift.\n\n`;
gaps += `### G8 — Lipsync selection-edge and LFO_COLORS multi-line assignment\n\n`;
gaps += `Two residual Step 5 failures (#10 lipsync selEdge, #15 LFO_COLORS.vol) share the\n`;
gaps += `same root cause: the value \`#33CED6\` (the accent) is re-used across multiple\n`;
gaps += `semantically-distinct roles, so the v2 classifier cannot disambiguate without\n`;
gaps += `hint context that the upstream audit doesn't provide. Options:\n`;
gaps += `  - Add \`--theme-lipsync-selection-edge\` (pure new token).\n`;
gaps += `  - Improve the upstream audit to emit per-line context that includes the\n`;
gaps += `    active property name on multi-color assignment lines (e.g. LFO_COLORS).\n`;
gaps += `  - Or accept these three as known catalog gaps and let manual migration\n`;
gaps += `    decide — they are LOW-frequency, not beta-blocking.\n\n`;

fs.writeFileSync(path.resolve(__dirname, 'theming-catalog-gaps.md'), gaps);
console.log('Wrote scripts/theming-catalog-gaps.md');
