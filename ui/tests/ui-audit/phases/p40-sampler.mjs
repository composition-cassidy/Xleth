// Sampler (SamplerPanelContent): MAIN and PLAYBACK tabs, scrolled through completely. Opened from the Piano Roll's "Sampler Settings".
import { shot } from '../shotlib.mjs';

export default async ({ page, sleep }) => {
  const out = [];
  const DOCK = '[data-testid="xleth-detail-dock"]';
  await page.keyboard.up('Control'); await page.keyboard.press('Escape'); await sleep(200);
  const prTab = page.locator('[data-detail-tab="pianoRoll"]').first();
  if ((await prTab.getAttribute('aria-selected')) !== 'true') { await prTab.click(); await sleep(800); }
  await page.locator(`${DOCK} button[title^="Sampler Settings"], ${DOCK} button[aria-label^="Sampler Settings"]`).first().click(); await sleep(1200);
  await page.mouse.move(1000, 300);

  const scrollerInfo = () => page.evaluate((dock) => {
    const d = document.querySelector(dock);
    let best = null;
    for (const e of d.querySelectorAll('*')) {
      const cs = getComputedStyle(e);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 8) {
        if (!best || e.scrollHeight > best.scrollHeight) best = e;
      }
    }
    if (!best) return null;
    best.setAttribute('data-audit-scroller', '1');
    return { sh: best.scrollHeight, ch: best.clientHeight, cls: String(best.className).slice(0, 40) };
  }, DOCK);

  for (const tabName of ['MAIN', 'PLAYBACK']) {
    try {
      await page.locator(`${DOCK} [role="tab"], ${DOCK} button`).filter({ hasText: new RegExp('^' + tabName + '$', 'i') }).first().click({ timeout: 4000 });
      await sleep(900);
      await page.evaluate(() => document.querySelectorAll('[data-audit-scroller]').forEach((e) => e.removeAttribute('data-audit-scroller')));
      const info = await scrollerInfo();
      out.push(`${tabName} scroller: ${JSON.stringify(info)}`);
      const n = info ? Math.ceil(info.sh / Math.max(200, info.ch - 80)) : 1;
      for (let i = 0; i < n; i++) {
        if (info) await page.evaluate((y) => { document.querySelector('[data-audit-scroller]').scrollTop = y; }, i * (info.ch - 80));
        await sleep(500);
        out.push(await shot(page, `3${tabName === 'MAIN' ? 0 : 5}-sampler-${tabName.toLowerCase()}-${i + 1}of${n}`, { surface: 'dock-sampler', scope: DOCK, note: `scrollTop step ${i + 1}/${n}` }));
      }
      if (info) await page.evaluate(() => { document.querySelector('[data-audit-scroller]').scrollTop = 0; });
    } catch (e) { out.push(`${tabName}: FAIL ${String(e.message).split('\n')[0]}`); }
  }
  return out.join('\n');
};
