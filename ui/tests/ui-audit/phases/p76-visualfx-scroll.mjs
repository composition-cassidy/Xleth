// Visual FX (continued): the Inspector column scrolled top to bottom, one cropped shot per page (the column is ~364 x 410 px).
import fs from 'node:fs';
import path from 'node:path';
import { shot, metrics } from '../shotlib.mjs';
import { SHOTS } from '../lib.mjs';

export default async ({ page, sleep }) => {
  const out = [];
  // drop the earlier full-window pass
  for (const f of fs.readdirSync(SHOTS)) if (f.startsWith('85-preview-visualfx-')) fs.rmSync(path.join(SHOTS, f));
  for (let i = metrics.length - 1; i >= 0; i--) if (metrics[i].shot.startsWith('85-preview-visualfx-')) metrics.splice(i, 1);
  const info = await page.evaluate(() => {
    document.querySelectorAll('[data-audit-scroller]').forEach((e) => e.removeAttribute('data-audit-scroller'));
    let best = null;
    for (const e of document.querySelectorAll('[data-testid="xleth-dock-region-top"] *')) {
      const cs = getComputedStyle(e);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 8 && e.getBoundingClientRect().x > 1400) { if (!best || e.scrollHeight > best.scrollHeight) best = e; }
    }
    if (!best) return null; best.setAttribute('data-audit-scroller', '1');
    const r = best.getBoundingClientRect();
    return { sh: best.scrollHeight, ch: best.clientHeight, x: r.x, y: r.y, w: r.width, h: r.height };
  });
  out.push('inspector scroller ' + JSON.stringify(info));
  const step = Math.max(200, info.ch - 40);
  const n = Math.ceil(info.sh / step);
  for (let i = 0; i < n; i++) {
    await page.evaluate((y) => { document.querySelector('[data-audit-scroller]').scrollTop = y; }, i * step);
    await sleep(450);
    out.push(await shot(page, `85-preview-visualfx-${String(i + 1).padStart(2, '0')}of${n}`, { surface: 'preview-visual-fx', scope: '[data-audit-scroller]', clip: { x: Math.max(0, info.x - 4), y: info.y, width: Math.min(1920 - info.x + 4, info.w + 8), height: info.h }, note: `Inspector column crop, scroll page ${i + 1}/${n}; every visual effect added to the pitch track` }));
  }
  await page.evaluate(() => { document.querySelector('[data-audit-scroller]').scrollTop = 0; });
  return out.join('\n');
};
