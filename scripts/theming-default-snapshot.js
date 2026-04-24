#!/usr/bin/env node
'use strict';

// theming-default-snapshot.js — Phase 0 Track B Step 8 verification.
//
// Purpose:
//   1. Load the shipped Xleth Default theme file.
//   2. Resolve it through the full applyTheme.ts pipeline.
//   3. Pretty-print the resolved token map and compare key tokens
//      byte-identically against the hand-picked values in
//      ui/src/styles/theme.css. Flags any mismatch as a failure.
//   4. Simulate a Simple-mode accent swap (accent=#FF4AE3 "hot pink")
//      and report the cascaded accent-hover and focus-ring values.
//
// Exit 0 on success, 1 on any anchor mismatch.

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const uiRoot = path.resolve(__dirname, '../ui');
const tmpDir = path.resolve(uiRoot, 'node_modules/.theming-verify-cache');
const entry  = path.resolve(uiRoot, 'src/theming/runtime/applyTheme.ts');
const out    = path.join(tmpDir, 'applyTheme.bundle.cjs');

fs.mkdirSync(tmpDir, { recursive: true });

// Bundle applyTheme + its imports into a single CJS file we can require().
// The DOM write (writeThemeToRoot) is exported but not invoked here, so no
// `document` shim is needed.
execSync(
  `node -e "require('esbuild').buildSync({entryPoints:['${entry.replace(/\\/g, '/')}'],bundle:true,format:'cjs',outfile:'${out.replace(/\\/g, '/')}',platform:'node',external:[]})"`,
  { cwd: uiRoot, stdio: 'pipe' }
);

const { resolveTheme } = require(out);

const defaultTheme = JSON.parse(fs.readFileSync(
  path.resolve(uiRoot, 'src/theming/shipped/xleth-default.json'), 'utf8'));

// ──────────────────────────────────────────────────────────────────────────
// Part 1 — resolve Default and compare to theme.css anchors byte-identically.
// ──────────────────────────────────────────────────────────────────────────

const resolved = resolveTheme(defaultTheme);

// Anchors from ui/src/styles/theme.css. Map: catalog-token → legacy literal.
const ANCHORS = {
  '--theme-bg-primary':       '#0A0A0F',
  '--theme-bg-surface':       '#1A1A24',
  '--theme-bg-secondary':     '#111118',
  '--theme-bg-elevated':      '#222230',
  '--theme-border-subtle':    '#2A2A38',
  '--theme-accent':           '#33CED6',
  '--theme-accent-hover':     '#2BB8BF',
  '--theme-text':             '#E8E8ED',
  '--theme-text-muted':       '#8888A0',
  '--theme-text-subtle':      '#555566',
  '--theme-text-placeholder': '#555566',
  '--theme-danger':           '#FF4757',
  '--theme-warning':          '#FFAA33',
  '--theme-success':          '#22C55E',
  '--theme-focus-ring':       'rgba(51, 206, 214, 0.15)',
};

console.log('\n=== Default snapshot — resolved vs theme.css anchors ===\n');
console.log('Token                               Resolved                       Anchor                         Match');
console.log('──────────────────────────────────  ─────────────────────────────  ─────────────────────────────  ─────');

let fails = 0;
for (const [name, anchor] of Object.entries(ANCHORS)) {
  const got = resolved.values[name];
  const ok  = got === anchor;
  if (!ok) fails++;
  console.log(`${name.padEnd(36)}  ${String(got).padEnd(29)}  ${anchor.padEnd(29)}  ${ok ? '✓' : '✗'}`);
}

console.log('');
if (fails === 0) {
  console.log('✔  All anchors match byte-identically.\n');
} else {
  console.log(`✖  ${fails} anchor mismatch(es).\n`);
}

// ──────────────────────────────────────────────────────────────────────────
// Part 2 — hot-pink cascade: accent=#FF4AE3, rest of base unchanged.
// ──────────────────────────────────────────────────────────────────────────

const hotPink = JSON.parse(JSON.stringify(defaultTheme));
hotPink.name = 'Xleth Hot-Pink Cascade Test';
hotPink.derivationDetached = [];
hotPink.tokens = {
  ...defaultTheme.tokens,
  '--theme-accent': '#FF4AE3',
};

const swapped = resolveTheme(hotPink);

console.log('=== Hot-pink cascade — accent swapped to #FF4AE3 ===\n');
console.log(`--theme-accent          : ${swapped.values['--theme-accent']}`);
console.log(`--theme-accent-hover    : ${swapped.values['--theme-accent-hover']}   (tuned: dL=-6.08, dS=-3.28)`);
console.log(`--theme-accent-active   : ${swapped.values['--theme-accent-active']}`);
console.log(`--theme-focus-ring      : ${swapped.values['--theme-focus-ring']}  (tuned: accent @15% alpha)`);
console.log(`--theme-border-focus    : ${swapped.values['--theme-border-focus']}`);
console.log(`--theme-info            : ${swapped.values['--theme-info']}`);
console.log(`--theme-panel-timeline  : ${swapped.values['--theme-panel-timeline']}  (+60°)`);
console.log(`--theme-panel-pianoroll : ${swapped.values['--theme-panel-pianoroll']}  (+120°)`);
console.log(`--theme-panel-preview   : ${swapped.values['--theme-panel-preview']}  (+180°)`);
console.log('');
console.log(`Static (unchanged by accent swap):`);
console.log(`--theme-warning         : ${swapped.values['--theme-warning']}`);
console.log(`--theme-success         : ${swapped.values['--theme-success']}`);
console.log(`--theme-text-muted      : ${swapped.values['--theme-text-muted']}`);
console.log('');

process.exit(fails === 0 ? 0 : 1);
