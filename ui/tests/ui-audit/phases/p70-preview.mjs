// Preview: playing at 25 / 50 / 100 % render resolution (FPS readout), Edit Grid, Poster vs live.
// Round 2: resolution and quality live in the Preview header's View menu.
import { shot } from '../shotlib.mjs';

export default async ({ page, sleep }) => {
  const out = [];
  const TOP = '[data-testid="xleth-dock-region-top"]';
  const step = async (label, fn) => { try { await fn(); } catch (e) { out.push(`${label}: FAIL ${String(e.message).split('\n')[0]}`); await page.keyboard.press('Escape'); } };
  await page.keyboard.up('Control'); await page.keyboard.press('Escape'); await sleep(200);
  // dock collapsed so the Preview has room
  const sel = page.locator('[data-detail-tab][aria-selected="true"]').first();
  if (await sel.count()) { await sel.click(); await sleep(800); }
  const viewButton = () => page.locator('[data-testid="preview-header"]').getByRole('button', { name: 'View', exact: true });
  const pick = async (name) => {
    await viewButton().click(); await sleep(250);
    await page.getByRole('menuitemcheckbox', { name, exact: false }).first().click(); await sleep(900);
  };
  const play = async () => { await page.locator('button[aria-label="Play"]').first().click(); await sleep(3500); };
  const stop = async () => { await page.locator('button[aria-label="Stop"]').first().click(); await sleep(600); };
  for (const pct of ['25', '50', '100']) {
    await step('res' + pct, async () => {
      await pick(pct + '%');
      await play();
      out.push(await shot(page, `80-preview-playing-${pct}pct`, { surface: 'panel-preview', scope: TOP, live: true, note: `render resolution ${pct}% (View > Resolution), transport playing ~3.5 s` }));
      await stop();
    });
  }
  await pick('Auto'); await sleep(600);

  await step('edit grid', async () => {
    await page.getByRole('button', { name: 'Edit grid', exact: true }).first().click(); await sleep(1200);
    await page.mouse.move(1000, 600); await sleep(400);
    out.push(await shot(page, '83-preview-edit-grid', { surface: 'preview-edit-grid', scope: '[data-testid="xleth-app-workarea"]', note: 'Edit grid on' }));
    await page.getByRole('button', { name: 'Edit grid', exact: true }).first().click(); await sleep(800);
  });

  await step('poster/live', async () => {
    const chip = () => page.locator('[data-testid="preview-header"] [data-hint^="Poster frames"]').count();
    out.push('poster chip before: ' + (await chip()));
    await pick('Live frames'); await sleep(600);
    out.push('poster chip after choosing Live frames: ' + (await chip()));
    await play();
    out.push(await shot(page, '84-preview-live-mode-playing', { surface: 'panel-preview', scope: TOP, live: true, note: 'Quality = Live frames (View > Quality), playing' }));
    await stop();
    await pick('Poster frames'); await sleep(600);
  });
  return out.join('\n');
};
