#!/usr/bin/env node
/*
 * test-flip-v2.js — Run the full flip-v2 test suite (Phases 1–6).
 *
 * Usage:   node scripts/test-flip-v2.js
 *          npm --prefix bridge run test:flip-v2
 *
 * The runner discovers compiled engine test executables under engine/build/**,
 * runs each, then runs the bridge IPC test (test_patterns.js). Failure of any
 * stage exits non-zero. Tests not yet built are reported with the exact CMake
 * command needed to produce them.
 *
 * Acceptance-criteria coverage table (xleth-flip-v2-architecture-spec.md §9):
 *
 *   #1  Legacy migration byte-identical    test_video_flip_resolver [18]
 *                                          test_timeline      [15]
 *                                          test_flip_determinism [3]
 *   #2  New tracks default to disabled     test_timeline      [15a]
 *                                          test_patterns         (ipc)
 *   #3  4 v1 modifiers resolve correctly   test_video_flip_resolver [2..8]
 *   #4  Acceptance #1–6 (Section 7)        test_video_flip_resolver [3,7,9,10,12,18]
 *   #5  Wrap is the only cycle behavior    structural — no other path exists
 *   #6  Chord events transparent           test_video_flip_applier [3..6]
 *                                          test_flip_determinism [2]
 *   #7  RT preview ≡ offline export        test_flip_determinism [1]
 *   #8  Re-export byte-identical           test_flip_determinism [1]
 *   #9  UI uses theme tokens only          manual / lint (Phase 5 panel)
 *   #10 Perf ≤10% over 1-state baseline    test_flip_determinism [5]
 *   #11 Insertion-stability documented     test_flip_determinism [4]
 *
 * Plus the GPU shader golden in test_flip_orientation_golden (6 orientations).
 */

const { spawnSync } = require('node:child_process');
const fs            = require('node:fs');
const path          = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// ─── Locate engine test executables ──────────────────────────────────────────
// Search the typical CMake build layouts first, then fall back to a recursive
// scan. We do NOT shell out to a `find` here so the runner stays cross-platform.
function findEngineTest(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const candidates = [
    path.join(ROOT, 'engine', 'build', exe),
    path.join(ROOT, 'engine', 'build', 'Release', exe),
    path.join(ROOT, 'engine', 'build', 'Debug', exe),
    path.join(ROOT, 'engine', 'build', 'RelWithDebInfo', exe),
    path.join(ROOT, 'engine', 'build', 'MinSizeRel', exe),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  // Fallback: walk engine/build looking for the executable.
  const buildRoot = path.join(ROOT, 'engine', 'build');
  if (!fs.existsSync(buildRoot)) return null;
  const stack = [buildRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && ent.name === exe) return full;
    }
  }
  return null;
}

function runExe(name, label) {
  const exe = findEngineTest(name);
  if (!exe) {
    console.error(`\n[flip-v2] SKIP — ${label}: ${name} not built`);
    console.error(`   Build with:   cmake --build engine/build --target ${name}`);
    return { name, label, status: 'skip' };
  }
  console.log(`\n[flip-v2] RUN — ${label}  (${path.relative(ROOT, exe)})`);
  console.log('─'.repeat(72));
  const res = spawnSync(exe, [], { stdio: 'inherit' });
  const ok = res.status === 0 && !res.error;
  return { name, label, status: ok ? 'pass' : 'fail', exit: res.status };
}

function runNode(file, label, cwd) {
  const abs = path.resolve(cwd, file);
  if (!fs.existsSync(abs)) {
    console.error(`\n[flip-v2] SKIP — ${label}: ${path.relative(ROOT, abs)} not present`);
    return { name: file, label, status: 'skip' };
  }
  console.log(`\n[flip-v2] RUN — ${label}  (${path.relative(ROOT, abs)})`);
  console.log('─'.repeat(72));
  const res = spawnSync(process.execPath, [abs], { stdio: 'inherit', cwd });
  const ok = res.status === 0 && !res.error;
  return { name: file, label, status: ok ? 'pass' : 'fail', exit: res.status };
}

// ─── Suite ──────────────────────────────────────────────────────────────────

const tests = [
  // Phase 1 — types + migration round-trip
  { kind: 'exe',  name: 'test_timeline',                 label: 'Phase 1: timeline + migration JSON round-trip' },
  // Phase 2 — pure resolver + acceptance #1–5 + Phase 4 acceptance #6 + 6-orientation golden CPU mirror
  { kind: 'exe',  name: 'test_video_flip_resolver',      label: 'Phase 2/4: resolver + acceptance #1–6 + UV-golden' },
  // Phase 3 — VideoFlipApplier (chord detection + state inheritance + multi-track)
  { kind: 'exe',  name: 'test_video_flip_applier',       label: 'Phase 3: applier + chord transparency' },
  // Phase 4 — GPU shader golden (real D3D11 readback for each orientation)
  { kind: 'exe',  name: 'test_flip_orientation_golden',  label: 'Phase 4: GPU shader golden (6 orientations)' },
  // Phase 6 — determinism, end-to-end migration, insertion-stability, perf
  { kind: 'exe',  name: 'test_flip_determinism',         label: 'Phase 6: determinism + insertion + perf' },
  // Bridge — IPC round-trip for setVideoFlipConfig (all 4 modifiers)
  { kind: 'node', file: 'test_patterns.js', cwd: path.join(ROOT, 'bridge'),
                                                          label: 'Bridge: setVideoFlipConfig IPC round-trip' },
];

const results = [];
for (const t of tests) {
  if (t.kind === 'exe')       results.push(runExe(t.name, t.label));
  else if (t.kind === 'node') results.push(runNode(t.file, t.label, t.cwd));
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(72));
console.log('Flip v2 — Phase 6 Suite Summary');
console.log('═'.repeat(72));

const w = Math.max(...results.map(r => r.label.length));
let passed = 0, failed = 0, skipped = 0;
for (const r of results) {
  const tag =
    r.status === 'pass' ? 'PASS' :
    r.status === 'fail' ? 'FAIL' : 'SKIP';
  console.log(`  ${tag.padEnd(4)}  ${r.label.padEnd(w)}  (${r.name})`);
  if (r.status === 'pass') ++passed;
  else if (r.status === 'fail') ++failed;
  else ++skipped;
}

console.log('─'.repeat(72));
console.log(`  ${passed} passed, ${failed} failed, ${skipped} skipped`);

if (skipped > 0) {
  console.log('\nTo build all engine tests at once:');
  console.log('  cmake -B engine/build -S engine');
  console.log('  cmake --build engine/build --target test_timeline test_video_flip_resolver \\');
  console.log('     test_video_flip_applier test_flip_determinism test_flip_orientation_golden');
}

process.exit(failed > 0 ? 1 : 0);
