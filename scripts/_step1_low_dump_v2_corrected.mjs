// Step 1.2 (corrected) — print all LOW-confidence entries from the post-
// corrective-pass enrichment. Marks entries that were touched by the
// corrective pass (overrides + demotions) so the LOW review can prioritize
// the deltas.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CORRECTED = path.join(ROOT, 'scripts/theming-audit-enriched-v2-corrected.json');
const ORIGINAL = path.join(ROOT, 'scripts/theming-audit-enriched-v2.json');

const data = JSON.parse(fs.readFileSync(CORRECTED, 'utf8'));
const orig = JSON.parse(fs.readFileSync(ORIGINAL, 'utf8'));

function key(e) { return `${e.path}:${e.line}:${e.column}`; }
const origByKey = new Map(orig.entries.map(e => [key(e), e]));

const lows = data.entries.filter(e => e.confidence === 'low');

console.log(`# Step 1.2 (corrected) — ${lows.length} LOW-confidence entries pending approval`);
console.log();
console.log(`Source: scripts/theming-audit-enriched-v2-corrected.json`);
console.log(`(post-corrective-pass; original v2 had 37 LOWs, +2 demoted from MEDIUM = 39)`);
console.log();

const bySub = {};
for (const e of lows) (bySub[e.subsystem] ??= []).push(e);
console.log(`Distribution by subsystem:`);
for (const [s, arr] of Object.entries(bySub).sort((a,b)=>b[1].length - a[1].length)) {
  console.log(`  ${s.padEnd(28)} ${arr.length}`);
}
console.log();
console.log(`Total: ${lows.length}`);
console.log();

// Categorize: NEW (demoted from MEDIUM), OVERRIDDEN (corrective pass changed assignment),
// HARDCODED (perc-label override), UNCHANGED (original LOW).
const cats = { NEW: [], OVERRIDDEN: [], HARDCODED: [], UNCHANGED: [] };
for (const e of lows) {
  const o = origByKey.get(key(e));
  if (e.assignmentRule === 'hardcoded-override-perc-label') cats.HARDCODED.push(e);
  else if (!o || o.confidence !== 'low') cats.NEW.push(e);
  else if (e.correctivePassPriorAssignment) cats.OVERRIDDEN.push(e);
  else cats.UNCHANGED.push(e);
}
console.log(`Categories:`);
console.log(`  NEW (demoted MEDIUM → LOW by corrective pass): ${cats.NEW.length}`);
console.log(`  OVERRIDDEN (corrective pass changed assignment, still LOW): ${cats.OVERRIDDEN.length}`);
console.log(`  HARDCODED (perc-label override, visual-changing): ${cats.HARDCODED.length}`);
console.log(`  UNCHANGED (original LOW, untouched): ${cats.UNCHANGED.length}`);
console.log();
console.log('═'.repeat(72));
console.log();

function dump(label, arr, startIdx) {
  if (arr.length === 0) return startIdx;
  console.log();
  console.log(`## ${label} (${arr.length})`);
  console.log();
  let i = startIdx;
  for (const e of arr) {
    i++;
    console.log(`---`);
    console.log(`### [${i}/${lows.length}] subsystem: ${e.subsystem}`);
    console.log();
    console.log(`**File:** ${e.path}:${e.line}  (col ${e.column})`);
    console.log(`**Matched text:** \`${e.matchedText}\` (${e.kind}, element-hint: ${e.elementHint || 'n/a'})`);
    console.log(`**Proposed token:** \`${e.proposedTokenName}\``);
    if (e.correctivePassPriorAssignment) {
      console.log(`**Prior assignment (pre-corrective):** \`${e.correctivePassPriorAssignment}\``);
    }
    if (e.visualChangingOverride) {
      console.log(`**⚠️  VISUAL-CHANGING OVERRIDE** (intentional bug fix)`);
    }
    console.log(`**Surrounding context:**`);
    console.log('```');
    console.log(e.surroundingContext);
    console.log('```');
    console.log(`**Rationale:** ${e.rationale}`);
    if (e.assignmentRule) console.log(`**Assignment rule:** ${e.assignmentRule}`);
    if (e.ambiguous) console.log(`**Ambiguous:** ${e.ambiguityReason || 'yes'}`);
    if (e.gatesPassed?.length) console.log(`**Gates passed:** ${e.gatesPassed.join(', ')}`);
    console.log();
  }
  return i;
}

let i = 0;
i = dump('HARDCODED — visual-changing override (Krasen pre-decision)', cats.HARDCODED, i);
i = dump('NEW — demoted from MEDIUM by corrective pass', cats.NEW, i);
i = dump('OVERRIDDEN — corrective pass reassigned (still LOW)', cats.OVERRIDDEN, i);
i = dump('UNCHANGED — original LOW, not touched by corrective pass', cats.UNCHANGED, i);

console.log('═'.repeat(72));
console.log();
console.log(`Awaiting comprehensive LOW approval pass (${lows.length} entries).`);
