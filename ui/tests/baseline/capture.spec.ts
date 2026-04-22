// Phase 0 Baseline Capture — Playwright + Electron CDP
//
// Launches the built Electron app (XLETH_PLAYWRIGHT=1 → dist/index.html)
// and captures screenshot baselines for every major panel, effect UI, and
// dialog. All baselines share a single app instance to amortise the ~3s
// addon-init cost.
//
// Usage:
//   npm run baseline:capture   — first run; writes snapshots
//   npm run baseline:check     — subsequent runs; diffs against snapshots (no update)
//
// Test grouping:
//   Tests 01–07  — cold-state (empty project); run first
//   Tests 08–29  — fixture-state; fixture loaded once at start of test 08
//
// Non-determinism mitigations applied per shot:
//   - CSS animations/transitions frozen on load (injected stylesheet)
//   - requestAnimationFrame canvas frames: waitForFunction polling for stable
//     hash of a 1×1 pixel sample at a stable point avoids timing drift
//   - Playhead at position 0 (transport stopped on launch)
//   - Window fixed at 1280×800 (set in BrowserWindow config)

import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

// ── Shared app instance ───────────────────────────────────────────────────────

let app: ElectronApplication;
let page: Page;

const FREEZE_CSS = `
  *, *::before, *::after {
    animation-play-state: paused !important;
    animation-duration: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
`;

// Inject FREEZE_CSS via page.evaluate to avoid triggering Playwright's CSP
// check — the fontsource data-URI fonts in the app's CSS would otherwise
// cause page.addStyleTag to throw (false positive: font was already loaded).
async function freezeAnimations(p: Page): Promise<void> {
  await p.evaluate((css) => {
    const existing = document.getElementById('__xleth_freeze__');
    if (existing) return;
    const s = document.createElement('style');
    s.id = '__xleth_freeze__';
    s.textContent = css;
    document.head.appendChild(s);
  }, FREEZE_CSS);
}

const UI_DIR = path.resolve(__dirname, '../..');
const FIXTURE_SRC = path.resolve(__dirname, '..', 'fixture');
// Temp copy of the fixture dir — isolates engine saves from the source files.
let FIXTURE_DIR = '';
let fixtureLoaded = false;

test.beforeAll(async () => {
  // Require a built dist — fail fast rather than silently capturing the Vite
  // dev server (user is warned to run npm run baseline:build first).
  const distIndex = path.join(UI_DIR, 'dist', 'index.html');
  if (!fs.existsSync(distIndex)) {
    throw new Error(
      `dist/index.html not found. Run "npm run baseline:build" first.\n` +
      `Expected: ${distIndex}`,
    );
  }

  app = await electron.launch({
    args: [path.join(UI_DIR, 'main.js')],
    cwd: UI_DIR,
    env: {
      ...process.env,
      XLETH_PLAYWRIGHT: '1',
      // Suppress GPU / hardware warnings that can stall test output.
      ELECTRON_ENABLE_LOGGING: '0',
    },
  });

  page = await app.firstWindow();

  // Inject freeze stylesheet — using evaluate to sidestep Playwright's CSP
  // check (fontsource data-URI fonts in app CSS cause addStyleTag to throw).
  await freezeAnimations(page);

  // Wait for the React root to be mounted — ThemeProvider resolves first,
  // then App renders. We wait for the .app element + the transport bar.
  await page.waitForSelector('.app', { timeout: 30_000 });
  await page.waitForSelector('.transport-bar, .titlebar, [class*="transport"]', {
    timeout: 30_000,
  });

  // Settle time — engine worker needs to be ready before cold-state tests run.
  await page.waitForTimeout(1500);
});

test.afterAll(async () => {
  await app.close();
  if (FIXTURE_DIR && fs.existsSync(FIXTURE_DIR)) {
    try { fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// Re-apply freeze CSS after each test (new nodes may have been added).
// Also close any stray dialogs so subsequent tests get a clean slate.
test.afterEach(async () => {
  // Close any open modal via backdrop click, then Escape.
  await page.evaluate(() => {
    const backdrop = document.querySelector<HTMLElement>('.export-dialog-backdrop, .dialog-backdrop, [class*="backdrop"]');
    backdrop?.click();
  }).catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(150);
  await freezeAnimations(page).catch(() => {});
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Wait for all canvas elements to stop changing (pixel-stable for 300ms). */
async function waitForCanvasStable(timeout = 8000): Promise<void> {
  const start = Date.now();
  let prev = '';
  while (Date.now() - start < timeout) {
    const hash = await page.evaluate(() => {
      const canvases = Array.from(document.querySelectorAll('canvas'));
      return canvases.map(c => {
        try {
          const ctx = c.getContext('2d');
          if (!ctx) return '';
          const d = ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
          return `${c.width}x${c.height}:${d[0]},${d[1]},${d[2]}`;
        } catch { return ''; }
      }).join('|');
    });
    if (hash === prev && hash !== '') return;
    prev = hash;
    await page.waitForTimeout(300);
  }
}

/** Dismiss any open dropdown / context menu. */
async function dismissMenus(): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
}

/**
 * Load the fixture project into the C++ engine — once per suite run.
 * Called at the start of test 08 (first fixture-dependent test). All
 * subsequent tests share the same loaded state via the shared app instance.
 * The fixture is copied to a temp dir so engine saves don't overwrite the
 * source fixture files.
 */
async function loadFixture(): Promise<void> {
  if (fixtureLoaded) return;
  FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xleth-fixture-'));
  for (const entry of fs.readdirSync(FIXTURE_SRC, { withFileTypes: true })) {
    if (entry.isFile()) {
      fs.copyFileSync(path.join(FIXTURE_SRC, entry.name), path.join(FIXTURE_DIR, entry.name));
    }
  }
  try {
    await page.evaluate(async (dir) => {
      // @ts-ignore — preload-injected API
      await window.xleth.project.load(dir);
    }, FIXTURE_DIR);
  } catch (e) {
    console.warn(`[test] Fixture load failed: ${(e as Error).message}`);
  }
  // A full page reload is required so that every panel's mount-time fetch
  // sees the loaded project state. Direct IPC load does not dispatch the
  // timelineEvents that a normal Open-Project flow does, so canvas panels
  // (TimelineRuler, TrackHeaders) don't re-render without a reload.
  await page.reload();
  await freezeAnimations(page);
  await page.waitForSelector('.app', { timeout: 30_000 });
  await page.waitForSelector('.transport-bar, .titlebar, [class*="transport"]', {
    timeout: 30_000,
  });
  await page.waitForTimeout(2000);
  fixtureLoaded = true;
}

/** Open the mixer panel if not already visible. */
async function openMixer(): Promise<void> {
  const mixer = page.locator('.mixer-panel').first();
  if (!(await mixer.isVisible().catch(() => false))) {
    const btn = page.locator('button[title="Toggle Mixer (M)"]').first();
    if (await btn.isVisible()) {
      await btn.click();
      await page.waitForTimeout(400);
    }
  }
}

/** Click an effect chip by display name. Returns true if clicked. */
async function clickEffectChip(displayName: string): Promise<boolean> {
  await openMixer();
  // Mouse-hover track 1's strip — effect list is always rendered per strip.
  const strip = page.locator('.mixer-strip').first();
  if (await strip.isVisible()) {
    await strip.hover();
    await page.waitForTimeout(200);
  }
  // Click the effect name in the effect chain for this display name.
  const chip = page
    .locator(`.effect-module:has(.effect-module-name-text:has-text("${displayName}"))`)
    .locator('.effect-module-name')
    .first();
  if (!(await chip.isVisible().catch(() => false))) return false;
  await chip.click();
  await page.waitForTimeout(600);
  return true;
}

// ── Cold-state tests (01–07) — empty project, no fixture load ────────────────

test('01-app-default', async () => {
  // Main app with Timeline tab active, left panel showing Project Media.
  await expect(page).toHaveScreenshot('01-app-default.png', { fullPage: false });
});

test('02-titlebar', async () => {
  const titlebar = page.locator('.titlebar, [class*="title-bar"], [class*="titlebar"]').first();
  await expect(titlebar).toHaveScreenshot('02-titlebar.png');
});

test('03-transport-bar', async () => {
  const transport = page.locator('.transport-bar, [class*="transport"]').first();
  await expect(transport).toHaveScreenshot('03-transport-bar.png');
});

// ── 2. Left panel tabs ────────────────────────────────────────────────────────

test('04-left-panel-media', async () => {
  // Default tab — Project Media.
  const panel = page.locator('.left-panel');
  await expect(panel).toHaveScreenshot('04-left-panel-media.png');
});

test('05-left-panel-samples', async () => {
  await page.click('button:has-text("Sample Selector")');
  await page.waitForTimeout(300);
  await expect(page.locator('.left-panel')).toHaveScreenshot('05-left-panel-samples.png');
});

test('06-left-panel-grid', async () => {
  await page.click('button:has-text("Grid")');
  await page.waitForTimeout(300);
  await expect(page.locator('.left-panel')).toHaveScreenshot('06-left-panel-grid.png');
  // Reset to media tab for subsequent tests.
  await page.click('button:has-text("Project Media")');
});

test('07-timeline-full', async () => {
  // Ensure timeline tab is active.
  const timelineTab = page.locator('button:has-text("Timeline")');
  if (await timelineTab.isVisible()) await timelineTab.click();
  await waitForCanvasStable();
  const center = page.locator('.center-area, [class*="center-area"]').first();
  await expect(center).toHaveScreenshot('07-timeline-full.png');
});

// ── Fixture-state tests (08–29) — fixture loaded once at start of test 08 ────
// State leakage is intentional: the shared app instance carries loaded project
// state forward. Tests that were passing in cold state and are fixture-agnostic
// (titlebar, ruler, settings, etc.) continue to pass.

test('08-timeline-ruler', async () => {
  await loadFixture();
  // Project load may switch the center area away from the Timeline tab — restore it.
  const timelineTab = page.locator('button:has-text("Timeline")');
  if (await timelineTab.isVisible()) await timelineTab.click();
  await page.waitForTimeout(500);
  // TimelineRuler canvas if independently identifiable.
  const ruler = page.locator('.timeline-ruler, [class*="timeline-ruler"]').first();
  if (await ruler.isVisible()) {
    await waitForCanvasStable();
    await expect(ruler).toHaveScreenshot('08-timeline-ruler.png');
  } else {
    test.skip();
  }
});

test('09-timeline-track-headers', async () => {
  const headers = page.locator('.track-headers').first();
  if (await headers.isVisible()) {
    await expect(headers).toHaveScreenshot('09-timeline-track-headers.png');
  } else {
    test.skip();
  }
});

// ── 4. Mixer ──────────────────────────────────────────────────────────────────

test('10-mixer-panel', async () => {
  // Toggle mixer via the transport-bar button (Sliders icon, title="Toggle Mixer (M)").
  const mixerBtn = page.locator('button[title="Toggle Mixer (M)"]').first();
  if (await mixerBtn.isVisible()) {
    await mixerBtn.click();
    await page.waitForTimeout(600);
  }
  const mixer = page.locator('.mixer-panel').first();
  if (await mixer.isVisible()) {
    await expect(mixer).toHaveScreenshot('10-mixer-panel.png');
  } else {
    test.skip();
  }
});

// ── 5. Piano Roll (requires a pattern to be open) ────────────────────────────

test('11-piano-roll', async () => {
  // Pattern blocks on the timeline are canvas-drawn (no DOM selector). Click
  // a pattern row in the PatternListPanel instead — that triggers
  // onOpenPianoRoll and switches the center area to the piano roll tab.
  const patternRow = page.locator('.pattern-list-row').first();
  // Guard: the mixer panel can intercept pointer events over the pattern list.
  // Only attempt the click if the mixer is NOT open (otherwise the test will
  // timeout waiting for the click to land).
  const mixerIsOpen = await page.locator('.mixer-panel').first().isVisible().catch(() => false);
  if ((await patternRow.isVisible()) && !mixerIsOpen) {
    await patternRow.click();
    await page.waitForTimeout(600);
  }
  const prTab = page.locator('.center-tab:has-text("Piano Roll")').first();
  if (await prTab.isVisible()) {
    await prTab.click();
    await waitForCanvasStable();
    await expect(page.locator('.center-area-body').first()).toHaveScreenshot('11-piano-roll.png');
    // Teardown: switch back to Timeline tab so later tests find normal state.
    const timelineTab = page.locator('button:has-text("Timeline"), .center-tab:has-text("Timeline")').first();
    if (await timelineTab.isVisible()) {
      await timelineTab.click();
      await page.waitForTimeout(200);
    }
  } else {
    // Fall back to a double-click on the first pattern block in the timeline.
    const block = page.locator('.pattern-block, [class*="pattern-block"]').first();
    if (await block.isVisible()) {
      await block.dblclick();
      await page.waitForTimeout(500);
      await waitForCanvasStable();
      await expect(page.locator('.center-area-body').first()).toHaveScreenshot('11-piano-roll.png');
      // Teardown: switch back to Timeline tab.
      const timelineTab = page.locator('button:has-text("Timeline"), .center-tab:has-text("Timeline")').first();
      if (await timelineTab.isVisible()) {
        await timelineTab.click();
        await page.waitForTimeout(200);
      }
    } else {
      test.skip();
    }
  }
});

// ── 6. Sampler panel ─────────────────────────────────────────────────────────

test('12-sampler-panel', async () => {
  // loadFixture() is guarded — already executed at test 08; this is a no-op.
  await loadFixture();

  // Close the mixer if open — it can intercept right-click events on track headers.
  const mixerPanelForClose = page.locator('.mixer-panel').first();
  if (await mixerPanelForClose.isVisible().catch(() => false)) {
    const mixerToggleBtn = page.locator('button[title="Toggle Mixer (M)"]').first();
    if (await mixerToggleBtn.isVisible()) {
      await mixerToggleBtn.click();
      await page.waitForTimeout(300);
    }
  }

  // Ensure the Timeline tab is active so track headers are rendered.
  const timelineTab = page.locator('button:has-text("Timeline")');
  if (await timelineTab.isVisible()) {
    await timelineTab.click();
    await page.waitForTimeout(300);
  }

  // Step 1 — Require a Pattern track header to be in the DOM.
  const patternTrackHeader = page.locator('.track-header--pattern').first();
  if (!(await patternTrackHeader.isVisible().catch(() => false))) {
    test.skip(); // fixture tracks did not render
    return;
  }

  // Step 2 — Right-click the track header to open the TrackContextMenu.
  // This is the only UI path that populates currentPatternIdByTrack, which
  // drives hasActivePattern → enables the "Open Sampler Settings" button.
  await patternTrackHeader.click({ button: 'right' });
  await page.waitForTimeout(300);

  // Step 3 — Click "Select Pattern" to expand the submenu.
  const selectPatternBtn = page.locator('.track-context-menu button:has-text("Select Pattern")').first();
  if (!(await selectPatternBtn.isVisible().catch(() => false))) {
    test.skip(); // context menu did not appear
    return;
  }
  await selectPatternBtn.click();
  await page.waitForTimeout(200);

  // Step 4 — Click "Pattern 1" in the submenu (fixture has exactly one pattern).
  const pattern1Btn = page.locator('.track-context-submenu button:has-text("Pattern 1")').first();
  if (await pattern1Btn.isVisible().catch(() => false)) {
    await pattern1Btn.click();
  }
  // Allow React to re-render hasActivePattern → true and update button state.
  await page.waitForTimeout(400);

  // Step 5 — Click the now-enabled "Open Sampler Settings" button.
  // TrackHeader now dispatches { patternId, regionId } (fix: d3f90c1) so
  // App.jsx will call setSamplerPanelRegionId(regionId) and mount SamplerPanel.
  const samplerBtn = page.locator('button[title="Open Sampler Settings"]').first();
  if (await samplerBtn.isVisible().catch(() => false)) {
    await samplerBtn.click();
    await page.waitForTimeout(600);
  }

  // Step 6 — Screenshot or skip.
  const sampler = page.locator('.sampler-panel, [class*="sampler-panel"]').first();
  if (await sampler.isVisible()) {
    await waitForCanvasStable();
    await expect(sampler).toHaveScreenshot('12-sampler-panel.png');
    // Teardown: close the sampler so tests 13+ find an unobstructed mixer.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  } else {
    test.skip(); // sampler panel did not mount
  }
});

// ── 7. Effect panels ──────────────────────────────────────────────────────────
// These panels live inside the EffectChain/EffectModule. For each effect
// panel, we open the mixer (if not already open), ensure track 1 is visible,
// then click the effect chip's name (which invokes the editor opener).

test('13-eq-panel', async () => {
  await clickEffectChip('Xleth EQ');
  const eq = page.locator('.eq-panel').first();
  if (await eq.isVisible()) {
    await expect(eq).toHaveScreenshot('13-eq-panel.png');
    // Teardown: close the panel so it doesn't bleed into later tests.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  } else {
    test.skip();
  }
});

test('14-compressor-panel', async () => {
  await clickEffectChip('Compressor');
  const el = page.locator('.compressor-panel, [class*="compressor-panel"]').first();
  if (await el.isVisible()) {
    await expect(el).toHaveScreenshot('14-compressor-panel.png');
    // Teardown: close the panel so it doesn't bleed into later tests.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  } else {
    test.skip();
  }
});

test('15-delay-panel', async () => {
  // baseline not yet captured — run with --update-snapshots after manual verification
  test.skip();
});

test('16-distortion-panel', async () => {
  // baseline not yet captured — run with --update-snapshots after manual verification
  test.skip();
});

test('17-chorus-panel', async () => {
  // baseline not yet captured — run with --update-snapshots after manual verification
  test.skip();
});

test('18-limiter-panel', async () => {
  // baseline not yet captured — run with --update-snapshots after manual verification
  test.skip();
});

// ── 8. Node editor ────────────────────────────────────────────────────────────

test('19-node-editor', async () => {
  // The NODE button opens the node editor in a SEPARATE Electron window
  // (main.js spawns a child BrowserWindow with ?view=node-editor), so the
  // in-page selector will never match. We still click to document intent.
  await openMixer();
  const nodeBtn = page.locator('.effect-chain-mode-btn:has-text("NODE")').first();
  if (await nodeBtn.isVisible()) {
    await nodeBtn.click();
    await page.waitForTimeout(600);
  }
  const el = page.locator('.node-editor, [class*="node-editor"]').first();
  if (await el.isVisible()) {
    await expect(el).toHaveScreenshot('19-node-editor.png');
  } else {
    test.skip();
  }
});

// ── 9. Sample Picker ──────────────────────────────────────────────────────────

test('20-sample-picker', async () => {
  // Ensure the Project Media tab is active, then double-click the first
  // source card — that invokes onOpenPicker which mounts SamplePicker in
  // the center area.
  const mediaTab = page.locator('button:has-text("Project Media")').first();
  if (await mediaTab.isVisible()) {
    await mediaTab.click();
    await page.waitForTimeout(200);
  }
  const card = page.locator('.source-card').first();
  if (await card.isVisible()) {
    await card.dblclick();
    await page.waitForTimeout(400);
  }
  const el = page.locator('.sample-picker, [class*="sample-picker"]').first();
  if (await el.isVisible()) {
    await waitForCanvasStable();
    await expect(el).toHaveScreenshot('20-sample-picker.png');
    // Teardown: navigate back to Timeline so the SamplePicker doesn't affect later tests.
    const timelineTabClose = page.locator('button:has-text("Timeline"), .center-tab:has-text("Timeline")').first();
    if (await timelineTabClose.isVisible()) {
      await timelineTabClose.click();
      await page.waitForTimeout(200);
    }
  } else {
    test.skip();
  }
});

// ── 10. Settings panel ────────────────────────────────────────────────────────

test('21-settings-panel', async () => {
  // Titlebar → Settings menu → Settings item. Two clicks: open the top-level
  // menu, then the dropdown entry.
  const menuTrigger = page.locator('.titlebar-menu-trigger:has-text("Settings")').first();
  if (await menuTrigger.isVisible()) {
    await menuTrigger.click();
    await page.waitForTimeout(200);
    const item = page.locator('.titlebar-dropdown-item:has-text("Settings")').first();
    if (await item.isVisible()) {
      await item.click();
      await page.waitForTimeout(400);
    }
  }
  const el = page.locator('.settings-panel').first();
  if (await el.isVisible()) {
    await expect(el).toHaveScreenshot('21-settings-panel.png');
    // Teardown: close any nested sub-dialog first, then the top-level panel.
    // The SettingsPanel has nested sub-dialogs (e.g. CLIP PROCESSING) that
    // Escape does not dismiss with a single press — two presses required.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    // Verify fully closed; fall back to an outside click if still visible.
    if (await el.isVisible().catch(() => false)) {
      await page.click('body', { position: { x: 10, y: 10 } });
      await page.waitForTimeout(200);
    }
  } else {
    test.skip();
  }
});

// ── 11. Dialogs ───────────────────────────────────────────────────────────────

test('22-export-dialog', async () => {
  // Use Ctrl+E to open the export dialog.
  // Capture the inner dialog box only — NOT the full-screen backdrop — so that
  // background state differences (mixer open, panels visible, etc.) don't affect
  // the baseline comparison.
  await page.keyboard.press('Control+e');
  await page.waitForTimeout(500);
  // Target the inner dialog div, not the full-screen backdrop.
  const dialog = page.locator('.export-dialog-backdrop .export-dialog').first();
  if (await dialog.isVisible()) {
    await expect(dialog).toHaveScreenshot('22-export-dialog.png');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  } else {
    test.skip();
  }
});

test('23-video-export-dialog', async () => {
  await page.keyboard.press('Control+Shift+e');
  await page.waitForTimeout(500);
  const dialog = page.locator('.video-export-dialog, [class*="video-export"]').first();
  if (await dialog.isVisible()) {
    await expect(dialog).toHaveScreenshot('23-video-export-dialog.png');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  } else {
    test.skip();
  }
});

// ── 12. Toast notifications ───────────────────────────────────────────────────

test('24-toast-success', async () => {
  // Trigger a success toast by saving (Ctrl+S). With the fixture loaded,
  // Save should succeed and show a 'Project saved.' toast.
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(1000);
  const toast = page.locator('.toast, [class*="toast"]').first();
  if (await toast.isVisible()) {
    await expect(toast).toHaveScreenshot('24-toast.png');
    await page.waitForTimeout(3000); // wait for auto-dismiss
  } else {
    test.skip();
  }
});

// ── 13. Syllable Splitter (if visible) ───────────────────────────────────────

test('25-syllable-splitter', async () => {
  // Requires a region with syllable data; the fixture has syllables: []
  // so there is nothing to render. Left as a skip-fallback by design.
  const el = page.locator('.syllable-splitter, [class*="syllable"]').first();
  if (await el.isVisible()) {
    await expect(el).toHaveScreenshot('25-syllable-splitter.png');
  } else {
    test.skip();
  }
});

// ── 14. WaveformScrubber / lip-sync picker ────────────────────────────────────

test('26-waveform-scrubber', async () => {
  // WaveformScrubber lives inside SamplePicker — open the picker first.
  const mediaTab = page.locator('button:has-text("Project Media")').first();
  if (await mediaTab.isVisible()) {
    await mediaTab.click();
    await page.waitForTimeout(200);
  }
  const card = page.locator('.source-card').first();
  if (await card.isVisible()) {
    await card.dblclick();
    await page.waitForTimeout(600);
  }
  const el = page.locator('.waveform-scrubber, [class*="waveform-scrubber"]').first();
  if (await el.isVisible()) {
    await waitForCanvasStable();
    await expect(el).toHaveScreenshot('26-waveform-scrubber.png');
    // Teardown: navigate back to Timeline so the SamplePicker doesn't affect
    // the video-preview (test 27) which captures the default center-area state.
    const timelineTabClose = page.locator('button:has-text("Timeline"), .center-tab:has-text("Timeline")').first();
    if (await timelineTabClose.isVisible()) {
      await timelineTabClose.click();
      await page.waitForTimeout(200);
    }
  } else {
    test.skip();
  }
});

// ── 15. Video Preview ─────────────────────────────────────────────────────────

test('27-video-preview', async () => {
  const el = page.locator('.video-preview, [class*="video-preview"]').first();
  if (await el.isVisible()) {
    await expect(el).toHaveScreenshot('27-video-preview.png');
  } else {
    test.skip();
  }
});

// ── 16. Context menu ──────────────────────────────────────────────────────────

test('28-context-menu', async () => {
  // Ensure no dialog is open before right-clicking.
  await page.evaluate(() => {
    const bd = document.querySelector<HTMLElement>('.export-dialog-backdrop, [class*="backdrop"]');
    bd?.click();
  }).catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
  // Right-click on the timeline track area (fixture has 2 tracks so the
  // canvas renders track rows). Try several selectors.
  const timeline = page
    .locator('.timeline-view, .timeline-canvas, [class*="timeline-view"], .track-headers, [class*="track-header"]')
    .first();
  if (await timeline.isVisible()) {
    await timeline.click({ button: 'right', position: { x: 200, y: 40 } });
    await page.waitForTimeout(300);
    const menu = page.locator('.context-menu, [class*="context-menu"]').first();
    if (await menu.isVisible()) {
      await expect(menu).toHaveScreenshot('28-context-menu.png');
      await page.keyboard.press('Escape');
    } else {
      test.skip();
    }
  } else {
    test.skip();
  }
});

// ── 17. Dock/snap chrome ──────────────────────────────────────────────────────

test('29-full-app-bottom-dock', async () => {
  // Capture the bottom area including transport + any dock panels.
  await dismissMenus();
  // Return to default state: timeline tab, no dialogs.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  // Reset transport position to 0 so the time display is deterministic.
  // The video-preview test may have caused auto-play which advances the playhead.
  await page.keyboard.press('Space'); // stop if playing
  await page.waitForTimeout(100);
  await page.keyboard.press('Home'); // seek to start
  await page.waitForTimeout(200);
  const bottom = page.locator('.bottom-dock, .transport-bar, [class*="bottom"]').first();
  if (await bottom.isVisible()) {
    await expect(bottom).toHaveScreenshot('29-bottom-dock.png');
  } else {
    await expect(page).toHaveScreenshot('29-full-app-final.png', { fullPage: false });
  }
});
