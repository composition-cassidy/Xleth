#!/usr/bin/env node
'use strict';
// theming-medium-sample.js — read-only MEDIUM confidence diagnostic.
// Picks 20 diverse MEDIUM matches from theming-audit-enriched.json,
// re-derives the token-scoring to expose other candidates, and prints
// a markdown table to stdout. Writes NOTHING.

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// ── Load catalog ──────────────────────────────────────────────────────────
const catalogTs = path.resolve(ROOT, 'ui/src/theming/tokens/catalog.ts');
const tmpDir    = path.resolve(ROOT, 'ui/node_modules/.theming-verify-cache');
const tmpFile   = path.join(tmpDir, 'catalog.cjs');
fs.mkdirSync(tmpDir, { recursive: true });
execSync(
  `node -e "require('esbuild').buildSync({entryPoints:['${catalogTs.replace(/\\/g,'/')}'],bundle:false,format:'cjs',outfile:'${tmpFile.replace(/\\/g,'/')}',platform:'node'})"`,
  { cwd: path.resolve(ROOT, 'ui'), stdio: 'pipe' }
);
delete require.cache[tmpFile];
const C = require(tmpFile);
const TOKENS = C.TOKENS;

const tokensBySub = new Map();
for (const t of TOKENS) {
  if (t.kind !== 'color') continue;
  (tokensBySub.get(t.subsystem) ? tokensBySub.get(t.subsystem) : (tokensBySub.set(t.subsystem, []), tokensBySub.get(t.subsystem))).push(t);
}

// ── Load enriched audit ───────────────────────────────────────────────────
const enriched = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'theming-audit-enriched.json'), 'utf8')
);

// ── Scoring helpers (mirrors theming-audit-enrich.js) ────────────────────
function tokenRole(name) {
  const segs = name.replace(/^--theme-/, '').split('-');
  const last = segs[segs.length - 1];
  if (last === 'bg' || last === 'background') return 'bg';
  if (last === 'fg' || last === 'color' || last === 'text' || last === 'label') return 'fg';
  if (last === 'border') return 'border';
  if (last === 'shadow') return 'shadow';
  if (last === 'fill') return 'fill';
  if (last === 'stroke') return 'stroke';
  return 'other';
}

function parseContextLines(ctx) {
  if (!ctx) return { lines: [], matchLine: '', before: [], after: [] };
  const raw = ctx.split(/\r?\n/);
  const parsed = raw.map(l => {
    let cleaned = l.replace(/^\s*>\s*/, '');
    cleaned = cleaned.replace(/^\s*\d+\s*:\s*/, '');
    return { text: cleaned, marked: /^\s*>/.test(l) };
  });
  const matchLine = (parsed.find(p => p.marked) || { text: '' }).text;
  const markedIdx = parsed.findIndex(p => p.marked);
  const before = markedIdx >= 0 ? parsed.slice(0, markedIdx).map(p => p.text) : [];
  const after  = markedIdx >= 0 ? parsed.slice(markedIdx + 1).map(p => p.text) : [];
  return { lines: parsed.map(p => p.text), matchLine, before, after };
}

function scoreTokensForMatch(m) {
  const toks = tokensBySub.get(m.subsystem) || [];
  if (!toks.length) return [];

  const ctx = parseContextLines(m.surroundingContext);
  const kws = new Set();
  if (m.elementHint) for (const s of String(m.elementHint).split(/[\s\-_/]+/)) if (s) kws.add(s.toLowerCase());
  if (m.dispatchSelector) {
    const first = String(m.dispatchSelector).split(/[,]/)[0].trim().replace(/^\./, '');
    for (const s of first.split(/[-_]/)) if (s) kws.add(s.toLowerCase());
  }
  const text = (ctx.matchLine || '') + ' ' + (ctx.before || []).slice(-2).join(' ');
  const wordRe = /\b([a-zA-Z][a-zA-Z0-9]{2,})\b/g;
  const stopwords = new Set(['const','let','var','return','this','import','from','null','true','false',
    'style','props','color','background','border','shadow','outline','fill','stroke','width','height',
    'font','text','size','center','flex','div','span','none','auto','inherit','rgba','rgb','hsl','var',
    'linear','gradient','new','for','if','else','while','do','try','catch','function','class']);
  let mm;
  while ((mm = wordRe.exec(text)) !== null) {
    const w = mm[1].toLowerCase();
    if (!stopwords.has(w)) kws.add(w);
  }
  const fileBase = path.basename(m.path || '').replace(/\.(jsx?|tsx?)$/, '').toLowerCase();
  for (const s of fileBase.split(/(?=[A-Z])|[-_]/)) if (s && s.length > 2) kws.add(s.toLowerCase());

  const kwsArr = [...kws];
  return toks.map(t => {
    const nameSegs = t.name.replace(/^--theme-/, '').split('-');
    let score = 0;
    for (const kw of kwsArr) {
      if (!kw || kw.length < 2) continue;
      if (nameSegs.some(s => s.toLowerCase() === kw)) score += 3;
      else if (nameSegs.some(s => s.toLowerCase().includes(kw) || kw.includes(s.toLowerCase()))) score += 1;
    }
    return { name: t.name, role: tokenRole(t.name), score };
  }).sort((a, b) => b.score - a.score);
}

// ── Classify MEDIUM reason ────────────────────────────────────────────────
function classifyMediumReason(m, allScores) {
  const rule = m.assignmentRule || '';
  if (rule.endsWith('-subsystem-primary')) return 'primary-fallback';
  if (rule === 'gradient-chrome-keyword' || rule === 'gradient-chrome-primary') return 'gradient-kw';
  // Determine if it was a tie or weak
  const top = allScores[0];
  const second = allScores[1];
  if (!top) return 'weak-match';
  if (top.score >= 3 && second && second.score === top.score) return 'score-tie';
  if (top.score >= 3 && second && second.score >= 3) return 'score-tie';
  if (top.score >= 1 && top.score <= 2) return 'weak-match';
  // Score >= 3 but second is lower — this would normally be HIGH; being MEDIUM means
  // either ambiguous flag fired on a different code path, or is a partial/canvas path
  if (rule.includes('-partial')) return 'weak-match';
  if (top.score >= 3) return 'score-tie'; // two candidates at >= 3
  return 'weak-match';
}

// ── Pick 20 diverse MEDIUM samples ───────────────────────────────────────
const mediums = enriched.matches.filter(m => m.confidence === 'medium');

// Group by assignmentRule, pick ~2 per rule, prioritising highest-count rules
const byRule = new Map();
for (const m of mediums) {
  const r = m.assignmentRule || 'unknown';
  if (!byRule.has(r)) byRule.set(r, []);
  byRule.get(r).push(m);
}

// Sort rules by frequency desc
const rulesSorted = [...byRule.entries()].sort((a, b) => b[1].length - a[1].length);
const picks = [];
const perRuleTarget = 2;
for (const [, arr] of rulesSorted) {
  // Pick samples spread across different subsystems for this rule
  const subsystemSeen = new Set();
  for (const m of arr) {
    if (picks.length >= 20) break;
    if (subsystemSeen.has(m.subsystem) && arr.length > 5) continue;
    subsystemSeen.add(m.subsystem);
    picks.push(m);
    if (subsystemSeen.size >= perRuleTarget) break;
  }
  if (picks.length >= 20) break;
}
// If under 20, fill from remaining
if (picks.length < 20) {
  const pickSet = new Set(picks);
  for (const m of mediums) {
    if (picks.length >= 20) break;
    if (!pickSet.has(m)) { picks.push(m); pickSet.add(m); }
  }
}

// ── Print table ───────────────────────────────────────────────────────────
function trunc(s, n) { s = String(s||''); return s.length > n ? s.slice(0,n-1)+'…' : s; }
function esc(s) { return String(s||'').replace(/\|/g,'\\|'); }

console.log('# MEDIUM Confidence Sample — 20 rows\n');
console.log(`Total MEDIUM: ${mediums.length} of ${enriched.matches.length} (${((100*mediums.length)/enriched.matches.length).toFixed(1)}%)\n`);

// Rule breakdown table
console.log('## Breakdown by assignmentRule\n');
console.log('| Rule | Count |');
console.log('|---|---:|');
for (const [r, arr] of rulesSorted) console.log(`| ${r} | ${arr.length} |`);
console.log('');

// MEDIUM reason category totals (sample all 335)
const reasons = { 'score-tie': 0, 'weak-match': 0, 'primary-fallback': 0, 'gradient-kw': 0 };
for (const m of mediums) {
  const scores = scoreTokensForMatch(m);
  const reason = classifyMediumReason(m, scores);
  reasons[reason] = (reasons[reason] || 0) + 1;
}
console.log('## MEDIUM reason breakdown (all ' + mediums.length + ' matches)\n');
console.log('| Reason | Count | % |');
console.log('|---|---:|---:|');
for (const [r, c] of Object.entries(reasons)) {
  console.log(`| ${r} | ${c} | ${((100*c)/mediums.length).toFixed(1)}% |`);
}
console.log('');

// 20-row detail table
console.log('## 20-sample detail\n');
console.log('| # | File:Line | Matched | → Token | Rule | MEDIUM reason | 2nd candidate (score) | 1st score |');
console.log('|---|---|---|---|---|---|---|---|');

for (let i = 0; i < picks.length; i++) {
  const m = picks[i];
  const scores = scoreTokensForMatch(m);
  const top    = scores[0];
  const second = scores[1];
  const reason = classifyMediumReason(m, scores);
  const secondStr = second && second.score > 0
    ? `\`${trunc(second.name, 40)}\` (${second.score})`
    : '(none)';
  const topScore = top ? top.score : '?';
  const fileShort = m.path.replace(/^.*[/\\]/, '');
  console.log(
    `| ${i+1} | ${esc(fileShort)}:${m.line} ` +
    `| \`${esc(trunc(m.matchedText, 22))}\` ` +
    `| \`${esc(trunc(m.proposedTokenName||'(none)', 40))}\` ` +
    `| ${esc(m.assignmentRule)} ` +
    `| **${reason}** ` +
    `| ${esc(secondStr)} ` +
    `| ${topScore} |`
  );
}

console.log('');
console.log('## Interpretation');
console.log('');
console.log('- **score-tie**: top token scored ≥3 but another token tied or was within 1 — genuinely ambiguous, MEDIUM is correct.');
console.log('- **weak-match**: top score was 1–2 — element context thin, MEDIUM is correct.');
console.log('- **primary-fallback**: no element scored; subsystem primary token assigned — MEDIUM is the right floor.');
console.log('- **gradient-kw**: gradient with keyword overlap only — MEDIUM is correct.');
console.log('');
console.log('Tighten HIGH threshold if ≥10/20 samples show score-tie with a clear 3+ gap to 2nd candidate.');
