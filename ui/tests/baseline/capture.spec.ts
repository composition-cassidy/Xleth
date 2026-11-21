// Electron baseline capture (Phase 8: rewritten for the docked shell).
//
// Launches the built Electron app (XLETH_PLAYWRIGHT=1 -> dist/index.html) WITH THE ENGINE and
// photographs the real layout: the shell, the detail-dock tabs, the Inspector, the Preview's
// Edit Grid row, a device chain, the mixer, the Browser, the sample-picker sheet and each shipped
// theme. The render harness (`npm run shots`) covers chrome without the engine; this suite is the
// one that needs xleth_native.node, so it is run by hand on a machine that has it.
//
// Usage (from ui/):
//   npm run baseline:build      build dist/ first (the suite refuses to run against the Vite dev server)
//   npm run baseline:capture    FIRST run, or after an intended visual change: writes the snapshots
//   npm run baseline:check      diffs against the committed snapshots (no update)
//   npm run baseline            build + capture + check
//
// Prerequisites: bridge/build/Release/xleth_native.node is newer than the latest engine/bridge commit
// and sits beside its runtime DLLs (see MANUAL.md). Close any running XLETH first: the worker locks the
// .node. Shots that need media or a pattern the fixture does not contain are SKIPPED, not faked; MANUAL.md
// lists them and how to take them by hand.
//
// Non-determinism mitigations: CSS animation/transition frozen, window fixed, transport stopped at 0,
// every shot waits for its canvases to stop changing, and meters are only photographed asleep (no playback).

import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

let app: ElectronApplication;
let page: Page;

const UI_DIR = path.resolve(__dirname, '../..');
const FIXTURE_SRC = path.resolve(__dirname, '..', 'fixture');
let FIXTURE_DIR = '';
let fixtureLoaded = false;

const THEMES = ['xleth-default', 'light', 'warm', 'cool', 'high-contrast'] as const;
// The detail dock's tabs, by panel id (windowing/registry/panelCatalog.ts, dockTabOrder).
const DOCK_TABS = [
  { id: 'devices', shot: '10-dock-devices' },
  { id: 'mixer', shot: '11-dock-mixer' },
  { id: 'pianoRoll', shot: '12-dock-piano-roll' },
  { id: 'sampler', shot: '13-dock-sampler' },
  { id: 'fxGraph', shot: '14-dock-fx-graph' },
] as const;

const FREEZE_CSS = `
  *, *::before, *::after {
    animation-play-state: paused !important;
    animation-duration: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
`;

// Injected through evaluate, not addStyleTag: the fontsource data-URI fonts trip Playwright's CSP check.
async function freezeAnimations(p: Page): Promise<void> {
  await p.evaluate((css) => {
    if (document.getElementById('__xleth_freeze__')) return;
    const s = document.createElement('style');
    s.id = '__xleth_freeze__';
    s.textContent = css;
    document.head.appendChild(s);
  }, FREEZE_CSS);
}

async function waitForShell(): Promise<void> {
  await page.waitForSelector('[data-testid="xleth-windowing-shell"]', { timeout: 30_000 });
  await page.waitForSelector('[data-testid="xleth-detail-dock"]', { timeout: 30_000 });
  await freezeAnimations(page);
  await page.waitForTimeout(1500);
}

test.beforeAll(async () => {
  const distIndex = path.join(UI_DIR, 'dist', 'index.html');
  if (!fs.existsSync(distIndex)) {
    throw new Error(`dist/index.html not found. Run "npm run baseline:build" first.\nExpected: ${distIndex}`);
  }
  app = await electron.launch({
    args: [path.join(UI_DIR, 'main.js')],
    cwd: UI_DIR,
    env: { ...process.env, XLETH_PLAYWRIGHT: '1', ELECTRON_ENABLE_LOGGING: '0' },
  });
  page = await app.firstWindow();
  await waitForShell();
});

test.afterAll(async () => {
  await app.close();
  if (FIXTURE_DIR && fs.existsSync(FIXTURE_DIR)) {
    try { fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// Leave every test with no dialog, menu or sheet open.
test.afterEach(async () => {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(150);
  await freezeAnimations(page).catch(() => {});
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Wait until every canvas stops changing (pixel-stable for one 300 ms step). */
async function waitForCanvasStable(timeout = 8000): Promise<void> {
  const start = Date.now();
  let prev = '';
  while (Date.now() - start < timeout) {
    const hash = await page.evaluate(() => Array.from(document.querySelectorAll('canvas')).map((c) => {
      try {
        const ctx = c.getContext('2d');
        if (!ctx) return '';
        const d = ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
        return `${c.width}x${c.height}:${d[0]},${d[1]},${d[2]}`;
      } catch { return ''; }
    }).join('|'));
    if (hash === prev && hash !== '') return;
    prev = hash;
    await page.waitForTimeout(300);
  }
}

/** Load the fixture project into the engine once; later tests share the loaded state. */
async function loadFixture(): Promise<void> {
  if (fixtureLoaded) return;
  FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xleth-fixture-'));
  for (const entry of fs.readdirSync(FIXTURE_SRC, { withFileTypes: true })) {
    if (entry.isFile()) fs.copyFileSync(path.join(FIXTURE_SRC, entry.name), path.join(FIXTURE_DIR, entry.name));
  }
  try {
    await page.evaluate(async (dir) => {
      // @ts-ignore preload-injected API
      await window.xleth.project.load(dir);
    }, FIXTURE_DIR);
  } catch (e) {
    console.warn(`[baseline] fixture load failed: ${(e as Error).message}`);
  }
  // Panels fetch at mount; a direct IPC load does not dispatch the events Open Project does.
  await page.reload();
  await waitForShell();
  fixtureLoaded = true;
}

/** Choose a shipped theme the way the app does (the `activeTheme` setting), then reload so it applies. */
async function useTheme(slug: string): Promise<void> {
  await page.evaluate(async (s) => {
    // @ts-ignore preload-injected API
    await window.xleth.settings.set('activeTheme', s);
  }, slug);
  await page.reload();
  await waitForShell();
}

/** Open a detail-dock tab; returns false when the tab is missing. */
async function openDockTab(id: string): Promise<boolean> {
  const tab = page.locator(`[data-detail-tab="${id}"]`).first();
  if (!(await tab.isVisible().catch(() => false))) return false;
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await page.waitForTimeout(500);
  await waitForCanvasStable();
  return true;
}

async function shoot(locator: Locator, name: string): Promise<void> {
  await expect(locator).toBeVisible();
  await expect(locator).toHaveScreenshot(`${name}.png`);
}

// ── Cold state: empty project ─────────────────────────────────────────────────

test('01-shell-default', async () => {
  await waitForCanvasStable();
  await expect(page).toHaveScreenshot('01-shell-default.png');
});

test('02-top-bar', async () => {
  await shoot(page.locator('.titlebar').first(), '02-top-bar');
});

test('03-browser-media-and-samples', async () => {
  const browser = page.getByRole('tab', { name: /^Media/ }).first();
  test.skip(!(await browser.isVisible().catch(() => false)), 'Browser drawer not visible');
  await browser.click();
  await page.waitForTimeout(300);
  await expect(page.locator('[data-testid="xleth-app-workarea"]')).toHaveScreenshot('03-browser-media.png');
  await page.getByRole('tab', { name: /^Samples/ }).first().click();
  await page.waitForTimeout(300);
  await expect(page.locator('[data-testid="xleth-app-workarea"]')).toHaveScreenshot('04-browser-samples.png');
});

// ── Fixture state: tracks, effect chains ──────────────────────────────────────

for (const tab of DOCK_TABS) {
  test(tab.shot, async () => {
    await loadFixture();
    test.skip(!(await openDockTab(tab.id)), `detail-dock tab "${tab.id}" not present`);
    await shoot(page.locator('[data-testid="xleth-detail-dock"]'), tab.shot);
  });
}

test('20-inspector-track-selected', async () => {
  await loadFixture();
  const header = page.locator('.track-header').first();
  test.skip(!(await header.isVisible().catch(() => false)), 'fixture tracks did not render');
  await header.click();
  const inspector = page.locator('[data-testid="xleth-inspector-track"], [data-testid="xleth-inspector-clip"]').first();
  test.skip(!(await inspector.isVisible().catch(() => false)), 'Inspector did not show the selection');
  await waitForCanvasStable();
  await shoot(inspector, '20-inspector-track-selected');
});

test('21-preview-edit-grid', async () => {
  await loadFixture();
  const toggle = page.getByRole('button', { name: /edit grid/i }).first();
  test.skip(!(await toggle.isVisible().catch(() => false)), 'Edit grid toggle not found');
  await toggle.click();
  await page.waitForTimeout(500);
  await waitForCanvasStable();
  await expect(page.locator('[data-testid="grid-edit-toolbar"]')).toBeVisible();
  await expect(page.locator('[data-testid="xleth-app-workarea"]')).toHaveScreenshot('21-preview-edit-grid.png');
  await toggle.click(); // leave Edit Grid
});

test('22-device-chain', async () => {
  await loadFixture();
  test.skip(!(await openDockTab('devices')), 'Devices tab not present');
  const chain = page.locator('[data-testid="xleth-device-chain"]');
  test.skip(!(await chain.isVisible().catch(() => false)), 'device chain not rendered');
  // The fixture's master / track-1 chain holds several devices; shoot the strip itself.
  await shoot(chain, '22-device-chain');
});

test('23-mixer', async () => {
  await loadFixture();
  test.skip(!(await openDockTab('mixer')), 'Mixer tab not present');
  await shoot(page.locator('[data-testid="mixer-panel"]'), '23-mixer');
});

// The sample-picker sheet needs an imported source: the fixture has none. See MANUAL.md.
test('24-sample-picker-sheet', async () => {
  await loadFixture();
  const sheet = page.locator('[data-testid="picker-sheet"]');
  test.skip(!(await sheet.isVisible().catch(() => false)), 'needs an imported source (MANUAL.md, 24)');
  await waitForCanvasStable();
  await shoot(sheet, '24-sample-picker-sheet');
});

// ── Dialogs and menus that moved to the kit in Phase 8 ────────────────────────

test('30-context-menu', async () => {
  await loadFixture();
  const header = page.locator('.track-header').first();
  test.skip(!(await header.isVisible().catch(() => false)), 'fixture tracks did not render');
  await header.click({ button: 'right' });
  const menu = page.locator('[role="menu"]').first();
  test.skip(!(await menu.isVisible().catch(() => false)), 'context menu did not open');
  await shoot(menu, '30-context-menu');
});

test('31-export-dialog', async () => {
  await loadFixture();
  await page.keyboard.press('Control+E');
  const dialog = page.locator('.export-dialog').first();
  test.skip(!(await dialog.isVisible().catch(() => false)), 'Export dialog did not open (MANUAL.md, 31)');
  await shoot(dialog, '31-export-dialog');
});

// ── Each shipped theme, shell default (runs last: it reloads the app) ─────────

for (const slug of THEMES) {
  test(`40-theme-${slug}`, async () => {
    await useTheme(slug);
    await waitForCanvasStable();
    await expect(page).toHaveScreenshot(`40-theme-${slug}.png`);
  });
}

test('49-restore-default-theme', async () => {
  await useTheme('xleth-default');
});
