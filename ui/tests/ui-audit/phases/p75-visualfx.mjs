// Visual FX: every visual effect added to the selected track's chain through "+ add effect", then the Inspector scrolled through.
import { shot } from '../shotlib.mjs';

export default async ({ page, sleep }) => {
  const out = [];
  const TOP = '[data-testid="xleth-dock-region-top"]';
  await page.keyboard.up('Control'); await page.keyboard.press('Escape'); await sleep(200);
  const sel = page.locator('[data-detail-tab][aria-selected="true"]').first();
  if (await sel.count()) { await sel.click(); await sleep(800); }
  // Enlarge the top region (Preview + Inspector) by dragging its lower splitter.
  const r = await page.locator('[data-testid="xleth-dock-region-resizer-top"]').first().boundingBox();
  await page.mouse.move(r.x + 700, r.y + 4); await page.mouse.down(); await page.mouse.move(r.x + 700, 760, { steps: 14 }); await page.mouse.up(); await sleep(900);
  await page.locator('.track-header', { hasText: 'pitch' }).last().click({ position: { x: 60, y: 14 } }).catch(() => {}); await sleep(600);

  const NC = ['Bounce', 'Zoom/Pan/Rot', 'Ping-Pong Loop'];
  const C = ['Desaturation', 'Tint', 'Brightness & Contrast', 'TV Simulator', 'Zoom/Pan/Rot (per-cell)', 'Chroma Key', 'Outline', 'Drop Shadow', 'Visual Echo'];
  for (const label of [...NC, ...C]) {
    try {
      const add = page.getByRole('button', { name: /add effect/ }).first();
      await add.scrollIntoViewIfNeeded(); await add.click({ timeout: 4000 }); await sleep(350);
      await page.locator('.fx-dropdown-item', { hasText: new RegExp('^\\s*✓?\\s*' + label.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '\\s*$') }).first().click({ timeout: 3000 });
      await sleep(600);
      out.push('added ' + label);
    } catch (e) { out.push(`${label}: FAIL ${String(e.message).split('\n')[0]}`); await page.keyboard.press('Escape'); await sleep(200); }
    await page.keyboard.press('Escape');
  }
  await page.mouse.move(900, 900); await sleep(500);

  // Scroll the Inspector (largest scrollable inside the top region's right column)
  const info = await page.evaluate((top) => {
    const t = document.querySelector(top); let best = null;
    for (const e of t.querySelectorAll('*')) {
      const cs = getComputedStyle(e);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 8 && e.getBoundingClientRect().x > 1400) { if (!best || e.scrollHeight > best.scrollHeight) best = e; }
    }
    if (!best) return null; best.setAttribute('data-audit-scroller', '1'); return { sh: best.scrollHeight, ch: best.clientHeight };
  }, TOP);
  out.push('inspector scroller ' + JSON.stringify(info));
  const n = info ? Math.min(8, Math.ceil(info.sh / Math.max(200, info.ch - 60))) : 1;
  for (let i = 0; i < n; i++) {
    if (info) await page.evaluate((y) => { document.querySelector('[data-audit-scroller]').scrollTop = y; }, i * (info.ch - 60));
    await sleep(500);
    out.push(await shot(page, `85-preview-visualfx-${i + 1}of${n}`, { surface: 'preview-visual-fx', scope: '[data-audit-scroller]', note: 'Inspector (track) scrolled; every visual effect added to the chain' }));
  }
  if (info) await page.evaluate(() => document.querySelector('[data-audit-scroller]').scrollTop = 0);
  return out.join('\n');
};
