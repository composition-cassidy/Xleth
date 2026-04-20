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

  // Extra settle time: canvas draws and IPC-fetched track lists may arrive
  // after React mount. 1.5 s is enough for the demo project to populate.
  await page.waitForTimeout(1500);
});

test.afterAll(async () => {
  await app.close();
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

// ── 1. Full app — default state ───────────────────────────────────────────────

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

// ── 3. Timeline ───────────────────────────────────────────────────────────────

test('07-timeline-full', async () => {
  // Ensure timeline tab is active.
  const timelineTab = page.locator('button:has-text("Timeline")');
  if (await timelineTab.isVisible()) await timelineTab.click();
  await waitForCanvasStable();
  const center = page.locator('.center-area, [class*="center-area"]').first();
  await expect(center).toHaveScreenshot('07-timeline-full.png');
});

test('08-timeline-ruler', async () => {
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
  const headers = page.locator('.track-headers, [class*="track-header"]').first();
  if (await headers.isVisible()) {
    await expect(headers).toHaveScreenshot('09-timeline-track-headers.png');
  } else {
    test.skip();
  }
});

// ── 4. Mixer ──────────────────────────────────────────────────────────────────

test('10-mixer-panel', async () => {
  // Mixer is typically in the bottom dock or accessible via a button.
  // Try common entry points.
  const mixerBtn = page.locator('[title="Mixer"], button:has-text("Mixer"), .dock-mixer').first();
  if (await mixerBtn.isVisible()) {
    await mixerBtn.click();
    await page.waitForTimeout(400);
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
  // Piano roll opens when a pattern block is double-clicked in the timeline.
  // Try to find and click any pattern block, or the Piano Roll tab if already open.
  const prTab = page.locator('.center-tab:has-text("Piano Roll")').first();
  if (await prTab.isVisible()) {
    await prTab.click();
    await waitForCanvasStable();
    await expect(page.locator('.center-area-body').first()).toHaveScreenshot('11-piano-roll.png');
  } else {
    // Fall back to a double-click on the first pattern block in the timeline.
    const block = page.locator('.pattern-block, [class*="pattern-block"]').first();
    if (await block.isVisible()) {
      await block.dblclick();
      await page.waitForTimeout(500);
      await waitForCanvasStable();
      await expect(page.locator('.center-area-body').first()).toHaveScreenshot('11-piano-roll.png');
    } else {
      test.skip();
    }
  }
});

// ── 6. Sampler panel ─────────────────────────────────────────────────────────

test('12-sampler-panel', async () => {
  const sampler = page.locator('.sampler-panel, [class*="sampler-panel"]').first();
  if (await sampler.isVisible()) {
    await waitForCanvasStable();
    await expect(sampler).toHaveScreenshot('12-sampler-panel.png');
  } else {
    test.skip();
  }
});

// ── 7. Effect panels ──────────────────────────────────────────────────────────
// These panels live inside the EffectChain/EffectModule.

test('13-eq-panel', async () => {
  const eq = page.locator('.eq-panel, [class*="eq-panel"], svg:has(.eq-grid)').first();
  if (await eq.isVisible()) {
    await expect(eq.locator('..').first()).toHaveScreenshot('13-eq-panel.png');
  } else {
    test.skip();
  }
});

test('14-compressor-panel', async () => {
  const el = page.locator('.compressor-panel, [class*="compressor"]').first();
  if (await el.isVisible()) {
    await expect(el).toHaveScreenshot('14-compressor-panel.png');
  } else {
    test.skip();
  }
});

test('15-delay-panel', async () => {
  const el = page.locator('.delay-panel, [class*="delay"]').first();
  if (await el.isVisible()) {
    await expect(el).toHaveScreenshot('15-delay-panel.png');
  } else {
    test.skip();
  }
});

test('16-distortion-panel', async () => {
  const el = page.locator('.distortion-panel, [class*="distortion"]').first();
  if (await el.isVisible()) {
    await expect(el).toHaveScreenshot('16-distortion-panel.png');
  } else {
    test.skip();
  }
});

test('17-chorus-panel', async () => {
  const el = page.locator('.chorus-panel, [class*="chorus"]').first();
  if (await el.isVisible()) {
    await expect(el).toHaveScreenshot('17-chorus-panel.png');
  } else {
    test.skip();
  }
});

test('18-limiter-panel', async () => {
  const el = page.locator('.limiter-panel, [class*="limiter"]').first();
  if (await el.isVisible()) {
    await expect(el).toHaveScreenshot('18-limiter-panel.png');
  } else {
    test.skip();
  }
});

// ── 8. Node editor ────────────────────────────────────────────────────────────

test('19-node-editor', async () => {
  const el = page.locator('.node-editor, [class*="node-editor"]').first();
  if (await el.isVisible()) {
    await expect(el).toHaveScreenshot('19-node-editor.png');
  } else {
    test.skip();
  }
});

// ── 9. Sample Picker ──────────────────────────────────────────────────────────

test('20-sample-picker', async () => {
  const el = page.locator('.sample-picker, [class*="sample-picker"]').first();
  if (await el.isVisible()) {
    await waitForCanvasStable();
    await expect(el).toHaveScreenshot('20-sample-picker.png');
  } else {
    test.skip();
  }
});

// ── 10. Settings panel ────────────────────────────────────────────────────────

test('21-settings-panel', async () => {
  // Open via File → Settings or a toolbar button.
  const settingsBtn = page.locator('[title="Settings"], button:has-text("Settings")').first();
  if (await settingsBtn.isVisible()) {
    await settingsBtn.click();
    await page.waitForTimeout(300);
  }
  const el = page.locator('.settings-panel, [class*="settings-panel"]').first();
  if (await el.isVisible()) {
    await expect(el).toHaveScreenshot('21-settings-panel.png');
    await page.keyboard.press('Escape');
  } else {
    test.skip();
  }
});

// ── 11. Dialogs ───────────────────────────────────────────────────────────────

test('22-export-dialog', async () => {
  // Trigger via the title bar File → Export Audio menu if possible.
  // We use page.evaluate to fire the custom event that App.jsx listens for.
  // Since we can't rely on the native menu in headless Electron, simulate via
  // the public handleMenuAction by dispatching a custom event that TitleBar emits.
  // Simplest: look for an existing dialog or trigger via keyboard shortcut.
  await page.keyboard.press('Control+e');
  await page.waitForTimeout(500);
  const dialog = page.locator('.export-dialog, [class*="export-dialog"]').first();
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
  // Trigger a success toast by saving (Ctrl+S) — will fail gracefully if no project dir.
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(400);
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
  const el = page.locator('.syllable-splitter, [class*="syllable"]').first();
  if (await el.isVisible()) {
    await expect(el).toHaveScreenshot('25-syllable-splitter.png');
  } else {
    test.skip();
  }
});

// ── 14. WaveformScrubber / lip-sync picker ────────────────────────────────────

test('26-waveform-scrubber', async () => {
  const el = page.locator('.waveform-scrubber, [class*="waveform-scrubber"]').first();
  if (await el.isVisible()) {
    await waitForCanvasStable();
    await expect(el).toHaveScreenshot('26-waveform-scrubber.png');
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
  // Right-click on the timeline to trigger a context menu.
  const timeline = page.locator('.timeline-view, .timeline-canvas, [class*="timeline-view"]').first();
  if (await timeline.isVisible()) {
    await timeline.click({ button: 'right', position: { x: 200, y: 100 } });
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
  const bottom = page.locator('.bottom-dock, .transport-bar, [class*="bottom"]').first();
  if (await bottom.isVisible()) {
    await expect(bottom).toHaveScreenshot('29-bottom-dock.png');
  } else {
    await expect(page).toHaveScreenshot('29-full-app-final.png', { fullPage: false });
  }
});
