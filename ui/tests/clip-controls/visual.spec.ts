import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true')
})

test('production preview matrix', async ({ page }) => {
  await expect(page.getByTestId('preview-matrix')).toHaveScreenshot('clip-control-preview-matrix.png')
})

test('timeline gain and fade edge states', async ({ page }) => {
  await expect(page.getByTestId('timeline-cases')).toHaveScreenshot('clip-control-timeline-cases.png')
})
