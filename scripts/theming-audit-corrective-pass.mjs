// Targeted corrective pass for v2 enrichment — addresses Rule 3 (derivation
// priority) systematic demotion of universal base tokens (e.g. --theme-accent)
// in favor of derived-var aliases or derived-formula pass-throughs that
// resolve to the same value.
//
// Spec: see Krasen's directive in chat (paraphrased here):
//   - For each match across HIGH/MEDIUM/LOW with non-null proposedTokenName:
//     1. If the assigned token is value-equivalent to a UNIVERSAL base token
//        AND the assigned token is not itself that base → POTENTIAL_OVERRIDE.
//     2. Apply heuristic to KEEP / OVERRIDE / DEMOTE.
//
// EXTENSION beyond the literal spec: the strict directive only handles
// `derivation: derived-var` chains. We extend to ALSO catch derived-formula
// pass-through aliases (e.g. derivation.ts:183 `put('--theme-border-focus',
// accent)` which produces a derived-formula token but is functionally identical
// to a derived-var alias). Detection is value-based: any non-base assignment
// whose resolved value equals a UNIVERSAL base's resolved value qualifies.
// Reason: at runtime + at Phase-1 detachment, `--theme-border-focus` and
// `derived-var ref=accent` behave identically — the semantic-drift risk is
// the same. Excluding derived-formula would let dozens of HIGH cases ship
// with the same latent issue. Flagged for Krasen's sign-off in the report
// header before any mutation is committed.
//
// Hardcoded overrides applied AFTER the heuristic pass:
//   - LOW #14 (TrackHeader.jsx:9 LABEL_COLORS 8th slot, #33CED6) →
//     --theme-label-perc. NOT a corrective-pass match (different value than
//     terminal base); applied as a separate pre-decided override (perc-label
//     Option A from earlier discussion).
//
// Verification harness: 12 LOW #33CED6 cases pre-approved by Krasen as
// --theme-accent overrides. Pass should independently OVERRIDE them. Any
// divergence (KEEP or DEMOTE) is reported per-case before mutation commits.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ROOT = path.resolve(import.meta.dirname, '..');
const ENRICHED_IN  = path.resolve(ROOT, 'scripts/theming-audit-enriched-v2.json');
const ENRICHED_OUT = path.resolve(ROOT, 'scripts/theming-audit-enriched-v2-corrected.json');
const REPORT_OUT   = path.resolve(ROOT, 'scripts/theming-corrective-pass-report.md');
const BUNDLE       = path.resolve(ROOT, 'ui/node_modules/.theming-v2-cache/bundle.cjs');

const { TOKENS, TOKENS_BY_NAME, BASE_DEFAULTS, deriveTheme } = require(BUNDLE);
const data = JSON.parse(fs.readFileSync(ENRICHED_IN, 'utf8'));

// ── Constants from classifier ──────────────────────────────────────────────
const UNIVERSAL_SUBSYSTEMS = new Set([
  'base', 'derived', 'borders', 'text', 'semantic', 'labels',
]);
const GENERIC_ROLE_WORDS = new Set([
  'fg', 'bg', 'color', 'fill', 'stroke', 'border', 'default', 'subtle',
]);

// ── Resolve every token to leaf value ──────────────────────────────────────
const derived = deriveTheme(BASE_DEFAULTS, []);
function leaf(name, seen = new Set()) {
  if (seen.has(name)) return null;
  seen.add(name);
  const t = TOKENS_BY_NAME[name];
  if (!t) return null;
  switch (t.derivation.type) {
    case 'base':            return BASE_DEFAULTS[name] || null;
    case 'explicit':        return t.derivation.value;
    case 'derived-formula': return derived[name] || null;
    case 'derived-var':     return leaf(t.derivation.ref, seen);
  }
  return null;
}

function normalizeHex(s) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (!m) return s.toLowerCase();
  let h = m[1].toLowerCase();
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (h.length === 4) h = h.split('').map(c => c + c).join('');
  return '#' + h;
}
function normalizeRgba(inner) {
  return inner.split(',').map(p => p.trim()).join(', ');
}
function normalize(raw) {
  if (raw == null) return '';
  let s = String(raw).trim();
  if (/^#[0-9a-f]+$/i.test(s)) return normalizeHex(s);
  const fn = /^(rgba?|hsla?)\s*\(\s*(.*?)\s*\)$/i.exec(s);
  if (fn) return `${fn[1].toLowerCase()}(${normalizeRgba(fn[2])})`;
  return s.toLowerCase();
}

// ── Build value-index of universal base tokens ─────────────────────────────
// Key: normalized resolved value → list of UNIVERSAL base candidates.
// Anchor priority: base > borders/text/semantic/labels/derived (so base wins
// when both --theme-accent and --theme-border-focus are present at value X).
const BASE_PRIORITY = { base: 5, semantic: 4, text: 3, borders: 2, labels: 1, derived: 0 };
const universalIndex = new Map();
for (const t of TOKENS) {
  if (!UNIVERSAL_SUBSYSTEMS.has(t.subsystem)) continue;
  if (t.derivation.type !== 'base') continue; // strict spec: only true base tokens are valid override targets
  const v = leaf(t.name);
  if (!v) continue;
  const k = normalize(v);
  if (!universalIndex.has(k)) universalIndex.set(k, []);
  universalIndex.get(k).push(t);
}
for (const arr of universalIndex.values()) {
  arr.sort((a, b) => (BASE_PRIORITY[b.subsystem] ?? 0) - (BASE_PRIORITY[a.subsystem] ?? 0));
}

// ── Heuristic helpers ──────────────────────────────────────────────────────
function tailWords(tokenName, matchSubsystem) {
  // Strip --theme-, strip subsystem-name words, strip GENERIC role words.
  const subsystemWords = new Set((matchSubsystem || '').split(/[.\-]/).filter(Boolean));
  return tokenName
    .replace(/^--theme-/, '')
    .toLowerCase()
    .split('-')
    .filter(p => !subsystemWords.has(p) && !GENERIC_ROLE_WORDS.has(p));
}

function contextWords(entry) {
  const phrase = [
    entry.elementHint || '',
    entry.dispatchSelector || '',
    entry.surroundingContext || '',
  ].join(' ').toLowerCase();
  const words = phrase
    .split(/[^a-z0-9]+/)
    .flatMap(w => w.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/\s+/))
    .filter(Boolean);
  return new Set(words);
}

// Generic-element-hint set: when elementHint is one of these and tail words
// are absent from context, OVERRIDE wins. These are the hints the classifier
// uses for "generic chrome role with no subsystem-specific anchor".
const GENERIC_HINTS = new Set([
  'fg', 'bg', 'color', 'fill', 'stroke', 'border', 'outline',
  'canvas-fill', 'canvas-stroke',
  'accentcolor', 'gradient-stop',
  'n/a', '', null, undefined,
]);
function isGenericHint(h) {
  if (h == null) return true;
  return GENERIC_HINTS.has(String(h).toLowerCase());
}

// ── Heuristic decision ─────────────────────────────────────────────────────
function decide(entry, assignedToken, baseToken) {
  const tail = tailWords(assignedToken.name, entry.subsystem);
  const ctx  = contextWords(entry);
  const grounded = tail.some(w => ctx.has(w));

  // Detect subsystem-specific semantic words by checking the assigned token's
  // tail vs context. If ANY tail word appears in context → KEEP (the assigned
  // token's semantic anchor is grounded by the callsite).
  if (grounded) {
    return { decision: 'KEEP', reason: `Assigned token tail [${tail.join(', ')}] grounded in context (callsite is subsystem-specific).` };
  }

  // Tail not grounded. If element hint is generic → OVERRIDE.
  if (isGenericHint(entry.elementHint)) {
    return { decision: 'OVERRIDE', reason: `Tail [${tail.join(', ')}] absent from context and elementHint='${entry.elementHint}' is generic — semantic intent is the universal base.` };
  }

  // Tail absent, hint subsystem-coupled but tail words don't appear → DEMOTE.
  return { decision: 'DEMOTE', reason: `Tail [${tail.join(', ')}] absent from context but elementHint='${entry.elementHint}' is subsystem-coupled — ambiguous, needs human review.` };
}

// ── Run the pass ───────────────────────────────────────────────────────────
const stats = {
  scanned: 0,
  potentialOverride: 0,
  overridden: 0,
  kept: 0,
  demoted: 0,
  byTier: { high: 0, medium: 0, low: 0 },
  byOverrideTarget: {},
};

const report = []; // per-entry corrective-pass actions for the markdown report
const updatedEntries = data.entries.map((e, idx) => {
  if (!['high', 'medium', 'low'].includes(e.confidence)) return e;
  if (!e.proposedTokenName) return e;
  stats.scanned++;

  const assigned = TOKENS_BY_NAME[e.proposedTokenName];
  if (!assigned) return e;

  // Skip if assigned is itself a universal base.
  if (UNIVERSAL_SUBSYSTEMS.has(assigned.subsystem) && assigned.derivation.type === 'base') return e;

  // Find matching universal base by value.
  const matchNorm = normalize(e.matchedText);
  const candidates = universalIndex.get(matchNorm);
  if (!candidates || candidates.length === 0) return e;

  // Pick highest-priority base.
  const baseTok = candidates[0];
  if (baseTok.name === assigned.name) return e;

  // Sanity: assigned token must resolve to the same value (otherwise this is
  // an actual visual-changing override, not a semantic equivalence — skip).
  const assignedLeaf = normalize(leaf(assigned.name));
  if (assignedLeaf !== matchNorm) return e;

  stats.potentialOverride++;
  stats.byTier[e.confidence]++;

  const { decision, reason } = decide(e, assigned, baseTok);

  if (decision === 'KEEP') {
    stats.kept++;
    report.push({ idx, entry: e, assigned, baseTok, decision, reason });
    return e;
  }

  if (decision === 'OVERRIDE') {
    stats.overridden++;
    stats.byOverrideTarget[baseTok.name] = (stats.byOverrideTarget[baseTok.name] || 0) + 1;
    report.push({ idx, entry: e, assigned, baseTok, decision, reason });
    return {
      ...e,
      proposedTokenName: baseTok.name,
      assignmentRule: 'corrective-pass-override-base',
      rationale: `Corrective pass: assigned ${assigned.name} (resolves to ${matchNorm}) overridden to ${baseTok.name} (universal base, same value). ${reason}`,
      correctivePassPriorAssignment: assigned.name,
    };
  }

  // DEMOTE
  stats.demoted++;
  report.push({ idx, entry: e, assigned, baseTok, decision, reason });
  return {
    ...e,
    confidence: 'low',
    assignmentRule: 'corrective-pass-demote-base-vs-subsystem',
    rationale: `Corrective pass: assigned ${assigned.name} resolves to a universal base (${baseTok.name}). ${reason}`,
    correctivePassPriorConfidence: e.confidence,
  };
});

// ── Hardcoded override #14 — TrackHeader.jsx:9 LABEL_COLORS 8th slot ───────
// Per Krasen's pre-decision (perc label Option A): override #33CED6 in
// LABEL_COLORS array to --theme-label-perc (#E67E51). NOTE: this is a
// VISUAL-CHANGING override (#33CED6 → #E67E51), intentional bug fix.
let hardcodeApplied = false;
const fixedEntries = updatedEntries.map(e => {
  if (e.path === 'ui/src/components/timeline/TrackHeader.jsx' && e.line === 9 && String(e.matchedText || '').toLowerCase() === '#33ced6') {
    hardcodeApplied = true;
    return {
      ...e,
      proposedTokenName: '--theme-label-perc',
      assignmentRule: 'hardcoded-override-perc-label',
      rationale: 'Hardcoded override (perc label Option A pre-decision): 8th LABEL_COLORS slot changed from #33CED6 to --theme-label-perc (#E67E51). Visual change is intentional bug fix; was stale accent leftover.',
      correctivePassPriorAssignment: e.proposedTokenName,
      visualChangingOverride: true,
    };
  }
  return e;
});

// ── Verification: 12 LOW #33CED6 cases (Krasen pre-approved as --theme-accent)
const HARDCODED_LOW_ACCENT = new Set([
  'ui/src/components/pianoRoll/PianoRollCanvas.jsx:108',
  'ui/src/components/pianoRoll/PianoRollCanvas.jsx:579',
  'ui/src/components/TimelineView.jsx:49',
  'ui/src/components/timeline/FadeBezierEditor.jsx:85',
  'ui/src/components/timeline/TimelineCanvas.jsx:467',
  'ui/src/components/timeline/TimelineRuler.jsx:132',
]);
const verification = [];
for (const e of fixedEntries) {
  const key = `${e.path}:${e.line}`;
  if (!HARDCODED_LOW_ACCENT.has(key)) continue;
  if (e.matchedText !== '#33CED6') continue;
  verification.push({
    file: key,
    matchedText: e.matchedText,
    finalProposed: e.proposedTokenName,
    finalConfidence: e.confidence,
    expected: '--theme-accent (via OVERRIDE)',
    agree: e.proposedTokenName === '--theme-accent' && e.assignmentRule === 'corrective-pass-override-base',
  });
}

// ── Tier counts after pass ─────────────────────────────────────────────────
const newTierCounts = { high: 0, medium: 0, low: 0, 'no-fit': 0, 'false-positive': 0 };
for (const e of fixedEntries) newTierCounts[e.confidence] = (newTierCounts[e.confidence] || 0) + 1;

// ── Write outputs ──────────────────────────────────────────────────────────
const outJson = {
  ...data,
  generatedAt: new Date().toISOString(),
  classifierVersion: 'v2-corrective',
  correctivePass: {
    appliedAt: new Date().toISOString(),
    extensionFromSpec: 'Detection extended from strict derived-var chains to ALSO catch derived-formula transparent aliases (value equivalence). Documented in script header.',
    stats,
    verification,
    hardcodedOverrideApplied: hardcodeApplied,
    newTierCounts,
  },
  tierCounts: newTierCounts,
  entries: fixedEntries,
};
fs.writeFileSync(ENRICHED_OUT, JSON.stringify(outJson, null, 2));

// ── Markdown report ────────────────────────────────────────────────────────
const md = [];
md.push('# Theming corrective pass — report');
md.push('');
md.push(`Generated: ${new Date().toISOString()}`);
md.push('');
md.push('## Spec extension (requires sign-off)');
md.push('');
md.push('Strict directive: detect derived-var → universal base aliases only.');
md.push('Extended: detect ANY non-base assignment whose resolved value equals a');
md.push('universal base value (catches derived-formula transparent aliases like');
md.push('--theme-border-focus and --theme-info, which are functionally identical');
md.push('at runtime + Phase-1 detachment).');
md.push('');
md.push('## Statistics');
md.push('');
md.push(`- Entries scanned (HIGH/MEDIUM/LOW with non-null proposed): ${stats.scanned}`);
md.push(`- POTENTIAL_OVERRIDE candidates found: ${stats.potentialOverride}`);
md.push(`  - Overridden (heuristic decisive — generic role): ${stats.overridden}`);
md.push(`  - Kept as derived alias (subsystem-specific tail grounded in context): ${stats.kept}`);
md.push(`  - Demoted to LOW (ambiguous): ${stats.demoted}`);
md.push('');
md.push(`- By tier (POTENTIAL_OVERRIDE distribution):`);
md.push(`  - HIGH: ${stats.byTier.high}`);
md.push(`  - MEDIUM: ${stats.byTier.medium}`);
md.push(`  - LOW: ${stats.byTier.low}`);
md.push('');
md.push(`- By override target:`);
for (const [name, c] of Object.entries(stats.byOverrideTarget).sort((a,b)=>b[1]-a[1])) {
  md.push(`  - ${name}: ${c}`);
}
md.push('');
md.push(`- Tier counts (before → after):`);
md.push(`  - HIGH:    ${data.tierCounts.high} → ${newTierCounts.high}`);
md.push(`  - MEDIUM:  ${data.tierCounts.medium} → ${newTierCounts.medium}`);
md.push(`  - LOW:     ${data.tierCounts.low} → ${newTierCounts.low}`);
md.push(`  - NO-FIT:  ${data.tierCounts['no-fit']} → ${newTierCounts['no-fit']}`);
md.push(`  - FP:      ${data.tierCounts['false-positive']} → ${newTierCounts['false-positive']}`);
md.push('');
md.push(`- Hardcoded TrackHeader.jsx:9 perc-label override applied: ${hardcodeApplied}`);
md.push('');
md.push('## Verification — 6 LOW #33CED6 cases pre-approved as --theme-accent');
md.push('');
md.push('| File:line | Final proposed | Final confidence | Agrees with pre-approval? |');
md.push('|---|---|---|---|');
for (const v of verification) {
  md.push(`| ${v.file} | ${v.finalProposed} | ${v.finalConfidence} | ${v.agree ? '✓' : '✗ DIVERGENCE'} |`);
}
const allAgree = verification.every(v => v.agree);
md.push('');
md.push(allAgree ? '**All 6 hardcoded cases agree with pass decision.**' : '**DIVERGENCE — review before mutation commits.**');
md.push('');
md.push('## Per-entry actions');
md.push('');
md.push('### OVERRIDDEN (assigned → universal base)');
md.push('');
md.push('| File:line | Tier | Was → Is | Reason |');
md.push('|---|---|---|---|');
for (const r of report.filter(r => r.decision === 'OVERRIDE')) {
  md.push(`| ${r.entry.path}:${r.entry.line} | ${r.entry.confidence} | ${r.assigned.name} → **${r.baseTok.name}** | ${r.reason} |`);
}
md.push('');
md.push('### KEPT as derived alias (semantic anchor grounded)');
md.push('');
md.push('| File:line | Tier | Assigned | Reason |');
md.push('|---|---|---|---|');
for (const r of report.filter(r => r.decision === 'KEEP')) {
  md.push(`| ${r.entry.path}:${r.entry.line} | ${r.entry.confidence} | ${r.assigned.name} | ${r.reason} |`);
}
md.push('');
md.push('### DEMOTED to LOW (ambiguous — needs human review)');
md.push('');
md.push('| File:line | Was tier | Assigned (kept) | Universal base candidate | Reason |');
md.push('|---|---|---|---|---|');
for (const r of report.filter(r => r.decision === 'DEMOTE')) {
  md.push(`| ${r.entry.path}:${r.entry.line} | ${r.entry.confidence} | ${r.assigned.name} | ${r.baseTok.name} | ${r.reason} |`);
}
md.push('');
md.push('---');
md.push('');
md.push(`Output JSON: ${path.basename(ENRICHED_OUT)}`);
md.push(`Original JSON preserved: ${path.basename(ENRICHED_IN)} (untouched)`);

fs.writeFileSync(REPORT_OUT, md.join('\n'));

// ── Console summary ────────────────────────────────────────────────────────
console.log('═'.repeat(72));
console.log('  CORRECTIVE PASS — SUMMARY');
console.log('═'.repeat(72));
console.log();
console.log(`Scanned:            ${stats.scanned}`);
console.log(`POTENTIAL_OVERRIDE: ${stats.potentialOverride}  (HIGH ${stats.byTier.high}, MEDIUM ${stats.byTier.medium}, LOW ${stats.byTier.low})`);
console.log(`  → Overridden:     ${stats.overridden}`);
console.log(`  → Kept:           ${stats.kept}`);
console.log(`  → Demoted to LOW: ${stats.demoted}`);
console.log();
console.log(`Override targets:`);
for (const [n, c] of Object.entries(stats.byOverrideTarget).sort((a,b)=>b[1]-a[1])) {
  console.log(`  ${n.padEnd(40)} ${c}`);
}
console.log();
console.log(`Tier counts (before → after):`);
console.log(`  HIGH    ${data.tierCounts.high} → ${newTierCounts.high}`);
console.log(`  MEDIUM  ${data.tierCounts.medium} → ${newTierCounts.medium}`);
console.log(`  LOW     ${data.tierCounts.low} → ${newTierCounts.low}`);
console.log(`  NO-FIT  ${data.tierCounts['no-fit']} → ${newTierCounts['no-fit']}`);
console.log(`  FP      ${data.tierCounts['false-positive']} → ${newTierCounts['false-positive']}`);
console.log();
console.log(`Hardcoded perc-label override applied: ${hardcodeApplied}`);
console.log();
console.log(`Verification of 6 pre-approved LOW #33CED6 cases:`);
for (const v of verification) {
  console.log(`  ${v.agree ? '✓' : '✗'} ${v.file.padEnd(60)} → ${v.finalProposed} [${v.finalConfidence}]`);
}
console.log();
console.log(`Output:  ${ENRICHED_OUT}`);
console.log(`Report:  ${REPORT_OUT}`);
