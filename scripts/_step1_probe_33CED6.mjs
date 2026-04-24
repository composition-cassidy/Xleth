// Probe: trace classifier behavior for #33CED6 matches across all subsystems.
// Reuses the bundled runtime from theming-audit-enrich-v2.js.

import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ROOT = path.resolve(import.meta.dirname, '..');
const BUNDLE = path.resolve(ROOT, 'ui/node_modules/.theming-v2-cache/bundle.cjs');
const { TOKENS, TOKENS_BY_NAME, BASE_DEFAULTS, deriveTheme } = require(BUNDLE);

const derived = deriveTheme(BASE_DEFAULTS, []);
function leaf(name, seen = new Set()) {
  if (seen.has(name)) return null;
  seen.add(name);
  const t = TOKENS_BY_NAME[name];
  if (!t) return null;
  switch (t.derivation.type) {
    case 'base': return BASE_DEFAULTS[name] || null;
    case 'explicit': return t.derivation.value;
    case 'derived-formula': return derived[name] || null;
    case 'derived-var': return leaf(t.derivation.ref, seen);
  }
  return null;
}

const TARGET = '#33ced6';
function norm(v) { return String(v || '').trim().toLowerCase(); }

const allMatching = TOKENS.filter(t => t.kind === 'color' && norm(leaf(t.name)) === TARGET);

console.log(`All catalog tokens resolving to ${TARGET}: ${allMatching.length}`);
console.log();
for (const t of allMatching) {
  console.log(`  ${t.name.padEnd(50)} subsystem=${t.subsystem.padEnd(28)} derivation=${t.derivation.type}` +
              (t.derivation.type === 'derived-var' ? ` ref=${t.derivation.ref}` : '') +
              (t.crossSubsystem ? ' [crossSub]' : ''));
}
console.log();

const UNIVERSAL = new Set(['base', 'derived', 'borders', 'text', 'semantic', 'labels']);

// Now simulate the classifier's Gate 3 + Rule 2a + Rule 1 for each LOW match
// of #33CED6 (subsystems: piano-roll, timeline, labels, lip-sync-picker).
const subsystemsToProbe = ['piano-roll', 'timeline', 'labels', 'lip-sync-picker'];
for (const sub of subsystemsToProbe) {
  console.log('═'.repeat(72));
  console.log(`Subsystem: ${sub}`);
  console.log('─'.repeat(72));

  // Gate 3 — partition.
  const same = allMatching.filter(t => t.subsystem === sub);
  const universal = allMatching.filter(t => UNIVERSAL.has(t.subsystem));
  const cross = allMatching.filter(t => t.crossSubsystem === true && !UNIVERSAL.has(t.subsystem) && t.subsystem !== sub);
  const passed = [...same, ...universal, ...cross];
  console.log(`  Gate 3 same:      ${same.length}  [${same.map(t => t.name).join(', ') || '—'}]`);
  console.log(`  Gate 3 universal: ${universal.length}  [${universal.map(t => t.name).join(', ')}]`);
  console.log(`  Gate 3 crossSub:  ${cross.length}  [${cross.map(t => t.name).join(', ') || '—'}]`);
  console.log(`  Gate 3 total:     ${passed.length}`);

  // Rule 2a Part 1: drop derived-var aliases whose ref is in pool and tail is ungrounded.
  // For probe purposes, simulate with empty hint (worst case — will drop pure pass-through aliases).
  const names = new Set(passed.map(t => t.name));
  const subsystemWords = new Set(sub.split(/[.\-]/).filter(Boolean));
  const GENERIC = new Set(['fg','bg','color','fill','stroke','border','default','subtle']);
  function tail(t) {
    return t.name.replace(/^--theme-/, '').toLowerCase().split('-')
      .filter(p => !subsystemWords.has(p) && !GENERIC.has(p));
  }
  let kept = passed.filter(t => {
    if (t.derivation.type !== 'derived-var') return true;
    if (!names.has(t.derivation.ref)) return true;
    const tl = tail(t);
    if (tl.length === 0) return false; // pure pass-through → drop
    return true; // assume ungrounded; would need real hint to grade
  });
  console.log(`  After Rule 2a Part 1 (drop pure pass-through aliases): ${kept.length}`);
  console.log(`    [${kept.map(t => t.name).join(', ')}]`);

  // Rule 2a Part 2: drop same-sub explicit/derived-formula when universal base
  // is in pool AND ≥2 same-sub remain with same value.
  const hasUniversalBase = kept.some(
    t => UNIVERSAL.has(t.subsystem)
      && (t.derivation.type === 'base' || t.derivation.type === 'derived-formula')
  );
  const sameSubCount = kept.filter(t => t.subsystem === sub).length;
  console.log(`  Rule 2a Part 2 trigger: hasUniversalBase=${hasUniversalBase}, sameSubCount=${sameSubCount}`);
  if (hasUniversalBase && sameSubCount >= 2) {
    kept = kept.filter(t => {
      if (t.subsystem !== sub) return true;
      if (t.derivation.type !== 'explicit' && t.derivation.type !== 'derived-formula') return true;
      // Worst-case: assume ungrounded → drop
      return false;
    });
    console.log(`    After Part 2: ${kept.length}  [${kept.map(t => t.name).join(', ')}]`);
  }

  // Rule 1 (line 685): if same.length > 0 → drop universal+crossSub.
  const sameKept = kept.filter(t => t.subsystem === sub);
  const univKept = kept.filter(t => UNIVERSAL.has(t.subsystem) && t.subsystem !== sub);
  const crossKept = kept.filter(t => t.crossSubsystem === true && !UNIVERSAL.has(t.subsystem) && t.subsystem !== sub);
  let final;
  if (sameKept.length > 0) {
    final = sameKept;
    console.log(`  Rule 1 (same > universal): SAME wins; UNIVERSAL dropped (${univKept.length} tokens including ${univKept.map(t => t.name).join(', ') || '—'})`);
  } else if (univKept.length > 0) {
    final = univKept;
    console.log(`  Rule 1: no same-sub; UNIVERSAL pool used`);
  } else {
    final = crossKept;
    console.log(`  Rule 1: only crossSub left`);
  }
  console.log(`  → Final candidates: [${final.map(t => t.name).join(', ')}]`);
  console.log();
}
