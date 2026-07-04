// Electron main-process smoke test — end-to-end against the REAL app.
//
// ui/main.js is Electron's main process: it forks the engine worker
// (addon-worker.js under system Node), owns 323 `ipcMain.handle('xleth:…')`
// channels, a local media server, and settings/autosave persistence. It had
// ZERO test coverage. This suite is the baseline the ui/main.js decomposition
// (AUDIT.md S5) is graded against: if a refactor breaks boot, worker startup,
// or the IPC round-trip, one of these three tests fails loudly.
//
// It launches the actual Electron process (via Playwright's _electron helper —
// the same mechanism as tests/baseline) and drives the REAL preload/IPC/worker
// stack. Nothing in main.js is stubbed or mocked.
//
// What it proves:
//   1. The Electron app boots without throwing and loads the real UI.
//   2. The forked engine worker reaches "ready" (main.js only opens the main
//      window after `await startWorker()` resolves on the worker's
//      `{ ready: true }` message, and every engine handler is gated on that).
//   3. A real IPC round-trip completes: renderer → preload → ipcMain.handle →
//      callWorker → forked worker → native addon → back.
//
// The round-trip uses only read-only Timeline metadata queries
// (timeline.getBPM / timeline.getTempoLocked). These read the Timeline model
// and deliberately avoid every Phase 0 performance path (AUDIT.md §4: audio
// clock / A-V sync, GPU composite, proxy/seek). No perf-critical file is
// touched, invoked, or asserted against.
//
// Usage (see CONTRIBUTING.md → "Running the tests"):
//   cd ui
//   npm run build          # produces dist/index.html (loaded when XLETH_PLAYWRIGHT=1)
//   npm run test:smoke     # runs this suite

import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';

// preload.js injects window.xleth (contextIsolation is off). Declare just the
// read-only Timeline queries this smoke test uses.
declare global {
  interface Window {
    xleth: {
      timeline: {
        getBPM: () => Promise<number>;
        getTempoLocked: () => Promise<boolean>;
      };
    };
  }
}

const UI_DIR = path.resolve(__dirname, '../..');

// Cold start = fork system-Node worker + native addon init (~3 s) + timeline
// populate, before the main window is even created. Be generous.
const READY_TIMEOUT_MS = 60_000;

let app: ElectronApplication;
let mainWindow: Page;

/**
 * The app opens TWO BrowserWindows: a splash window (splash-preload.js, exposes
 * `window.splashIpc`) is created first, then — only after the engine worker
 * forks and reports ready — the main window (preload.js, exposes `window.xleth`).
 *
 * Playwright's `firstWindow()` is therefore unreliable here: it can return the
 * splash. We identify the main window by its preload surface (`window.xleth`),
 * which the splash never has. Reaching this window at all already implies the
 * worker became ready, because main.js's `createWindow()` runs after
 * `await startWorker()` in the `app.whenReady()` chain.
 */
async function findMainWindow(a: ElectronApplication, timeoutMs: number): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const w of a.windows()) {
      // evaluate() can throw while a window is navigating/closing (splash
      // teardown) — treat any failure as "not the main window yet".
      const hasXleth = await w
        .evaluate(() => typeof window.xleth === 'object' && window.xleth !== null)
        .catch(() => false);
      if (hasXleth) return w;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `Main window (a window exposing window.xleth) never appeared within ${timeoutMs}ms. ` +
    `The app failed to boot, or the engine worker never reached ready.`,
  );
}

/**
 * Poll a real getBPM IPC round-trip until it resolves, returning the value.
 * Engine-gated handlers reject with "Engine not ready" until the worker's
 * `{ ready: true }` message flips main.js's `workerReady` flag; the first
 * success is the observable proof that the gate opened.
 */
async function getBpmWhenReady(page: Page, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    const outcome = await page.evaluate(async () => {
      try {
        return { ok: true as const, value: await window.xleth.timeline.getBPM() };
      } catch (e) {
        return { ok: false as const, error: String((e as Error)?.message ?? e) };
      }
    });
    if (outcome.ok) return outcome.value as number;
    lastError = outcome.error;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `Engine round-trip (timeline.getBPM) never succeeded within ${timeoutMs}ms. ` +
    `Last error: ${lastError}`,
  );
}

test.beforeAll(async () => {
  // Fail fast (and clearly) rather than silently booting against a stale or
  // missing UI build — main.js loads dist/index.html when XLETH_PLAYWRIGHT=1.
  const distIndex = path.join(UI_DIR, 'dist', 'index.html');
  if (!fs.existsSync(distIndex)) {
    throw new Error(
      `dist/index.html not found — run "npm run build" in ui/ first.\nExpected: ${distIndex}`,
    );
  }

  app = await electron.launch({
    args: [path.join(UI_DIR, 'main.js')],
    cwd: UI_DIR,
    env: {
      ...process.env,
      // Load the built dist (offline) instead of the Vite dev server.
      XLETH_PLAYWRIGHT: '1',
      ELECTRON_ENABLE_LOGGING: '0',
    },
  });

  // Establishing the main window is part of "did it boot" — do it once here so
  // all three tests share the (expensive) launched instance.
  mainWindow = await findMainWindow(app, READY_TIMEOUT_MS);
});

test.afterAll(async () => {
  if (app) await app.close();
});

// ── 1. The app boots without throwing ────────────────────────────────────────

test('1. app boots: main process is live and the real UI window loaded', async () => {
  // app.evaluate runs in the Electron MAIN process — proves it is alive and did
  // not throw during startup.
  const version = await app.evaluate(({ app }) => app.getVersion());
  expect(typeof version).toBe('string');
  expect(version.length).toBeGreaterThan(0);

  // On a clean boot main.js loads dist/index.html. On engine-init failure it
  // instead loads a `data:text/html,…Addon error…` page (window.xleth is still
  // injected by preload, so this is the check that separates the two).
  const url = mainWindow.url();
  expect(url).toContain('index.html');
  expect(url).not.toContain('Addon');
});

// ── 2. The engine worker starts and reaches "ready" ──────────────────────────

test('2. engine worker reaches ready: a gated IPC call is served, not rejected', async () => {
  // Every engine handler passes through safeHandler + callWorker, both of which
  // throw "Engine not ready" until the forked worker sends { ready: true }. A
  // resolved round-trip is the faithful external signal that the worker is up.
  const bpm = await getBpmWhenReady(mainWindow, READY_TIMEOUT_MS);
  // It must be a real value, not the "Engine not ready" rejection path.
  expect(typeof bpm).toBe('number');
});

// ── 3. At least one real IPC round-trip succeeds ─────────────────────────────

test('3. IPC round-trip succeeds: read-only timeline queries return real payloads', async () => {
  // Full path exercised: renderer → preload invoke → ipcMain.handle →
  // callWorker → forked worker process → native addon → return value back.

  // getBPM: a valid tempo (not asserting an exact default — smoke, not golden).
  const bpm = await mainWindow.evaluate(() => window.xleth.timeline.getBPM());
  expect(Number.isFinite(bpm)).toBe(true);
  expect(bpm).toBeGreaterThan(0);
  expect(bpm).toBeLessThan(1000);

  // A second, independent read-only channel — proves it is not a one-channel
  // fluke and that non-numeric payloads round-trip too.
  const tempoLocked = await mainWindow.evaluate(() => window.xleth.timeline.getTempoLocked());
  expect(typeof tempoLocked).toBe('boolean');
});
