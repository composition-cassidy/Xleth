# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: capture.spec.ts >> 01-app-default
- Location: tests\baseline\capture.spec.ts:223:5

# Error details

```
Error: page.waitForSelector: Target page, context or browser has been closed
Call log:
  - waiting for locator('.app') to be visible

```

# Page snapshot

```yaml
- generic [ref=e3]:
  - generic [ref=e4]:
    - generic [ref=e5]:
      - generic [ref=e6]: XLETH
      - navigation [ref=e7]:
        - button "File" [ref=e9] [cursor=pointer]
        - button "Edit" [ref=e11] [cursor=pointer]
        - button "View" [ref=e13] [cursor=pointer]
        - button "Settings" [ref=e15] [cursor=pointer]
    - generic [ref=e16]: Untitled Project
    - generic [ref=e17]:
      - button "Minimize" [ref=e18] [cursor=pointer]:
        - img [ref=e19]
      - button "Maximize" [ref=e20] [cursor=pointer]:
        - img [ref=e21]
      - button "Close" [ref=e23] [cursor=pointer]:
        - img [ref=e24]
  - generic [ref=e29]:
    - generic [ref=e30]:
      - generic "Panel visibility" [ref=e31]:
        - button "Toggle Timeline" [pressed] [ref=e32] [cursor=pointer]:
          - img [ref=e33]
        - button "Toggle Piano Roll" [ref=e36] [cursor=pointer]:
          - img [ref=e37]
        - button "Toggle Preview" [ref=e39] [cursor=pointer]:
          - img [ref=e40]
        - button "Toggle Mixer" [pressed] [ref=e43] [cursor=pointer]:
          - img [ref=e44]
        - button "Toggle Grid Settings" [ref=e45] [cursor=pointer]:
          - img [ref=e46]
        - button "Toggle Node Editor" [ref=e48] [cursor=pointer]:
          - img [ref=e49]
        - button "Toggle Sampler" [ref=e53] [cursor=pointer]:
          - img [ref=e54]
      - generic "Layout presets" [ref=e57]:
        - button "Reset to FL Compose layout" [pressed] [ref=e58] [cursor=pointer]:
          - img [ref=e59]
          - generic [ref=e62]: FL
        - button "Switch to Vegas Arrange layout" [ref=e63] [cursor=pointer]:
          - generic [ref=e64]: VG
        - button "Switch to Grid Edit layout" [ref=e65] [cursor=pointer]:
          - generic [ref=e66]: GR
      - generic "Dock focused panel" [ref=e68]:
        - 'button "Dock focused panel left: Timeline" [ref=e69] [cursor=pointer]':
          - img [ref=e70]
        - 'button "Dock focused panel top: Timeline" [ref=e72] [cursor=pointer]':
          - img [ref=e73]
        - 'button "Dock focused panel bottom: Timeline" [ref=e75] [cursor=pointer]':
          - img [ref=e76]
        - 'button "Dock focused panel right: Timeline" [ref=e78] [cursor=pointer]':
          - img [ref=e79]
      - generic "Import" [ref=e82]:
        - button "Import MIDI" [ref=e83] [cursor=pointer]:
          - img [ref=e84]
    - generic [ref=e87]:
      - generic [ref=e89]:
        - generic [ref=e90]:
          - img [ref=e92]
          - generic [ref=e94]: Sample Selector
          - generic "Sample Selector panel controls" [ref=e96]:
            - button "Minimize Sample Selector" [ref=e97] [cursor=pointer]:
              - img [ref=e98]
            - button "Maximize Sample Selector" [ref=e99] [cursor=pointer]:
              - img [ref=e100]
            - button "Close Sample Selector" [ref=e105] [cursor=pointer]:
              - img [ref=e106]
        - generic [ref=e110]:
          - generic [ref=e111]:
            - button "Project Media" [ref=e112] [cursor=pointer]:
              - img [ref=e113]
              - generic [ref=e115]: Project Media
            - button "Sample Selector" [ref=e116] [cursor=pointer]:
              - img [ref=e117]
              - generic [ref=e121]: Sample Selector
            - button "Grid" [ref=e122] [cursor=pointer]:
              - img [ref=e123]
              - generic [ref=e125]: Grid
          - generic [ref=e128]:
            - generic [ref=e129]:
              - generic [ref=e130]: Sources
              - button "Import MIDI" [ref=e131] [cursor=pointer]:
                - img [ref=e132]
              - button "Import source" [ref=e135] [cursor=pointer]:
                - img [ref=e136]
            - generic [ref=e137]:
              - img [ref=e138]
              - paragraph [ref=e140]: No sources imported
              - paragraph [ref=e141]: Import video or audio files to get started
              - paragraph [ref=e142]: Click + or drag files here
      - generic [ref=e144]:
        - generic [ref=e146]:
          - generic [ref=e147]:
            - img [ref=e149]
            - generic [ref=e152]: Timeline
            - generic "Timeline panel controls" [ref=e154]:
              - button "Minimize Timeline" [ref=e155] [cursor=pointer]:
                - img [ref=e156]
              - button "Maximize Timeline" [ref=e157] [cursor=pointer]:
                - img [ref=e158]
              - button "Close Timeline" [ref=e163] [cursor=pointer]:
                - img [ref=e164]
          - generic [ref=e168]:
            - generic [ref=e169]:
              - generic [ref=e170]:
                - button "Select (S)" [ref=e171] [cursor=pointer]:
                  - img [ref=e172]
                - button "Pencil (P)" [ref=e174] [cursor=pointer]:
                  - img [ref=e175]
                - button "Split (C)" [ref=e178] [cursor=pointer]:
                  - img [ref=e179]
                - button "Delete (D)" [ref=e185] [cursor=pointer]:
                  - img [ref=e186]
              - generic "No sample selected" [ref=e190]:
                - generic [ref=e191]: No sample
              - generic [ref=e193]:
                - generic [ref=e194]: Snap
                - combobox "Snap granularity" [ref=e195] [cursor=pointer]:
                  - option "1/64"
                  - option "1/32"
                  - option "1/16" [selected]
                  - option "1/8"
                  - option "Beat"
                  - option "Half"
                  - option "Bar"
              - generic [ref=e197]:
                - generic [ref=e198]: Declick
                - spinbutton [ref=e199]: "0.5"
                - generic [ref=e200]: ms
              - button "Quantize (select clips first)" [disabled] [ref=e202] [cursor=pointer]:
                - img [ref=e203]
              - button "Timeline display settings" [ref=e206] [cursor=pointer]:
                - img [ref=e207]
              - generic [ref=e211]:
                - generic [ref=e212]: 40 px/beat
                - button "Add track" [ref=e213] [cursor=pointer]:
                  - img [ref=e214]
            - generic [ref=e216]:
              - img [ref=e217]
              - paragraph [ref=e221]: No tracks yet
              - paragraph [ref=e222]: Click + to add tracks to the timeline
              - button "Add Track" [ref=e223] [cursor=pointer]:
                - img [ref=e224]
                - generic [ref=e225]: Add Track
        - generic [ref=e235]:
          - generic [ref=e236]:
            - img [ref=e238]
            - generic [ref=e239]: Mixer
            - generic "Mixer panel controls" [ref=e241]:
              - button "Minimize Mixer" [ref=e242] [cursor=pointer]:
                - img [ref=e243]
              - button "Maximize Mixer" [ref=e244] [cursor=pointer]:
                - img [ref=e245]
              - button "Close Mixer" [ref=e250] [cursor=pointer]:
                - img [ref=e251]
          - generic [ref=e255]:
            - button "VST Browser" [ref=e257] [cursor=pointer]
            - generic [ref=e258]:
              - generic [ref=e259]:
                - generic: No tracks — add tracks in the timeline
              - generic [ref=e260]:
                - generic [ref=e261]: MASTER
                - generic [ref=e262]:
                  - generic [ref=e263]:
                    - button "CHAIN" [disabled] [ref=e264]
                    - button "NODE" [ref=e265] [cursor=pointer]
                  - generic [ref=e267]: No effects
                  - button "+" [ref=e269] [cursor=pointer]
                - generic [ref=e272]:
                  - generic:
                    - generic: "+12"
                    - generic: "+6"
                    - generic: "0"
                    - generic: "-6"
                    - generic: "-12"
                    - generic: "-24"
                    - generic: "-48"
                  - generic "Double-click to type dB · Drag vertical · Shift = fine · Ctrl+click = 0dB" [ref=e276]: "0.0"
  - generic [ref=e278]:
    - generic [ref=e279]:
      - button "Rewind (Home)" [ref=e280] [cursor=pointer]:
        - img [ref=e281]
      - button "Stop" [ref=e283] [cursor=pointer]:
        - img [ref=e284]
      - button "Play (Space)" [ref=e286] [cursor=pointer]:
        - img [ref=e287]
      - button "Forward" [ref=e289] [cursor=pointer]:
        - img [ref=e290]
    - generic [ref=e292]:
      - generic [ref=e293]: 00:00.000
      - generic [ref=e294]:
        - generic [ref=e295]: BAR
        - generic [ref=e296]: "1"
        - generic [ref=e297]: /
        - generic [ref=e298]: BEAT
        - generic [ref=e299]: "0.0"
    - button "Toggle Mixer (M)" [ref=e300] [cursor=pointer]:
      - img [ref=e301]
    - combobox "Audio output device" [ref=e302] [cursor=pointer]:
      - option "Speakers (2- Focusrite USB Audio)" [selected]
      - option "Speakers (Realtek(R) Audio)"
    - generic [ref=e303]:
      - button "140" [ref=e304] [cursor=pointer]
      - generic [ref=e305]: BPM
      - button "Tempo lock ON — clips maintain speed on BPM change" [ref=e306] [cursor=pointer]:
        - img [ref=e307]
    - generic [ref=e310]:
      - generic [ref=e311]: SPACE
      - generic [ref=e312]: play/pause
      - generic [ref=e313]: HOME
      - generic [ref=e314]: rewind
```

# Test source

```ts
  1   | // Phase 0 Baseline Capture — Playwright + Electron CDP
  2   | //
  3   | // Launches the built Electron app (XLETH_PLAYWRIGHT=1 → dist/index.html)
  4   | // and captures screenshot baselines for every major panel, effect UI, and
  5   | // dialog. All baselines share a single app instance to amortise the ~3s
  6   | // addon-init cost.
  7   | //
  8   | // Usage:
  9   | //   npm run baseline:capture   — first run; writes snapshots
  10  | //   npm run baseline:check     — subsequent runs; diffs against snapshots (no update)
  11  | //
  12  | // Test grouping:
  13  | //   Tests 01–07  — cold-state (empty project); run first
  14  | //   Tests 08–29  — fixture-state; fixture loaded once at start of test 08
  15  | //
  16  | // Non-determinism mitigations applied per shot:
  17  | //   - CSS animations/transitions frozen on load (injected stylesheet)
  18  | //   - requestAnimationFrame canvas frames: waitForFunction polling for stable
  19  | //     hash of a 1×1 pixel sample at a stable point avoids timing drift
  20  | //   - Playhead at position 0 (transport stopped on launch)
  21  | //   - Window fixed at 1280×800 (set in BrowserWindow config)
  22  | 
  23  | import { test, expect, _electron as electron } from '@playwright/test';
  24  | import type { ElectronApplication, Page } from '@playwright/test';
  25  | import path from 'path';
  26  | import fs from 'fs';
  27  | import os from 'os';
  28  | 
  29  | // ── Shared app instance ───────────────────────────────────────────────────────
  30  | 
  31  | let app: ElectronApplication;
  32  | let page: Page;
  33  | 
  34  | const FREEZE_CSS = `
  35  |   *, *::before, *::after {
  36  |     animation-play-state: paused !important;
  37  |     animation-duration: 0s !important;
  38  |     transition-duration: 0s !important;
  39  |     transition-delay: 0s !important;
  40  |   }
  41  | `;
  42  | 
  43  | // Inject FREEZE_CSS via page.evaluate to avoid triggering Playwright's CSP
  44  | // check — the fontsource data-URI fonts in the app's CSS would otherwise
  45  | // cause page.addStyleTag to throw (false positive: font was already loaded).
  46  | async function freezeAnimations(p: Page): Promise<void> {
  47  |   await p.evaluate((css) => {
  48  |     const existing = document.getElementById('__xleth_freeze__');
  49  |     if (existing) return;
  50  |     const s = document.createElement('style');
  51  |     s.id = '__xleth_freeze__';
  52  |     s.textContent = css;
  53  |     document.head.appendChild(s);
  54  |   }, FREEZE_CSS);
  55  | }
  56  | 
  57  | const UI_DIR = path.resolve(__dirname, '../..');
  58  | const FIXTURE_SRC = path.resolve(__dirname, '..', 'fixture');
  59  | // Temp copy of the fixture dir — isolates engine saves from the source files.
  60  | let FIXTURE_DIR = '';
  61  | let fixtureLoaded = false;
  62  | 
  63  | test.beforeAll(async () => {
  64  |   // Require a built dist — fail fast rather than silently capturing the Vite
  65  |   // dev server (user is warned to run npm run baseline:build first).
  66  |   const distIndex = path.join(UI_DIR, 'dist', 'index.html');
  67  |   if (!fs.existsSync(distIndex)) {
  68  |     throw new Error(
  69  |       `dist/index.html not found. Run "npm run baseline:build" first.\n` +
  70  |       `Expected: ${distIndex}`,
  71  |     );
  72  |   }
  73  | 
  74  |   app = await electron.launch({
  75  |     args: [path.join(UI_DIR, 'main.js')],
  76  |     cwd: UI_DIR,
  77  |     env: {
  78  |       ...process.env,
  79  |       XLETH_PLAYWRIGHT: '1',
  80  |       // Suppress GPU / hardware warnings that can stall test output.
  81  |       ELECTRON_ENABLE_LOGGING: '0',
  82  |     },
  83  |   });
  84  | 
  85  |   page = await app.firstWindow();
  86  | 
  87  |   // Inject freeze stylesheet — using evaluate to sidestep Playwright's CSP
  88  |   // check (fontsource data-URI fonts in app CSS cause addStyleTag to throw).
  89  |   await freezeAnimations(page);
  90  | 
  91  |   // Wait for the React root to be mounted — ThemeProvider resolves first,
  92  |   // then App renders. We wait for the .app element + the transport bar.
> 93  |   await page.waitForSelector('.app', { timeout: 30_000 });
      |              ^ Error: page.waitForSelector: Target page, context or browser has been closed
  94  |   await page.waitForSelector('.transport-bar, .titlebar, [class*="transport"]', {
  95  |     timeout: 30_000,
  96  |   });
  97  | 
  98  |   // Settle time — engine worker needs to be ready before cold-state tests run.
  99  |   await page.waitForTimeout(1500);
  100 | });
  101 | 
  102 | test.afterAll(async () => {
  103 |   await app.close();
  104 |   if (FIXTURE_DIR && fs.existsSync(FIXTURE_DIR)) {
  105 |     try { fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
  106 |   }
  107 | });
  108 | 
  109 | // Re-apply freeze CSS after each test (new nodes may have been added).
  110 | // Also close any stray dialogs so subsequent tests get a clean slate.
  111 | test.afterEach(async () => {
  112 |   // Close any open modal via backdrop click, then Escape.
  113 |   await page.evaluate(() => {
  114 |     const backdrop = document.querySelector<HTMLElement>('.export-dialog-backdrop, .dialog-backdrop, [class*="backdrop"]');
  115 |     backdrop?.click();
  116 |   }).catch(() => {});
  117 |   await page.keyboard.press('Escape').catch(() => {});
  118 |   await page.waitForTimeout(150);
  119 |   await freezeAnimations(page).catch(() => {});
  120 | });
  121 | 
  122 | // ── Helpers ───────────────────────────────────────────────────────────────────
  123 | 
  124 | /** Wait for all canvas elements to stop changing (pixel-stable for 300ms). */
  125 | async function waitForCanvasStable(timeout = 8000): Promise<void> {
  126 |   const start = Date.now();
  127 |   let prev = '';
  128 |   while (Date.now() - start < timeout) {
  129 |     const hash = await page.evaluate(() => {
  130 |       const canvases = Array.from(document.querySelectorAll('canvas'));
  131 |       return canvases.map(c => {
  132 |         try {
  133 |           const ctx = c.getContext('2d');
  134 |           if (!ctx) return '';
  135 |           const d = ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
  136 |           return `${c.width}x${c.height}:${d[0]},${d[1]},${d[2]}`;
  137 |         } catch { return ''; }
  138 |       }).join('|');
  139 |     });
  140 |     if (hash === prev && hash !== '') return;
  141 |     prev = hash;
  142 |     await page.waitForTimeout(300);
  143 |   }
  144 | }
  145 | 
  146 | /** Dismiss any open dropdown / context menu. */
  147 | async function dismissMenus(): Promise<void> {
  148 |   await page.keyboard.press('Escape');
  149 |   await page.waitForTimeout(100);
  150 | }
  151 | 
  152 | /**
  153 |  * Load the fixture project into the C++ engine — once per suite run.
  154 |  * Called at the start of test 08 (first fixture-dependent test). All
  155 |  * subsequent tests share the same loaded state via the shared app instance.
  156 |  * The fixture is copied to a temp dir so engine saves don't overwrite the
  157 |  * source fixture files.
  158 |  */
  159 | async function loadFixture(): Promise<void> {
  160 |   if (fixtureLoaded) return;
  161 |   FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xleth-fixture-'));
  162 |   for (const entry of fs.readdirSync(FIXTURE_SRC, { withFileTypes: true })) {
  163 |     if (entry.isFile()) {
  164 |       fs.copyFileSync(path.join(FIXTURE_SRC, entry.name), path.join(FIXTURE_DIR, entry.name));
  165 |     }
  166 |   }
  167 |   try {
  168 |     await page.evaluate(async (dir) => {
  169 |       // @ts-ignore — preload-injected API
  170 |       await window.xleth.project.load(dir);
  171 |     }, FIXTURE_DIR);
  172 |   } catch (e) {
  173 |     console.warn(`[test] Fixture load failed: ${(e as Error).message}`);
  174 |   }
  175 |   // A full page reload is required so that every panel's mount-time fetch
  176 |   // sees the loaded project state. Direct IPC load does not dispatch the
  177 |   // timelineEvents that a normal Open-Project flow does, so canvas panels
  178 |   // (TimelineRuler, TrackHeaders) don't re-render without a reload.
  179 |   await page.reload();
  180 |   await freezeAnimations(page);
  181 |   await page.waitForSelector('.app', { timeout: 30_000 });
  182 |   await page.waitForSelector('.transport-bar, .titlebar, [class*="transport"]', {
  183 |     timeout: 30_000,
  184 |   });
  185 |   await page.waitForTimeout(2000);
  186 |   fixtureLoaded = true;
  187 | }
  188 | 
  189 | /** Open the mixer panel if not already visible. */
  190 | async function openMixer(): Promise<void> {
  191 |   const mixer = page.locator('.mixer-panel').first();
  192 |   if (!(await mixer.isVisible().catch(() => false))) {
  193 |     const btn = page.locator('button[title="Toggle Mixer (M)"]').first();
```