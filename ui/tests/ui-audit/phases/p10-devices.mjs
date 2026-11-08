// Devices tab: the chain (scrolled through), the FX picker, and every effect's editor popped out once.
import { shot } from '../shotlib.mjs';
import { openDock, esc, devicePlugins, EFFECT_MENU, PLUGIN_ID } from './common.mjs';

const HOST = '[data-testid="effect-editor-host"]';
const closeTop = (page) => page.evaluate(() => {
  const host = document.querySelector('[data-testid="effect-editor-host"]');
  const last = host && host.lastElementChild;
  if (!last) return false;
  const b = [...last.querySelectorAll('button')].find((x) => { const a = x.getAttribute('aria-label') || x.getAttribute('title') || ''; return a === 'Close' || a.startsWith('Close '); });
  if (!b) return 'nobtn';
  b.click(); return true;
});
async function closeAll(page, sleep) { for (let i = 0; i < 40; i++) { const r = await closeTop(page); if (r === false) return; if (r === 'nobtn') { await page.keyboard.press('Escape'); } await sleep(250); } }
const KIT = new Set(['compressor', 'delay', 'flanger', 'uniflange', 'reverb', 'limiter', 'xletheq', 'glue', 'opto', 'fet', 'varimu', 'gloss', 'apex', 'overdone', 'transientproc', 'resonancesuppressor']);

export default async ({ page, sleep }) => {
  const out = [];
  await closeAll(page, sleep);
  await openDock(page, 'devices');
  await esc(page, 2);
  const scroller = page.locator('[data-testid="xleth-device-chain"]');
  const dims = await scroller.evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth }));
  const pages = Math.max(1, Math.ceil(dims.sw / (dims.cw - 120)));
  for (let i = 0; i < pages; i++) {
    await scroller.evaluate((e, n) => { e.scrollLeft = n; }, i * (dims.cw - 120));
    await sleep(500);
    out.push(await shot(page, `40-devices-chain-${i + 1}of${pages}`, { surface: 'dock-devices', scope: '[data-testid="xleth-detail-dock"]', note: `chain scrollWidth ${dims.sw}` }));
  }
  // FX picker open
  await scroller.evaluate((e) => { e.scrollLeft = e.scrollWidth; }); await sleep(400);
  const z = page.getByText('Drop effects here').first();
  await page.mouse.move(900, 300);
  await z.evaluate((e) => (e.closest('button,[role=button]') || e).focus());
  await page.keyboard.press('Enter'); await sleep(400);
  await page.keyboard.press('ArrowDown'); await sleep(150); await page.keyboard.press('ArrowRight'); await sleep(150); await page.keyboard.press('Enter'); await sleep(400);
  out.push(await shot(page, '41-devices-fx-picker-open', { surface: 'fx-picker-chain', scope: '[role="menu"]', live: true, note: 'Dynamics submenu open; drop zone at the window right edge' }));
  await esc(page, 3);
  await scroller.evaluate((e) => { e.scrollLeft = 0; }); await sleep(300);

  // Each effect popped out once
  let n = 42;
  const all = Object.values(PLUGIN_ID);
  all.unshift('xletheq');
  for (const id of all) {
    const name = `${String(n).padStart(2, '0')}-device-popout-${id}`;
    try {
      const d = page.locator(`[data-device-plugin="${id}"][data-presentation="docked"]`).first();
      await d.scrollIntoViewIfNeeded(); await sleep(250);
      const open = d.locator('button[aria-label^="Open "][aria-label$=" in a window"], button[aria-label^="Pop out"]').first();
      await open.click({ timeout: 4000 });
      await sleep(1400);
      out.push(await shot(page, name, { surface: KIT.has(id) ? 'device-floating' : 'fx-' + id, scope: HOST + ' > :last-child', note: KIT.has(id) ? 'kit device popped out (FloatingDevice)' : 'legacy editor in its own window' }));
      await closeAll(page, sleep);
      n += 1;
    } catch (e) { out.push(`${id}: FAIL ${String(e.message).split('\n')[0]}`); await esc(page, 2); n += 1; }
  }
  out.push('chain: ' + (await devicePlugins(page)).length + ' devices');
  return out.join('\n');
};
