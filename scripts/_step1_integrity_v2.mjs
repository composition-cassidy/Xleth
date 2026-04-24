// Step 1.1 integrity checks — Phase 0 Color-Token Migration (v2 audit).
// Pure-Node regex-based parse of catalog.ts — no TS runner needed.
// Validates: 584 entries, every proposedTokenName ∈ TOKENS_BY_NAME,
// match.subsystem aligns with token.subsystem (universals + crossSubsystem
// excepted), tier counts match expected.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENRICHED = path.join(ROOT, 'scripts/theming-audit-enriched-v2.json');
const CATALOG  = path.join(ROOT, 'ui/src/theming/tokens/catalog.ts');

const catSrc = fs.readFileSync(CATALOG, 'utf8');

// ── Parse token defs ────────────────────────────────────────────────────────
// Find every TokenDef object literal: name + subsystem fields. Tokens are
// declared via helper calls (base, derivedFormula, explicit, ref, alias) plus
// inline `{ name: '--theme-x', ..., subsystem: 'foo', ... }` objects in TOKENS.
// Catalog uses helper functions that return TokenDef. Match by either form.

const tokens = new Map(); // name -> { subsystem, crossSubsystem }

// Form A — helper-call form: helperName('--theme-x', ..., '<subsystem>')
// Per catalog, last string arg is subsystem (and crossSubsystem flag may follow as object).
const HELPER = /\b(base|derivedFormula|explicit|explicitX|ref|alias|crossSub|crossSubsystem)\(\s*'(--theme-[a-z0-9-]+)'([^)]*)\)/gi;
let m;
while ((m = HELPER.exec(catSrc)) !== null) {
  const helper = m[1];
  const name = m[2];
  const rest = m[3];
  const stringArgs = [...rest.matchAll(/'([^']*)'/g)].map(x => x[1]);
  // For helpers that take (name, ..., category, subsystem), last string is subsystem.
  // For alias(name, target), no subsystem in args — skip subsystem.
  let subsystem = stringArgs.length >= 2 ? stringArgs[stringArgs.length - 1] : null;
  // crossSub helper at line 149 wraps explicit() with crossSubsystem:true
  const cross = helper === 'explicitX' || helper === 'crossSub' || helper === 'crossSubsystem' || /crossSubsystem\s*:\s*true/.test(rest);
  if (!tokens.has(name)) tokens.set(name, { subsystem, crossSubsystem: cross, helper });
  else {
    const cur = tokens.get(name);
    if (!cur.subsystem && subsystem) cur.subsystem = subsystem;
    if (cross) cur.crossSubsystem = true;
  }
}

// Form B — inline TokenDef object literals: { name: '--theme-x', ..., subsystem: 'y', ... crossSubsystem: true }
const INLINE = /\{[^{}]*?name:\s*'(--theme-[a-z0-9-]+)'[^{}]*?subsystem:\s*'([a-z0-9.-]+)'[^{}]*?\}/gis;
while ((m = INLINE.exec(catSrc)) !== null) {
  const name = m[1];
  const subsystem = m[2];
  const block = m[0];
  const cross = /crossSubsystem\s*:\s*true/.test(block);
  if (!tokens.has(name)) tokens.set(name, { subsystem, crossSubsystem: cross, helper: 'inline' });
  else {
    const cur = tokens.get(name);
    if (!cur.subsystem) cur.subsystem = subsystem;
    if (cross) cur.crossSubsystem = true;
  }
}

// Annotate cross-subsystem flag from the broader catalog scan: any token whose
// definition block (helper call or inline) has crossSubsystem:true OR whose
// containing factory at line 149 returns crossSubsystem:true.
// Re-scan: for each token, look ±200 chars for crossSubsystem:true literal.
for (const [name, info] of tokens) {
  const idx = catSrc.indexOf(`'${name}'`);
  if (idx < 0) continue;
  const window = catSrc.slice(Math.max(0, idx - 100), Math.min(catSrc.length, idx + 400));
  if (/crossSubsystem\s*:\s*true/.test(window)) info.crossSubsystem = true;
}

// ── Parse SUBSYSTEMS list (for alias resolution) ────────────────────────────
const subsystem_aliases = {}; // alias -> canonical
const SUBSYS_BLOCK = catSrc.match(/SUBSYSTEMS[^[]*\[(.*?)\n\];/s);
if (SUBSYS_BLOCK) {
  const block = SUBSYS_BLOCK[1];
  const ENTRY = /key:\s*'([a-z0-9.-]+)'[^}]*?(?:aliases:\s*\[([^\]]*)\])?[^}]*?\}/gis;
  while ((m = ENTRY.exec(block)) !== null) {
    const key = m[1];
    const aliasList = m[2];
    if (aliasList) {
      for (const a of [...aliasList.matchAll(/'([^']+)'/g)].map(x => x[1])) {
        subsystem_aliases[a] = key;
      }
    }
  }
}

// ── Load enriched audit ────────────────────────────────────────────────────
const data = JSON.parse(fs.readFileSync(ENRICHED, 'utf8'));
const entries = data.entries;
const tierCounts = data.tierCounts;

console.log('═'.repeat(72));
console.log('  STEP 1.1 — INTEGRITY CHECKS (v2 audit)');
console.log('═'.repeat(72));
console.log();
console.log(`Catalog tokens parsed:  ${tokens.size}`);
console.log(`Cross-subsystem tokens: ${[...tokens.values()].filter(t => t.crossSubsystem).length}`);
console.log(`Subsystem aliases:      ${Object.keys(subsystem_aliases).length}`);
console.log(`Enriched entries:       ${entries.length}`);
console.log();

let allPass = true;

// ── Check 1: 584 entries ───────────────────────────────────────────────────
const ok1 = entries.length === 584;
console.log(`[Check 1] Enriched audit has 584 entries`);
console.log(`   Actual: ${entries.length}  →  ${ok1 ? 'PASS' : 'FAIL'}`);
console.log();
allPass = allPass && ok1;

// ── Check 2: every non-null proposedTokenName ∈ catalog ────────────────────
const missing = new Map(); // token -> [locations]
for (const e of entries) {
  const tok = e.proposedTokenName;
  if (tok && !tokens.has(tok)) {
    if (!missing.has(tok)) missing.set(tok, []);
    missing.get(tok).push(`${e.path}:${e.line}`);
  }
}
const ok2 = missing.size === 0;
console.log(`[Check 2] Every non-null proposedTokenName exists in catalog`);
if (ok2) console.log(`   All proposed tokens found.  →  PASS`);
else {
  console.log(`   ${missing.size} missing token(s):`);
  for (const [tok, locs] of missing) {
    console.log(`     ${tok}  (${locs.length} matches, sample: ${locs[0]})`);
  }
  console.log(`   →  FAIL`);
}
console.log();
allPass = allPass && ok2;

// ── Check 3: subsystem alignment ───────────────────────────────────────────
const UNIVERSAL = new Set(['base', 'borders', 'text', 'semantic', 'derived', 'labels']);
const misaligned = [];
for (const e of entries) {
  const tok = e.proposedTokenName;
  if (!tok) continue;
  const info = tokens.get(tok);
  if (!info || !info.subsystem) continue;
  const tokSub = info.subsystem;
  let matchSub = e.subsystem;
  if (matchSub === tokSub) continue;
  if (UNIVERSAL.has(tokSub)) continue;
  if (info.crossSubsystem) continue;
  if (subsystem_aliases[matchSub] === tokSub) continue;
  misaligned.push({ path: e.path, line: e.line, matchSub, tok, tokSub });
}
const ok3 = misaligned.length === 0;
console.log(`[Check 3] match.subsystem aligns with token.subsystem (universals + crossSubsystem excepted)`);
if (ok3) console.log(`   All matches align.  →  PASS`);
else {
  console.log(`   ${misaligned.length} misaligned:`);
  const grp = new Map();
  for (const x of misaligned) {
    const k = `${x.matchSub}→${x.tokSub}`;
    grp.set(k, (grp.get(k) || 0) + 1);
  }
  for (const [k, c] of [...grp.entries()].sort((a,b)=>b[1]-a[1]).slice(0,15)) {
    console.log(`     match.subsystem=${k.split('→')[0]}  token.subsystem=${k.split('→')[1]}  (${c} matches)`);
  }
  console.log(`   Sample misaligned entries:`);
  for (const x of misaligned.slice(0, 5)) {
    console.log(`     ${x.path}:${x.line}  match=${x.matchSub}  token=${x.tok}  tokSub=${x.tokSub}`);
  }
  console.log(`   →  FAIL`);
}
console.log();
allPass = allPass && ok3;

// ── Check 4: tier counts ───────────────────────────────────────────────────
const expected = { high: 185, medium: 115, low: 37, 'no-fit': 238, 'false-positive': 9 };
const actual = { high: 0, medium: 0, low: 0, 'no-fit': 0, 'false-positive': 0 };
for (const e of entries) actual[e.confidence] = (actual[e.confidence] || 0) + 1;
const ok4 = Object.entries(expected).every(([k, v]) => actual[k] === v);
console.log(`[Check 4] Tier counts match expected (185 HIGH, 115 MEDIUM, 37 LOW, 238 NO-FIT, 9 FP)`);
for (const [k, v] of Object.entries(expected)) {
  const a = actual[k] || 0;
  console.log(`   ${k.padEnd(16)}: expected ${String(v).padStart(4)}  actual ${String(a).padStart(4)}  [${a===v?'OK':'MISMATCH'}]`);
}
console.log(`   →  ${ok4 ? 'PASS' : 'FAIL'}`);
console.log();
allPass = allPass && ok4;

// ── Check 5: header tierCounts consistent with body ────────────────────────
const ok5 = Object.entries(actual).every(([k, v]) => (tierCounts[k] || 0) === v);
console.log(`[Check 5] Header tierCounts consistent with entry data`);
if (ok5) console.log(`   Consistent.  →  PASS`);
else {
  console.log(`   Header: ${JSON.stringify(tierCounts)}`);
  console.log(`   Actual: ${JSON.stringify(actual)}`);
  console.log(`   →  FAIL`);
}
console.log();
allPass = allPass && ok5;

console.log('═'.repeat(72));
console.log(`  OVERALL: ${allPass ? 'ALL PASS — proceed to Step 1.2' : 'INTEGRITY FAILURES — fix before proceeding'}`);
console.log('═'.repeat(72));
process.exit(allPass ? 0 : 1);
