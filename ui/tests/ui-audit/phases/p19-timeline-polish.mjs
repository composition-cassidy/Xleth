// Round 2 step 19: the surfaces the 2026-11-07 run did not reach. Tall lanes with fades, the clip FX editors, the video canvas
// popover and a macro automation lane. Shot names keep the 153-158 numbers MANUAL-SHOTS.md reserved for them.
import { shot } from '../shotlib.mjs';

export default async ({ page, sleep }) => {
  const out = [];
  const esc = async (n = 3) => { for (let i = 0; i < n; i++) { await page.keyboard.press('Escape'); await sleep(150); } };
  const step = async (label, fn) => { try { await fn(); } catch (e) { out.push(`${label}: FAIL ${String(e.message).split('\n')[0]}`); await esc(); } };
  const ROOT = '[data-testid="xleth-docked-window-layer"]';
  const laneH = () => page.evaluate(() => [...document.querySelectorAll('.track-header')].map((e) => Math.round(e.getBoundingClientRect().height)).filter((h) => h > 0).sort((a, b) => a - b)[0]);
  await esc();
  const sel = page.locator('[data-detail-tab][aria-selected="true"]').first();
  if (await sel.count()) { await sel.click(); await sleep(700); }

  // Lane height: Alt+wheel over the canvas, toward 80px.
  await step('height', async () => {
    await page.mouse.move(1000, 560);
    for (let i = 0; i < 30; i++) {
      const h = await laneH();
      if (h >= 78 && h <= 90) break;
      await page.keyboard.down('Alt');
      await page.mouse.wheel(0, h < 78 ? -40 : 40);
      await page.keyboard.up('Alt'); await sleep(200);
    }
    out.push('lane height now: ' + await laneH());
  });
  await step('154', async () => {
    const y = await page.evaluate(() => { const r = [...document.querySelectorAll('.track-header')][3]?.getBoundingClientRect(); return r ? r.y + r.height / 2 : 560; });
    await page.mouse.move(1200, y); await sleep(400);
    await page.mouse.click(1200, y); await sleep(700);
    out.push(await shot(page, '154-timeline-lane-80-fades-handles', { surface: 'panel-timeline', scope: ROOT, note: 'Alt+wheel to an 80px lane, a clip selected' }));
  });

  // Clip FX editors: the Inspector's Edit buttons.
  for (const [idx, name] of [[0, '157-clip-fx-editor-vibrato'], [1, '158-clip-fx-editor-scratch']]) {
    await step(name, async () => {
      await page.locator('button[data-hint^="Open the"]').nth(idx).click(); await sleep(900);
      const r = await page.evaluate(() => { const h = document.querySelector('[data-testid="clip-fx-editor-host"]'); const k = h ? [...h.children].map((c) => ({ c: String(c.className).slice(0, 50), w: c.getBoundingClientRect().width, h: c.getBoundingClientRect().height })) : null; return k; });
      out.push(name + ' host children: ' + JSON.stringify(r));
      out.push(await shot(page, name, { surface: 'clip-fx-editor', scope: '[data-testid="clip-fx-editor-host"] > *', live: true }));
      await esc();
      out.push(name + ' still open after Esc: ' + await page.locator('[data-testid="clip-fx-editor-host"] > *').count());
    });
  }

  // Video canvas popover: Preview header "Edit grid", then the canvas button in the rail.
  await step('canvas', async () => {
    await page.getByRole('button', { name: /Edit grid/ }).first().click(); await sleep(900);
    const b = page.locator('button[data-hint^="Project canvas"]').first();
    out.push('canvas buttons: ' + await b.count());
    await b.click(); await sleep(800);
    out.push(await shot(page, '155-timeline-video-canvas-settings-popover', { surface: 'timeline-canvas-popover', scope: '.tl-display-root > *', live: true }));
    await esc();
    await page.getByRole('button', { name: /Edit grid/ }).first().click(); await sleep(500);
  });
  return out.join('\n');
};
