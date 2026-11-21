import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Regression guard for the 1.2.1 "stuck on the splash screen" bug ──────────
// addon-worker.js runs from resources/worker/ in the packaged app, forked
// under the vendored node.exe — OUTSIDE app.asar. It is copied there by an
// explicit electron-builder `extraResources` entry, one per file, so any
// sibling module it starts requiring must get its own entry too. In 1.2.1 it
// grew `require('./worker-dispatch-priority.js')` and that entry was never
// added: the packaged worker threw at load, never wired process.on('message'),
// never sent { ready: true }, and — because the open IPC channel held its
// event loop alive — never exited either. startWorker()'s Promise therefore
// settled neither way and the splash sat at "Starting…" forever.
//
// This test fails the moment a new local require appears without its shipping
// entry, which is the only part of that failure chain that is cheap to catch
// before a build lands on users.

const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workerEntry = 'addon-worker.js';

function localRequires(source) {
  // Only relative requires matter: bare specifiers are node builtins here, and
  // the addon itself is resolved at runtime from XLETH_BRIDGE_DIR.
  return [...source.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)].map((m) => m[1]);
}

function packagedWorkerFiles() {
  const cfg = JSON.parse(
    fs.readFileSync(path.join(uiDir, 'electron-builder.json'), 'utf8'),
  );
  return (cfg.extraResources || [])
    .filter((e) => e && typeof e.to === 'string' && e.to.startsWith('worker/'))
    .map((e) => ({ from: e.from, to: e.to.slice('worker/'.length) }));
}

describe('packaged engine-worker resources', () => {
  const shipped = packagedWorkerFiles();

  it('ships addon-worker.js itself', () => {
    expect(shipped.map((f) => f.to)).toContain(workerEntry);
  });

  it('ships every module addon-worker.js requires relatively', () => {
    const source = fs.readFileSync(path.join(uiDir, workerEntry), 'utf8');
    const required = localRequires(source);

    // The require list is the point of the test — if it ever reads empty the
    // regex has drifted and the assertion below would pass vacuously.
    expect(required.length).toBeGreaterThan(0);

    const shippedNames = new Set(shipped.map((f) => f.to));
    const missing = required.filter(
      (spec) => !shippedNames.has(path.posix.normalize(spec)),
    );

    expect(
      missing,
      `addon-worker.js requires ${missing.join(', ')}, but electron-builder.json ` +
        `has no extraResources entry copying it to worker/. The packaged worker ` +
        `would throw at load and hang the app on the splash screen.`,
    ).toEqual([]);
  });

  it('has a real source file behind every shipped worker resource', () => {
    for (const { from, to } of shipped) {
      expect(fs.existsSync(path.join(uiDir, from)), `${from} -> worker/${to}`).toBe(true);
    }
  });
});
