'use strict';
//
// bridge/run_contract_tests.js — runs every test_*.js contract script in this
// directory sequentially (each in its own node process, since each script
// loads its own instance of xleth_native.node), then the compiled
// test_export_naming.exe (built by bridge/CMakeLists.txt alongside the addon).
//
// Invoked by `npm test`.
//
// Every test lands in exactly one bucket and the three are reported apart:
//   PASS  exit 0 and the script did not announce a skip
//   FAIL  non-zero exit, crash, or per-test timeout
//   SKIP  the script exited 0 saying it skipped, OR (only with
//         XLETH_CI_NO_AUDIO=1) it failed with the engine's "no audio device"
//         error. A skip is never a pass: it is counted and reasoned separately.
//
// The exit code is non-zero iff a FAIL is not listed in known-failures.json.
// Listed failures are reported as KNOWN, not hidden. A listed test that now
// passes is reported so its entry can be deleted. A `flaky` entry is retried
// once and reported as flaky if the retry passes.
//
//   node run_contract_tests.js [--timeout=SECONDS] [--only=SUBSTRING] [--dir=PATH]
//   env: XLETH_TEST_TIMEOUT_S (default 120), XLETH_CI_NO_AUDIO, CI
//   (--dir is for run_contract_tests.selftest.js: scripts + known-failures.json elsewhere)
//

const { spawn, spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const arg = (name) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const DIR        = arg('dir') ? path.resolve(arg('dir')) : __dirname;
const TIMEOUT_S  = Number(arg('timeout') ?? process.env.XLETH_TEST_TIMEOUT_S ?? 120);
const ONLY       = arg('only');
const NO_AUDIO_OK = process.env.XLETH_CI_NO_AUDIO === '1';
const IN_CI      = !!process.env.CI;
const OUTPUT_CAP = 1 << 20; // keep the last 1 MB of each test's output for classification

// Whole-script skips. Partial skips inside a passing script ("SKIP  live
// section") are not matched here; they are only counted as a note.
const SKIP_RE     = /SKIPPING|\[SKIP\]|\(skipped\)/;
const SKIP_LINE   = /^\s*(\[SKIP\]|SKIP\b)/gm;
// initialize() only fails when no audio device could be opened
// (XlethEngineService.cpp: "AudioEngine::initialize() failed").
const NO_DEVICE_RE = /AudioEngine::initialize\(\) failed/;

if (!Number.isFinite(TIMEOUT_S) || TIMEOUT_S <= 0) {
  console.error(`bad timeout: ${TIMEOUT_S}`);
  process.exit(2);
}

// ── known-failures.json ──────────────────────────────────────────────────────
function loadKnown() {
  const file = path.join(DIR, 'known-failures.json');
  if (!fs.existsSync(file)) return new Map();
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  const map = new Map();
  for (const e of entries) {
    if (!e.test || !e.reason || !/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) {
      console.error(`known-failures.json: every entry needs test, reason and date (YYYY-MM-DD): ${JSON.stringify(e)}`);
      process.exit(2);
    }
    map.set(e.test, e);
  }
  return map;
}

// ── one child process: tee output, kill the whole tree on timeout ───────────
function runChild(command, args) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '';
    let timedOut = false;
    let done = false;
    const child = spawn(command, args, { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    const take = (stream, sink) => stream.on('data', (d) => {
      sink.write(d);
      out = (out + d.toString('utf8')).slice(-OUTPUT_CAP);
    });
    take(child.stdout, process.stdout);
    take(child.stderr, process.stderr);

    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, timedOut, out, ms: Date.now() - t0 });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      // A test can spawn ffmpeg etc.; killing only the parent would leave the pipes open.
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      else child.kill('SIGKILL');
      setTimeout(() => finish(null), 5000); // do not wait forever for the pipes to close
    }, TIMEOUT_S * 1000);

    child.on('error', () => finish(1));
    child.on('close', (code) => finish(code === null ? 1 : code)); // null = crashed/killed
  });
}

function classify(r) {
  if (r.timedOut) return { status: 'FAIL', note: `timed out after ${TIMEOUT_S}s` };
  if (r.code === 0) {
    if (SKIP_RE.test(r.out)) return { status: 'SKIP', reason: skipReason(r.out) };
    const partial = (r.out.match(SKIP_LINE) || []).length;
    return { status: 'PASS', note: partial ? `${partial} skip line(s) inside the script` : '' };
  }
  if (NO_AUDIO_OK && NO_DEVICE_RE.test(r.out)) {
    return { status: 'SKIP', reason: 'no audio device' };
  }
  return { status: 'FAIL', note: `exit ${r.code}` };
}

function skipReason(out) {
  if (/audio device|engine init(ialize)? failed|initialize\(\) (threw|failed)/i.test(out)) return 'no audio device';
  if (/GPU|D3D11/.test(out)) return 'no GPU';
  if (/ffmpeg/i.test(out)) return 'no ffmpeg';
  return 'other';
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  const known = loadKnown();
  const names = fs.readdirSync(DIR).filter((f) => /^test_.*\.js$/.test(f)).sort();
  const jobs = names
    .map((f) => ({ name: f.replace(/\.js$/, ''), command: process.execPath, args: [path.join(DIR, f)] }));

  // C++ export-naming unit test — built by the bridge cmake-js build, not part
  // of the engine CTest targets. (Skipped under --dir: the selftest has no build.)
  const exe = path.join(DIR, 'build', 'Release',
    process.platform === 'win32' ? 'test_export_naming.exe' : 'test_export_naming');
  if (DIR === __dirname) {
    if (fs.existsSync(exe)) jobs.push({ name: 'test_export_naming', command: exe, args: [] });
    else jobs.push({ name: 'test_export_naming', missing: exe });
  }

  const results = [];
  for (const job of jobs.filter((j) => !ONLY || j.name.includes(ONLY))) {
    console.log(`\n=== ${job.name} ===`);
    let res;
    if (job.missing) {
      // Skipped locally (not built yet), a hard failure in CI where it must exist.
      console.log(`${IN_CI ? 'FAILED' : 'SKIPPED'} — not built (${job.missing} missing)`);
      res = IN_CI ? { status: 'FAIL', note: 'not built' } : { status: 'SKIP', reason: 'not built' };
      res.ms = 0;
    } else {
      const entry = known.get(job.name);
      let r = await runChild(job.command, job.args);
      res = classify(r);
      res.ms = r.ms;
      if (res.status === 'FAIL' && entry && entry.flaky) {
        console.log(`\n--- ${job.name} failed and is listed as flaky: retrying once ---`);
        r = await runChild(job.command, job.args);
        const retry = classify(r);
        res.ms += r.ms;
        if (retry.status !== 'FAIL') { Object.assign(res, retry, { flakyRecovered: true }); }
      }
    }
    res.name = job.name;
    res.known = known.get(job.name);
    results.push(res);
    console.log(`--- ${res.status}${res.flakyRecovered ? ' (flaky: passed on retry)' : ''} ${job.name} ${(res.ms / 1000).toFixed(1)}s`);
  }

  // ── summary ────────────────────────────────────────────────────────────────
  const of = (s) => results.filter((r) => r.status === s);
  const pass = of('PASS'), skip = of('SKIP'), fail = of('FAIL');
  const newFail   = fail.filter((r) => !r.known);
  const knownFail = fail.filter((r) => r.known);
  const flaky     = pass.filter((r) => r.flakyRecovered);
  // Listed, non-flaky, ran, and passed: the entry is stale.
  const stale = pass.filter((r) => r.known && !r.known.flaky);
  const ranNames = new Set(jobs.map((j) => j.name));
  const orphan = [...known.keys()].filter((k) => !ranNames.has(k));
  const skipByReason = {};
  for (const r of skip) skipByReason[r.reason] = (skipByReason[r.reason] || 0) + 1;

  const L = [];
  L.push('', '──────────────────────────────────────────');
  for (const r of results) {
    const tag = r.status === 'FAIL' ? (r.known ? 'KNOWN-FAIL' : 'FAIL') : r.status;
    const why = r.status === 'SKIP' ? ` (${r.reason})` : r.known && r.status === 'FAIL' ? ` (known since ${r.known.date}: ${r.known.reason})` : '';
    L.push(`${tag.padEnd(10)} ${r.name}${why}${r.note ? ` [${r.note}]` : ''}`);
  }
  L.push('');
  L.push(`${results.length} bridge tests: ${pass.length} passed, ${fail.length} failed (${newFail.length} NEW, ${knownFail.length} known), ${skip.length} SKIPPED`);
  if (skip.length) {
    L.push(`  skipped by reason: ${Object.entries(skipByReason).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  }
  if (flaky.length) L.push(`  flaky (failed, then passed on retry): ${flaky.map((r) => r.name).join(', ')}`);
  for (const r of stale) {
    L.push(`  ALLOWLIST STALE: ${r.name} now PASSES — remove it from bridge/known-failures.json`);
  }
  for (const k of orphan) {
    if (!ONLY) L.push(`  ALLOWLIST ORPHAN: ${k} is listed but no such test ran — remove or fix the entry`);
  }
  if (skipByReason['no audio device']) {
    L.push('', `!!! ${skipByReason['no audio device']} of ${results.length} bridge tests SKIPPED: no audio device. They proved NOTHING on this machine. !!!`);
  }
  if (newFail.length) {
    L.push('', `NEW FAILURES (not in known-failures.json): ${newFail.map((r) => r.name).join(', ')}`);
  }
  const text = L.join('\n');
  console.log(text);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [
      '### Bridge contract tests',
      '',
      `| passed | failed (new) | failed (known) | skipped |`,
      `|---|---|---|---|`,
      `| ${pass.length} | ${newFail.length} | ${knownFail.length} | ${skip.length} |`,
      '',
    ];
    if (skipByReason['no audio device']) {
      md.push(`> **${skipByReason['no audio device']} of ${results.length} bridge tests skipped: no audio device.** They proved nothing on this runner.`, '');
    }
    if (newFail.length) md.push(`**New failures:** ${newFail.map((r) => `\`${r.name}\``).join(', ')}`, '');
    if (stale.length) md.push(`**Allowlist stale (now passing, remove):** ${stale.map((r) => `\`${r.name}\``).join(', ')}`, '');
    if (flaky.length) md.push(`**Flaky:** ${flaky.map((r) => `\`${r.name}\``).join(', ')}`, '');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n') + '\n');
  }
  if (process.env.GITHUB_ACTIONS) {
    for (const r of stale) console.log(`::warning title=known-failures.json::${r.name} now passes; remove its entry`);
    for (const r of newFail) console.log(`::error title=Bridge test failed::${r.name} ${r.note || ''}`);
  }

  process.exit(newFail.length === 0 ? 0 : 1);
})();
