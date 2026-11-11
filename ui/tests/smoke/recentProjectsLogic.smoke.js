'use strict';

// Console smoke test for recentProjectsLogic.js — the recent-projects list
// transforms (dedupe, MRU-bump, cap, missing detection) that back the
// Welcome screen's recents rail. No Electron dependency, so this runs under
// plain node:
//
//   node ui/tests/smoke/recentProjectsLogic.smoke.js
//
// Covers Welcome screen verification criteria (c) MRU bump on reopen,
// (d) deleted project.json renders MISSING, (e) an 11th distinct project
// evicts the oldest.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const logic = require('../../electron-main/recentProjectsLogic');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}

// ── fixture: real temp dirs so projectFileExists() checks real fs state ─────
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xleth-recents-smoke-'));
function makeProjectDir(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), '{}');
  return dir;
}

console.log('recentProjectsLogic smoke test\n');

// ── normalizeDir: case-insensitive, trailing-slash-insensitive ─────────────
check('normalizeDir is case-insensitive', () => {
  const a = logic.normalizeDir('C:\\Users\\Example\\Proj');
  const b = logic.normalizeDir('c:\\users\\example\\proj');
  assert.strictEqual(a, b);
});
check('normalizeDir strips a trailing slash', () => {
  const a = logic.normalizeDir('C:\\Users\\Example\\Proj');
  const b = logic.normalizeDir('C:\\Users\\Example\\Proj\\');
  assert.strictEqual(a, b);
});

// ── withTouched: dedupe by normalized dir + MRU bump ────────────────────────
check('withTouched puts a new entry at the front', () => {
  const list = logic.withTouched([], { dir: 'C:\\A', name: 'A' });
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].dir, 'C:\\A');
});
check('withTouched dedupes by normalized dir and bumps to MRU (criterion c)', () => {
  let list = logic.withTouched([], { dir: 'C:\\A', name: 'A' });
  list = logic.withTouched(list, { dir: 'C:\\B', name: 'B' });
  list = logic.withTouched(list, { dir: 'c:\\a', name: 'A (reopened)' }); // same dir, different case
  assert.strictEqual(list.length, 2, 'reopening an existing dir must not grow the list');
  assert.strictEqual(list[0].dir, 'c:\\a', 'the reopened entry must be at the front');
  assert.strictEqual(list[1].dir, 'C:\\B');
});
check('withTouched caps at MAX_RECENTS and evicts the oldest (criterion e)', () => {
  let list = [];
  for (let i = 1; i <= 10; i++) {
    list = logic.withTouched(list, { dir: `C:\\Proj${i}`, name: `Proj${i}` });
  }
  assert.strictEqual(list.length, 10);
  assert.strictEqual(list[list.length - 1].dir, 'C:\\Proj1', 'oldest of the first 10 should be last');

  // 11th distinct project pushes the oldest (Proj1) out entirely.
  list = logic.withTouched(list, { dir: 'C:\\Proj11', name: 'Proj11' });
  assert.strictEqual(list.length, 10, 'list must stay capped at 10');
  assert.strictEqual(list[0].dir, 'C:\\Proj11');
  assert.ok(!list.some((r) => r.dir === 'C:\\Proj1'), 'Proj1 (the 11th-oldest) must have been evicted');
  assert.ok(list.some((r) => r.dir === 'C:\\Proj2'), 'Proj2 should still be present');
});

// ── withRemoved ──────────────────────────────────────────────────────────────
check('withRemoved drops only the matching (normalized) entry', () => {
  let list = logic.withTouched([], { dir: 'C:\\A', name: 'A' });
  list = logic.withTouched(list, { dir: 'C:\\B', name: 'B' });
  list = logic.withRemoved(list, 'c:\\a');
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].dir, 'C:\\B');
});

// ── withStatus / firstValid: MISSING detection (criterion d) ────────────────
check('withStatus reports exists=true for a dir with project.json', () => {
  const dir = makeProjectDir('exists-1');
  const [entry] = logic.withStatus([{ dir, name: 'exists-1' }]);
  assert.strictEqual(entry.exists, true);
});
check('withStatus reports exists=false (MISSING) once project.json is deleted', () => {
  const dir = makeProjectDir('will-be-deleted');
  let [entry] = logic.withStatus([{ dir, name: 'will-be-deleted' }]);
  assert.strictEqual(entry.exists, true, 'sanity: starts as existing');

  fs.rmSync(dir, { recursive: true, force: true });
  [entry] = logic.withStatus([{ dir, name: 'will-be-deleted' }]);
  assert.strictEqual(entry.exists, false, 'must flip to MISSING once the folder is gone');
});
check('withStatus reports exists=false when the folder survives but project.json does not', () => {
  const dir = makeProjectDir('project-json-deleted');
  fs.rmSync(path.join(dir, 'project.json'));
  const [entry] = logic.withStatus([{ dir, name: 'project-json-deleted' }]);
  assert.strictEqual(entry.exists, false, 'a surviving folder with no project.json must still read MISSING');
});
check('firstValid skips MISSING entries and returns the first real one', () => {
  const missingDir = path.join(root, 'never-created');
  const validDir = makeProjectDir('first-valid-target');
  const list = [{ dir: missingDir, name: 'gone' }, { dir: validDir, name: 'first-valid-target' }];
  const found = logic.firstValid(list);
  assert.ok(found, 'firstValid must find the second (valid) entry');
  assert.strictEqual(found.dir, validDir);
});
check('firstValid returns null when every entry is MISSING', () => {
  const list = [{ dir: path.join(root, 'ghost-1'), name: 'g1' }, { dir: path.join(root, 'ghost-2'), name: 'g2' }];
  assert.strictEqual(logic.firstValid(list), null);
});

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
