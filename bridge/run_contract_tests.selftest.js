'use strict';
//
// bridge/run_contract_tests.selftest.js — checks the runner's own bookkeeping
// (buckets, allowlist, stale entry, flaky retry, timeout, no-device skip) with
// fake test scripts in a temp dir. Needs no addon and no audio device.
//   node run_contract_tests.selftest.js
//

const { spawnSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const assert = require('assert');

const RUNNER = path.join(__dirname, 'run_contract_tests.js');

const FAKES = {
  test_ok:        'process.exit(0)',
  test_new_red:   'process.exit(1)',
  test_known_red: 'process.exit(1)',
  test_stale:     'process.exit(0)',
  test_skip:      'console.log("SKIPPING - this test needs an audio device."); process.exit(0)',
  test_nodev:     'console.error(new Error("AudioEngine::initialize() failed — no audio device?")); process.exit(1)',
  test_hang:      'setInterval(() => {}, 1000)',
  // fails the first time it ever runs, passes afterwards
  test_flaky:     'const f = require("path").join(__dirname, ".flaky-seen"), fs = require("fs");' +
                  'if (fs.existsSync(f)) process.exit(0); fs.writeFileSync(f, "1"); process.exit(1)',
};

function run(files, known, { env = {}, args = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xleth-runner-selftest-'));
  for (const f of files) fs.writeFileSync(path.join(dir, `${f}.js`), FAKES[f]);
  if (known) fs.writeFileSync(path.join(dir, 'known-failures.json'), JSON.stringify(known));
  const r = spawnSync(process.execPath, [RUNNER, `--dir=${dir}`, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CI: '', GITHUB_STEP_SUMMARY: '', GITHUB_ACTIONS: '', XLETH_CI_NO_AUDIO: '', ...env },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out: r.stdout + r.stderr };
}
const entry = (test, extra = {}) => ({ test, reason: 'selftest', date: '2026-11-20', ...extra });
let n = 0;
const check = (cond, label) => { assert.ok(cond, label); n += 1; console.log(`  ok  ${label}`); };

// 1. known red, stale entry, flaky retry, skip: all non-blocking, all reported
let r = run(['test_ok', 'test_known_red', 'test_stale', 'test_flaky', 'test_skip'],
  [entry('test_known_red'), entry('test_stale'), entry('test_flaky', { flaky: true })]);
check(r.code === 0, 'known red + flaky + skip does not fail the run');
check(/KNOWN-FAIL test_known_red/.test(r.out), 'known failure is listed, not hidden');
check(/ALLOWLIST STALE: test_stale now PASSES/.test(r.out), 'allowlisted test that passes is reported');
check(/flaky \(failed, then passed on retry\): test_flaky/.test(r.out), 'flaky test is retried once and reported');
check(/5 bridge tests: 3 passed, 1 failed \(0 NEW, 1 known\), 1 SKIPPED/.test(r.out), 'pass / fail / skip counted separately; skip is not a pass');
check(/1 of 5 bridge tests SKIPPED: no audio device/.test(r.out), 'audio-device skip is announced loudly');

// 2. a failure not in the allowlist fails the run
r = run(['test_ok', 'test_new_red'], [entry('test_known_red')]);
check(r.code === 1 && /NEW FAILURES.*test_new_red/.test(r.out), 'new red exits non-zero');

// 3. per-test timeout
r = run(['test_hang'], null, { args: ['--timeout=2'] });
check(r.code === 1 && /timed out after 2s/.test(r.out), 'hung test is killed and fails');

// 4. "no audio device" failure is a skip only when CI opts in
r = run(['test_nodev'], null);
check(r.code === 1, 'init failure is a FAIL by default (a dev box has a device)');
r = run(['test_nodev'], null, { env: { XLETH_CI_NO_AUDIO: '1' } });
check(r.code === 0 && /1 SKIPPED/.test(r.out) && /0 passed/.test(r.out), 'init failure is a SKIP with XLETH_CI_NO_AUDIO=1, never a pass');

// 5. malformed allowlist entry is a config error
r = run(['test_ok'], [{ test: 'test_ok', reason: 'no date' }]);
check(r.code === 2, 'allowlist entry without a date is rejected');

console.log(`\n${n} runner self-checks passed`);
