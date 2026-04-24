#!/usr/bin/env node
// Step 5 — 30-sample MEDIUM correctness audit. Subsystem-weighted, seeded.
'use strict';
const fs = require('fs');
const path = require('path');

const v2 = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'theming-audit-enriched-v2.json'), 'utf8'));
const meds = v2.entries.filter(e => e.confidence === 'medium');

// Group by subsystem
const bySub = new Map();
for (const e of meds) {
  if (!bySub.has(e.subsystem)) bySub.set(e.subsystem, []);
  bySub.get(e.subsystem).push(e);
}

// Seeded PRNG (mulberry32)
function mulberry32(seed) {
  return function() {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260420); // reproducible

// Step 1: 1 per subsystem that has ≥1 MEDIUM
const picked = [];
const pickedKeys = new Set();
for (const [sub, arr] of bySub.entries()) {
  const idx = Math.floor(rng() * arr.length);
  const e = arr[idx];
  const key = `${e.path}:${e.line}:${e.column}`;
  if (!pickedKeys.has(key)) { picked.push(e); pickedKeys.add(key); }
}

// Step 2: fill up to 30 weighted by subsystem size
const weights = [...bySub.entries()].map(([sub, arr]) => ({ sub, count: arr.length }));
const totalWeight = weights.reduce((s, w) => s + w.count, 0);

while (picked.length < 30) {
  // Weighted pick of subsystem
  let r = rng() * totalWeight;
  let chosenSub = weights[0].sub;
  for (const w of weights) { r -= w.count; if (r <= 0) { chosenSub = w.sub; break; } }
  const arr = bySub.get(chosenSub);
  const e = arr[Math.floor(rng() * arr.length)];
  const key = `${e.path}:${e.line}:${e.column}`;
  if (pickedKeys.has(key)) continue;
  picked.push(e); pickedKeys.add(key);
}

console.log(`=== Step 5 — 30-sample MEDIUM correctness audit ===\n`);
console.log(`Seed: 20260420 (mulberry32). Sample: ${picked.length}/${meds.length} MEDIUM.\n`);

picked.forEach((e, i) => {
  console.log(`#${String(i+1).padStart(2, '0')}  ${e.path}:${e.line}:${e.column}  [${e.subsystem}]`);
  console.log(`    matched : ${JSON.stringify(e.matchedText)}  (kind=${e.kind}, hint=${e.elementHint})`);
  console.log(`    → ${e.proposedTokenName}  [${e.assignmentRule}]`);
  console.log(`    gates   : ${e.gatesPassed.join(' → ')}`);
  // Compact context
  const ctx = (e.surroundingContext || '').split('\n').map(l => l.trim()).join(' | ').slice(0, 200);
  console.log(`    context : ${ctx}`);
  console.log('');
});
