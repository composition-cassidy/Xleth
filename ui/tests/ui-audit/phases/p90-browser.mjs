// Browser (Media / Samples list / Samples grid), SamplePicker sheet during playback, Quick Notation, Split Syllables, Sample Sandbox.
import { shot } from '../shotlib.mjs';
export default async ({ page, sleep }) => {
  const out = [];
  const step = async (label, fn) => { try { await fn(); } catch (e) { out.push(`${label}: FAIL ${String(e.message).split('\n')[0]}`); await page.keyboard.press('Escape'); } };
  await page.keyboard.up('Control'); await page.keyboard.press('Escape'); await sleep(200);
  const sel = page.locator('[data-detail-tab][aria-selected="true"]').first();
  if (await sel.count()) { await sel.click(); await sleep(800); }
  await page.evaluate(() => { const t = [...document.querySelectorAll('[role=tab]')].find((x) => /^Media/.test(x.textContent)); let e = t; while (e && e.getBoundingClientRect().height < 500) e = e.parentElement; if (e) e.setAttribute('data-audit-browser', '1'); });
  const BR = '[data-audit-browser]';
  const tab = async (name) => { await page.getByRole('tab', { name: new RegExp('^' + name) }).first().click(); await sleep(700); };

  await step('media', async () => { await tab('Media'); await page.mouse.move(1000, 700); out.push(await shot(page, '100-browser-media', { surface: 'browser', scope: BR })); });
  await step('samples list', async () => { await tab('Samples'); await page.locator('button[title="List view"], button[aria-label="List view"]').first().click().catch(() => {}); await sleep(500); out.push(await shot(page, '101-browser-samples-list', { surface: 'browser', scope: BR })); });
  await step('samples grid', async () => {
    await page.locator('button[title="Thumbnail view"], button[aria-label="Thumbnail view"]').first().click(); await sleep(900);
    out.push(await shot(page, '102-browser-samples-grid', { surface: 'browser', scope: BR }));
    await page.locator('button[title="List view"], button[aria-label="List view"]').first().click(); await sleep(400);
  });
  await step('picker', async () => {
    await tab('Media');
    await page.getByText(/tiktok_mi/).first().dblclick(); await sleep(2500);
    const sheet = page.locator('[data-testid="picker-sheet"]');
    out.push('picker sheet visible: ' + (await sheet.isVisible().catch(() => false)));
    await page.locator('[data-testid="picker-sheet"]').click({ position: { x: 300, y: 200 }, timeout: 3000 }).catch(() => {});
    await page.keyboard.press('Space'); await sleep(2500);
    out.push(await shot(page, '103-picker-sheet-playing', { surface: 'picker-sheet', scope: '[data-testid="picker-sheet"]', live: true, note: 'sheet open over Preview+Inspector, Space pressed inside the sheet (playing)' }));
    await page.keyboard.press('Space'); await sleep(400);
    await page.keyboard.press('Escape'); await sleep(700);
  });
  // Round 2: the floating tools open from the top bar's Tools menu.
  const tools = async (title) => {
    await page.getByRole('toolbar', { name: 'Panels' }).getByRole('button', { name: 'Tools', exact: true }).click(); await sleep(250);
    await page.getByRole('menuitemcheckbox', { name: title }).first().click(); await sleep(250);
  };
  const floatWin = async (title, name, surface, note) => step(title, async () => {
    await tools(title); await sleep(1400);
    await page.mouse.move(1000, 1000); await sleep(300);
    out.push(await shot(page, name, { surface, scope: '[data-testid="xleth-floating-window-layer"]', note }));
    await tools(title); await sleep(700);
  });
  await floatWin('Quick Notation', '104-quick-notation', 'panel-quicknotation', 'opened from the top bar Tools menu');
  await floatWin('Split Syllables', '105-split-syllables', 'panel-splitsyllables', 'opened from the Tools menu (no sample row selected)');
  await floatWin('Sample Sandbox', '106-sample-sandbox', 'panel-sandbox', 'opened from the Tools menu');
  return out.join('\n');
};
