// Step 1.2 — print all 37 LOW-confidence entries from the v2 audit, one per
// section, formatted per the migration plan's "breathing room" template.
//
// Distribution (pre-counted from spec): node-editor 10, timeline 9,
// lip-sync-picker 4, stock-effects.shared 3, piano-roll 3, dialogs-modals 3,
// stock-effects.dynamics 1, sampler 1, labels 1, syllable-splitter 1,
// preview-player 1.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENRICHED = path.join(ROOT, 'scripts/theming-audit-enriched-v2.json');

const data = JSON.parse(fs.readFileSync(ENRICHED, 'utf8'));
const lows = data.entries.filter(e => e.confidence === 'low');

console.log(`# Step 1.2 — ${lows.length} LOW-confidence entries pending approval`);
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
console.log('═'.repeat(72));
console.log();

let i = 0;
for (const e of lows) {
  i++;
  console.log(`---`);
  console.log(`### [${i}/${lows.length}] subsystem: ${e.subsystem}`);
  console.log();
  console.log(`**File:** ${e.path}:${e.line}`);
  console.log(`**Matched text:** \`${e.matchedText}\` (${e.kind}, element-hint: ${e.elementHint || 'n/a'})`);
  console.log(`**Proposed token:** \`${e.proposedTokenName}\``);
  console.log(`**Surrounding context:**`);
  console.log('```');
  console.log(e.surroundingContext);
  console.log('```');
  console.log(`**Rationale:** ${e.rationale}`);
  if (e.assignmentRule) console.log(`**Assignment rule:** ${e.assignmentRule}`);
  if (e.gatesPassed?.length) console.log(`**Gates passed:** ${e.gatesPassed.join(', ')}`);
  console.log();
}

console.log('═'.repeat(72));
console.log();
console.log('Awaiting LOW approvals and migration-plan approval.');
