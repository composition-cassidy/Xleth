import { defineConfig } from '@playwright/test';
import path from 'path';

export default defineConfig({
  testDir: './tests/baseline',
  // Baseline captures are sequential — parallel introduces race conditions
  // with the Electron window lifecycle (only one main window per launch).
  workers: 1,
  // Keep snapshots next to the spec so they're easy to review in the diff.
  snapshotDir: './tests/baseline/snapshots',
  // Electron launch is slow (addon init ≈ 3s); give each test generous time.
  timeout: 60_000,
  expect: {
    // Pixel-identical requirement per Phase 0 spec.
    // threshold=0 → zero per-channel tolerance (same pixel value required).
    // maxDiffPixelRatio=0.01 → up to 1% of pixels may differ (only matters
    // for the self-check; during migration even 0 diff is the goal).
    toHaveScreenshot: {
      threshold: 0,
      maxDiffPixelRatio: 0.01,
    },
  },
  use: {
    // Screenshots saved as PNG, no clip by default.
    screenshot: 'only-on-failure',
  },
  // Output dir for traces/videos on failure.
  outputDir: './tests/baseline/.output',
  // Shared baseline — no OS suffix, per Phase 0 plan.
  snapshotPathTemplate: '{snapshotDir}/{testFilePath}/{arg}{ext}',
});
