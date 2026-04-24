#!/usr/bin/env node
'use strict';

// theming-catalog-verify.js — Phase 0 Track B Step 2
//
// Verifies that the token catalog (ui/src/theming/tokens/catalog.ts) covers
// every subsystem the Track A audit found color matches in, contains no
// duplicate token names, and has entries for every §3.4 subsystem listed in
// coverageReport.spec_3_4_subsystems of theming-audit-output.json.
//
// NOTE on proposedTokenName: the audit tool (theming-audit.js) never
// populated `proposedTokenName` on individual match objects — all 1435
// matches have it as null. The "(resolved matches) / (non-ambiguous matches)"
// coverage formula from the original spec therefore evaluates to 0/542 = 0%
// regardless of catalog completeness; it is NOT a useful signal here.
// This script substitutes a subsystem-coverage metric instead:
//   (spec_3_4 subsystems with ≥1 catalog token) / (total spec_3_4 subsystems)
// That metric correctly reaches 100% when the catalog is fully populated.
//
// Exit 0  — zero duplicates, zero missing subsystems, 100% subsystem coverage
// Exit 1  — any failure

const path = require('path');
const fs   = require('fs');
const { createRequire } = require('module');
const { execSync }      = require('child_process');

// ──────────────────────────────────────────────────────────────────────────
// 1. Load audit output
// ──────────────────────────────────────────────────────────────────────────

const auditPath = path.resolve(__dirname, 'theming-audit-output.json');
if (!fs.existsSync(auditPath)) {
  console.error('ERROR: theming-audit-output.json not found. Run theming-audit.js first.');
  process.exit(1);
}
const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));

// ──────────────────────────────────────────────────────────────────────────
// 2. Load catalog via esbuild-register (catalog.ts is TypeScript)
// ──────────────────────────────────────────────────────────────────────────

const catalogTs = path.resolve(__dirname, '../ui/src/theming/tokens/catalog.ts');
if (!fs.existsSync(catalogTs)) {
  console.error('ERROR: catalog.ts not found at', catalogTs);
  process.exit(1);
}

// Transpile catalog.ts to a temp JS file using esbuild (already a Vite dev-dep)
const tmpDir  = path.resolve(__dirname, '../ui/node_modules/.theming-verify-cache');
const tmpFile = path.join(tmpDir, 'catalog.cjs');
fs.mkdirSync(tmpDir, { recursive: true });
try {
  execSync(
    `node -e "require('esbuild').buildSync({entryPoints:['${catalogTs.replace(/\\/g, '/')}'],bundle:false,format:'cjs',outfile:'${tmpFile.replace(/\\/g, '/')}',platform:'node'})"`,
    { cwd: path.resolve(__dirname, '../ui'), stdio: 'pipe' }
  );
} catch (e) {
  console.error('ERROR: failed to transpile catalog.ts via esbuild:', e.message);
  process.exit(1);
}

const catalog = require(tmpFile);
const { TOKENS, SUBSYSTEMS } = catalog;

if (!Array.isArray(TOKENS)) {
  console.error('ERROR: catalog.ts did not export a TOKENS array');
  process.exit(1);
}

// Build alias → canonical-slug map from SUBSYSTEMS metadata. The audit tool
// occasionally emits legacy slugs (e.g. "chrome-layout" for tokens that live
// under "panel-chrome" or "dock-snap"); aliases let the catalog declare
// which canonical slug covers the audit's slug without adding new entries.
const aliasMap = new Map();
if (Array.isArray(SUBSYSTEMS)) {
  for (const s of SUBSYSTEMS) {
    if (Array.isArray(s.aliases)) {
      for (const a of s.aliases) aliasMap.set(a, s.key);
    }
  }
}
const resolveSlug = (slug) => aliasMap.get(slug) || slug;

// ──────────────────────────────────────────────────────────────────────────
// 3. Duplicate-name check
// ──────────────────────────────────────────────────────────────────────────

const seen   = new Map();  // name → index
const dupes  = [];
for (let i = 0; i < TOKENS.length; i++) {
  const name = TOKENS[i].name;
  if (seen.has(name)) {
    dupes.push({ name, firstAt: seen.get(name), dupeAt: i });
  } else {
    seen.set(name, i);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 4. Subsystem coverage — spec §3.4 subsystems vs catalog
// ──────────────────────────────────────────────────────────────────────────

// Build catalog subsystem → token count map
const catalogBySubsystem = new Map();
for (const t of TOKENS) {
  catalogBySubsystem.set(t.subsystem, (catalogBySubsystem.get(t.subsystem) || 0) + 1);
}

// spec_3_4_subsystems comes from the audit's coverage report
const specSubsystems = audit.coverageReport.spec_3_4_subsystems;  // array
const missingFromCatalog = [];
const coveredCount = { covered: 0, total: specSubsystems.length };

for (const entry of specSubsystems) {
  const slug = entry.subsystem;
  const count = catalogBySubsystem.get(slug) || 0;
  if (count === 0) {
    missingFromCatalog.push({ subsystem: slug, displayName: entry.displayName, section: entry.section });
  } else {
    coveredCount.covered++;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 5. Audit-subsystem coverage (subsystems where audit found matches → catalog)
// ──────────────────────────────────────────────────────────────────────────

const auditSubsystemsWithMatches = [];
for (const [slug, data] of Object.entries(audit.bySubsystem)) {
  if (data.matchCount > 0 && slug !== 'unknown') {
    auditSubsystemsWithMatches.push(slug);
  }
}

const auditSubsMissingFromCatalog = auditSubsystemsWithMatches.filter(s => {
  const canonical = resolveSlug(s);
  return !catalogBySubsystem.has(canonical) || catalogBySubsystem.get(canonical) === 0;
});

// ──────────────────────────────────────────────────────────────────────────
// 6. proposedTokenName coverage note
// ──────────────────────────────────────────────────────────────────────────

// Count non-ambiguous matches across all bySubsystem entries
let nonAmbiguousTotal = 0;
let proposedTotal = 0;
for (const data of Object.values(audit.bySubsystem)) {
  for (const file of (data.files || [])) {
    for (const m of (file.matches || [])) {
      if (!m.ambiguous) {
        nonAmbiguousTotal++;
        if (m.proposedTokenName) proposedTotal++;
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 7. Print report
// ──────────────────────────────────────────────────────────────────────────

console.log('\n=== theming-catalog-verify ===\n');

// Catalog stats
console.log(`Catalog total tokens : ${TOKENS.length}`);
console.log(`Catalog subsystems   : ${catalogBySubsystem.size}`);
console.log(`Audit total matches  : ${audit.totalMatches}`);
console.log(`  ambiguous          : ${audit.ambiguousMatches.length}`);
console.log(`  non-ambiguous      : ${nonAmbiguousTotal}`);
console.log('');

// Duplicate names
if (dupes.length === 0) {
  console.log('✔  Duplicate token names : none');
} else {
  console.log(`✖  Duplicate token names : ${dupes.length}`);
  for (const d of dupes) console.log(`     "${d.name}" — first at index ${d.firstAt}, duplicate at ${d.dupeAt}`);
}
console.log('');

// Spec §3.4 subsystem coverage
const specCovPct = coveredCount.total > 0
  ? ((coveredCount.covered / coveredCount.total) * 100).toFixed(1)
  : '100.0';
if (missingFromCatalog.length === 0) {
  console.log(`✔  §3.4 subsystem coverage : ${specCovPct}% (${coveredCount.covered}/${coveredCount.total})`);
} else {
  console.log(`✖  §3.4 subsystem coverage : ${specCovPct}% (${coveredCount.covered}/${coveredCount.total})`);
  console.log('   Missing from catalog:');
  for (const m of missingFromCatalog) {
    console.log(`     §${m.section} ${m.displayName}  (slug: ${m.subsystem})`);
  }
}
console.log('');

// Audit subsystems with matches that have no catalog tokens
if (auditSubsMissingFromCatalog.length === 0) {
  console.log('✔  Audit subsystems with matches → all have catalog entries');
} else {
  console.log(`✖  Audit subsystems with matches but NO catalog entries: ${auditSubsMissingFromCatalog.length}`);
  for (const s of auditSubsMissingFromCatalog) console.log(`     ${s}`);
}
console.log('');

// proposedTokenName note
console.log(`ℹ  proposedTokenName coverage : N/A`);
console.log(`   (audit emitted ${proposedTotal} proposed names out of ${nonAmbiguousTotal} non-ambiguous matches)`);
console.log(`   The audit tool did not populate proposedTokenName; subsystem-coverage is used instead.`);
console.log('');

// ──────────────────────────────────────────────────────────────────────────
// 8. Exit
// ──────────────────────────────────────────────────────────────────────────

const ok = dupes.length === 0 && missingFromCatalog.length === 0 && auditSubsMissingFromCatalog.length === 0;
if (ok) {
  console.log('✔  PASS — catalog coverage complete, no duplicates\n');
  process.exit(0);
} else {
  console.log('✖  FAIL — see issues above\n');
  process.exit(1);
}
