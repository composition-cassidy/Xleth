import { shot } from '../shotlib.mjs';
export default async ({ page, sleep }) => {
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await sleep(150); }
  await page.locator('button[aria-label="Change track color"]').first().click(); await sleep(700);
  const s = await shot(page, '140-timeline-track-color-popover', { surface: 'timeline-color-popover', scope: '.track-color-popover', live: true });
  await page.keyboard.press('Escape'); await sleep(300);
  // canvas settings: list toolbar buttons to find the entry point
  const btns = await page.evaluate(() => [...document.querySelectorAll('[role="toolbar"] button, .tab-icon-btn')].map((b) => (b.title || b.getAttribute('aria-label') || '').slice(0, 50)));
  return s + '\n' + JSON.stringify(btns);
};
