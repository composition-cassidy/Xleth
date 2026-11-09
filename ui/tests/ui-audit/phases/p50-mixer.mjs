// Mixer: populated strips, a sidechain route (set through the Compressor device), a selected strip, meters during playback.
import { shot } from '../shotlib.mjs';

export default async ({ page, sleep }) => {
  const out = [];
  const DOCK = '[data-testid="xleth-detail-dock"]';
  const step = async (label, fn) => { try { await fn(); } catch (e) { out.push(`${label}: FAIL ${String(e.message).split('\n')[0]}`); await page.keyboard.press('Escape'); } };
  await page.keyboard.up('Control'); await page.keyboard.press('Escape'); await sleep(200);

  // Sidechain: the base track's compressor listens to KICK (set through the Compressor device UI).
  const host = page.locator('[data-testid="effect-editor-host"]');
  const closeWins = () => page.evaluate(() => { const h = document.querySelector('[data-testid="effect-editor-host"]'); for (let i = 0; i < 20 && h.lastElementChild; i++) { const l = h.lastElementChild; const b = [...l.querySelectorAll('button')].find((x) => /^Close/.test(x.getAttribute('aria-label') || x.title || '')); if (!b) break; b.click(); } });
  await closeWins(); await sleep(400);
  await step('sidechain', async () => {
    const mt0 = page.locator('[data-detail-tab="mixer"]').first();
    out.push('sc step 1 ok');
    if ((await mt0.getAttribute('aria-selected')) !== 'true') { await mt0.click(); await sleep(900); }
    out.push('sc step 2 ok');
    await page.locator(`${DOCK} [class*="strip"]`).filter({ hasText: /^1\s*base/ }).first().click({ position: { x: 30, y: 14 } }); await sleep(500);
    out.push('sc step 3 ok');
    await page.locator('[data-detail-tab="devices"]').first().click(); await sleep(900);
    out.push('sc step 4 ok');
    const d = page.locator('[data-device-plugin="compressor"][data-presentation="docked"]').first();
    out.push('sc step 5 ok');
    await d.scrollIntoViewIfNeeded({ timeout: 5000 });
    out.push('sc step 6 ok');
    await d.locator('button[aria-label^="Open "][aria-label$=" in a window"]').first().click(); await sleep(1200);
    out.push('sc step 7 ok');
    const show = host.getByRole('button', { name: 'Show Sidechain' });
    out.push('sc step 8 ok');
    if (await show.count()) { await show.first().click(); await sleep(600); }
    out.push('sc step 9 ok');
    await host.getByRole('button', { name: 'External' }).first().click(); await sleep(600);
    out.push('sc step 10 ok');
    await host.getByRole('button', { name: /Sidechain source/ }).first().click(); await sleep(500);
    out.push('sc step 11 ok');
    await page.getByRole('option', { name: 'KICK', exact: true }).first().click(); await sleep(700);
    out.push('sc step 12 ok');
    out.push(await shot(page, '97-compressor-sidechain-external-kick', { surface: 'device-floating', scope: '[data-testid="effect-editor-host"] > :last-child', note: 'sidechain section open, External on, source KICK' }));
    await closeWins(); await sleep(500);
    out.push('sc step 13 ok');
  });

  const mt = page.locator('[data-detail-tab="mixer"]').first();
  if ((await mt.getAttribute('aria-selected')) !== 'true') { await mt.click(); await sleep(1000); }
  await page.mouse.move(1000, 250); await sleep(500);
  await step('50', async () => out.push(await shot(page, '94-mixer-routing-sidechain', { surface: 'dock-mixer', scope: DOCK, note: 'compressor sidechain source set to KICK in base chain' })));
  await step('51', async () => {
    await page.locator(`${DOCK} [class*="strip"]`).filter({ hasText: /^7\s*KICK/ }).first().click({ position: { x: 30, y: 14 } });
    await sleep(700);
    out.push(await shot(page, '95-mixer-strip-selected', { surface: 'dock-mixer', scope: DOCK, note: 'KICK strip selected' }));
  });
  await step('52', async () => {
    await page.locator('button[aria-label="Play"]').first().click(); await sleep(3500);
    out.push(await shot(page, '96-mixer-meters-playing', { surface: 'dock-mixer', scope: DOCK, live: true, note: 'transport playing ~3.5 s' }));
    await page.locator('button[aria-label="Stop"]').first().click(); await sleep(600);
  });
  return out.join('\n');
};
