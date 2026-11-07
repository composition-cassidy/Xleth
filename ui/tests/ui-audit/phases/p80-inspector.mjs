// Inspector: track selected, clip selected, pattern selected, nothing selected.
import { shot } from '../shotlib.mjs';
export default async ({ page, sleep }) => {
  const out = [];
  const step = async (label, fn) => { try { await fn(); } catch (e) { out.push(`${label}: FAIL ${String(e.message).split('\n')[0]}`); await page.keyboard.press('Escape'); } };
  const INS = '[data-testid^="xleth-inspector"]';
  await page.keyboard.up('Control'); await page.keyboard.press('Escape'); await sleep(200);
  const sel = page.locator('[data-detail-tab][aria-selected="true"]').first();
  if (await sel.count()) { await sel.click(); await sleep(800); }
  // normalise: playhead and view back to the start (drag the horizontal scrollbar thumb to the far left)
  await page.locator('button[aria-label="Rewind"]').first().click().catch(() => {}); await sleep(500);
  const thumb = await page.evaluate(() => { const c = [...document.querySelectorAll('*')].filter((e) => { const r = e.getBoundingClientRect(); return r.y > 1008 && r.y < 1030 && r.width > 20 && r.width < 400 && r.height > 6 && r.height < 20 && r.x > 580; }); const t = c[0]; if (!t) return null; const r = t.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  if (thumb) { await page.mouse.move(thumb.x, thumb.y); await page.mouse.down(); await page.mouse.move(300, thumb.y, { steps: 10 }); await page.mouse.up(); await sleep(900); }
  out.push('scroll thumb: ' + JSON.stringify(thumb));
  const ids = async () => (await page.evaluate(() => [...document.querySelectorAll('[data-testid^="xleth-inspector"]')].map((e) => e.dataset.testid))).join(',');
  await step('track', async () => {
    await page.locator('.track-header', { hasText: 'ch2' }).first().click({ position: { x: 60, y: 14 } }); await sleep(800);
    out.push('ids: ' + await ids());
    out.push(await shot(page, '90-inspector-track-selected', { surface: 'panel-inspector', scope: INS, note: 'ch2 (clip track) header clicked' }));
  });
  await step('clip', async () => {
    await page.mouse.click(660, 592); await sleep(800);
    out.push('ids: ' + await ids());
    out.push(await shot(page, '91-inspector-clip-selected', { surface: 'panel-inspector', scope: INS, note: 'ch1 clip clicked' }));
  });
  await step('pattern', async () => {
    // bring the first pattern blocks (about bar 22) into view by dragging the horizontal scrollbar thumb
    const th2 = await page.evaluate(() => { const c = [...document.querySelectorAll('*')].filter((e) => { const r = e.getBoundingClientRect(); return r.y > 1008 && r.y < 1030 && r.width > 20 && r.width < 400 && r.height > 6 && r.height < 20 && r.x > 580; }); const r = c[0]?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; });
    if (th2) { await page.mouse.move(th2.x, th2.y); await page.mouse.down(); await page.mouse.move(th2.x + 122, th2.y, { steps: 8 }); await page.mouse.up(); await sleep(900); }
    await page.mouse.click(1000, 738); await sleep(800);
    if (!/blocks|pattern/i.test(await ids())) { await page.locator('.track-header', { hasText: 'pitch' }).last().click({ position: { x: 60, y: 14 } }); await sleep(800); out.push('block click missed; fell back to the pattern TRACK header'); }
    out.push('ids: ' + await ids());
    out.push(await shot(page, '92-inspector-pattern-selected', { surface: 'panel-inspector', scope: INS, note: 'pattern track (pitch) selected; a pattern-block click was attempted first' }));
  });
  // "Nothing selected": every attempt to clear the selection is tried and the Inspector's own state is recorded.
  await step('none', async () => {
    const tries = [['Escape', () => page.keyboard.press('Escape')], ['click ruler', () => page.mouse.click(1300, 492)], ['click empty lane below tracks', () => page.mouse.click(1400, 1000)]];
    for (const [n, fn] of tries) { await fn(); await sleep(600); const i = await ids(); out.push(`clear via ${n}: ${i}`); if (/empty/.test(i)) break; }
    if (/empty/.test(await ids())) out.push(await shot(page, '93-inspector-nothing-selected', { surface: 'panel-inspector', scope: INS, note: 'selection cleared' }));
    else out.push('93: nothing-selected state not reachable after a track/clip was selected; the empty Inspector is visible in 01-shell-default-dock-collapsed.png (project just loaded)');
  });
  return out.join('\n');
};
