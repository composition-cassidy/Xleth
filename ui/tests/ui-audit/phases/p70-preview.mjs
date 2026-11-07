// Preview: playing at 25 / 50 / 100 % render resolution (FPS readout), Edit Grid, Poster vs live.
import { shot } from '../shotlib.mjs';

export default async ({ page, sleep }) => {
  const out = [];
  const TOP = '[data-testid="xleth-dock-region-top"]';
  const step = async (label, fn) => { try { await fn(); } catch (e) { out.push(`${label}: FAIL ${String(e.message).split('\n')[0]}`); await page.keyboard.press('Escape'); } };
  await page.keyboard.up('Control'); await page.keyboard.press('Escape'); await sleep(200);
  // dock collapsed so the Preview has room
  const sel = page.locator('[data-detail-tab][aria-selected="true"]').first();
  if (await sel.count()) { await sel.click(); await sleep(800); }
  const rs = page.locator('select[title^="Preview resolution"]').first();
  const opts = await rs.locator('option').allTextContents();
  out.push('resolution options: ' + opts.join(' | '));
  const play = async () => { await page.locator('button[aria-label="Play"]').first().click(); await sleep(3500); };
  const stop = async () => { await page.locator('button[aria-label="Stop"]').first().click(); await sleep(600); };
  for (const pct of ['25', '50', '100']) {
    await step('res' + pct, async () => {
      const label = opts.find((o) => new RegExp('\\b' + pct + '\\s*%').test(o)) || opts.find((o) => o.includes(pct));
      if (!label) { out.push(`no option for ${pct}%`); return; }
      await rs.selectOption({ label }); await sleep(900);
      await play();
      out.push(await shot(page, `80-preview-playing-${pct}pct`, { surface: 'panel-preview', scope: TOP, live: true, note: `render resolution "${label}", transport playing ~3.5 s` }));
      await stop();
    });
  }
  const auto = opts.find((o) => /auto/i.test(o)); if (auto) await rs.selectOption({ label: auto });
  await sleep(600);

  await step('edit grid', async () => {
    await page.getByRole('button', { name: 'Edit grid', exact: true }).first().click(); await sleep(1200);
    await page.mouse.move(1000, 600); await sleep(400);
    out.push(await shot(page, '83-preview-edit-grid', { surface: 'preview-edit-grid', scope: '[data-testid="xleth-app-workarea"]', note: 'Edit grid on' }));
    await page.getByRole('button', { name: 'Edit grid', exact: true }).first().click(); await sleep(800);
  });

  await step('poster/live', async () => {
    const poster = page.getByRole('button', { name: /^Poster/ }).first();
    const label0 = await poster.textContent();
    await poster.click(); await sleep(1500);
    out.push('poster button after click: ' + (await page.getByRole('button', { name: /^(Poster|Live)/ }).first().textContent()) + ' (was ' + label0 + ')');
    await play();
    out.push(await shot(page, '84-preview-live-mode-playing', { surface: 'panel-preview', scope: TOP, live: true, note: 'Poster preview toggled off (live grid cells), playing' }));
    await stop();
    await page.getByRole('button', { name: /^(Poster|Live)/ }).first().click(); await sleep(800);
  });
  return out.join('\n');
};
