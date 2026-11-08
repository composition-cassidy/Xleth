// Timeline popovers and the Convert dialog: track colour, timeline display, video canvas settings, Convert to Pattern Track.
import { shot } from '../shotlib.mjs';
export default async ({ page, sleep }) => {
  const out = [];
  const esc = async () => { for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await sleep(150); } };
  const step = async (label, fn) => { try { await fn(); } catch (e) { out.push(`${label}: FAIL ${String(e.message).split('\n')[0]}`); await esc(); } };
  await esc();
  const sel = page.locator('[data-detail-tab][aria-selected="true"]').first();
  if (await sel.count()) { await sel.click(); await sleep(700); }
  const popRoot = () => page.evaluate(() => {
    document.querySelectorAll('[data-audit-pop]').forEach((e) => e.removeAttribute('data-audit-pop'));
    const c = [...document.querySelectorAll('[class*="popover"], [role="dialog"], [class*="-pop"], [role="menu"]')].filter((e) => e.checkVisibility() && e.getBoundingClientRect().width > 80);
    const t = c.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0];
    if (t) { t.setAttribute('data-audit-pop', '1'); return String(t.className).slice(0, 40); }
    return null;
  });
  await step('color', async () => {
    await page.locator('button[aria-label="Change track color"]').first().click(); await sleep(700);
    out.push('root: ' + await popRoot());
    out.push(await shot(page, '140-timeline-track-color-popover', { surface: 'timeline-color-popover', scope: '[data-audit-pop]', live: true }));
    await esc();
  });
  await step('display', async () => {
    await page.locator('button[aria-label="Timeline display settings"], button[title="Timeline display settings"]').first().click(); await sleep(700);
    out.push('root: ' + await popRoot());
    out.push(await shot(page, '141-timeline-display-popover', { surface: 'timeline-display-popover', scope: '[data-audit-pop]', live: true }));
    await esc();
  });
  await step('canvas', async () => {
    // The project canvas popover is reached from the Edit grid rail: Edit grid, then the canvas button.
    await page.getByRole('button', { name: /Edit grid/ }).first().click(); await sleep(900);
    await page.locator('button[data-hint^="Project canvas"]').first().click({ timeout: 4000 }); await sleep(800);
    out.push('root: ' + await popRoot());
    out.push(await shot(page, '142-timeline-video-canvas-popover', { surface: 'timeline-canvas-popover', scope: '[data-audit-pop]', live: true }));
    await esc();
    await page.getByRole('button', { name: /Edit grid/ }).first().click().catch(() => {}); await sleep(400);
  });
  await step('convert', async () => {
    await page.locator('.track-header', { hasText: 'ch1' }).first().click({ button: 'right', position: { x: 60, y: 14 } }); await sleep(600);
    await page.getByRole('menuitem', { name: /Convert to Pattern Track/ }).first().click(); await sleep(900);
    out.push('dialogs: ' + await page.locator('[role="dialog"]').count());
    out.push(await shot(page, '143-dialog-convert-track', { surface: 'timeline-convert', scope: '[role="dialog"]', live: true }));
    await esc();
    await page.getByRole('button', { name: /^Cancel/ }).first().click({ timeout: 1000 }).catch(() => {});
  });
  return out.join('\n');
};
