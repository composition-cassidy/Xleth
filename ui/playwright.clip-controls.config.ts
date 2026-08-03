import { defineConfig } from '@playwright/test'
import fs from 'node:fs'

const systemBrowser = process.platform === 'win32'
  ? [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ].find((candidate) => fs.existsSync(candidate))
  : undefined

export default defineConfig({
  testDir: './tests/clip-controls',
  testMatch: 'visual.spec.ts',
  workers: 1,
  timeout: 30_000,
  snapshotDir: './tests/clip-controls/snapshots',
  snapshotPathTemplate: '{snapshotDir}/{arg}{ext}',
  expect: {
    toHaveScreenshot: { threshold: 0, maxDiffPixelRatio: 0 },
  },
  use: {
    baseURL: 'http://127.0.0.1:5189',
    launchOptions: systemBrowser ? { executablePath: systemBrowser } : undefined,
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
  },
  webServer: {
    command: 'npx vite --config tests/clip-controls/vite.config.js',
    url: 'http://127.0.0.1:5189',
    reuseExistingServer: false,
    timeout: 30_000,
  },
  outputDir: './tests/clip-controls/.output',
})
