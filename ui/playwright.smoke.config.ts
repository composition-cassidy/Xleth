import { defineConfig } from '@playwright/test';

// Electron main-process smoke suite (tests/smoke). Separate from the screenshot
// baseline (playwright.config.ts / tests/baseline) — no snapshots, no pixel
// comparison, just boot / worker-ready / IPC round-trip against the real app.
export default defineConfig({
  testDir: './tests/smoke',
  // One Electron instance, sequential — only one main window per launch.
  workers: 1,
  fullyParallel: false,
  // Cold start forks the engine worker + inits the native addon (~3 s) before
  // the main window exists; the ready poll can run up to 60 s. Give headroom.
  timeout: 90_000,
  // A boot smoke test that flakes is a broken boot — surface it, don't paper
  // over it with retries.
  retries: 0,
  reporter: 'list',
  outputDir: './tests/smoke/.output',
});
