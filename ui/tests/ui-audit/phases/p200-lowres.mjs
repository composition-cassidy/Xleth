// Second pass at 1366x768 (100% UI scale): default layout, Timeline + Piano Roll, Mixer, Sampler.
import { shot } from '../shotlib.mjs';
export default async ({ page, sleep }) => {
  const out = [];
  const DOCK = '[data-testid="xleth-detail-dock"]';
  const step = async (label, fn) => { try { await fn(); } catch (e) { out.push(`${label}: FAIL ${String(e.message).split('\n')[0]}`); await page.keyboard.press('Escape'); } };
  out.push('viewport: ' + JSON.stringify(await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }))));
  await page.mouse.move(700, 600); await sleep(800);
  await step('default', async () => out.push(await shot(page, '200-lowres-default-layout', { surface: 'shell' })));
  const openTab = async (id) => { const t = page.locator(`[data-detail-tab="${id}"]`).first(); if ((await t.getAttribute('aria-selected')) !== 'true') { await t.click(); await sleep(1000); } };
  await step('pianoroll', async () => {
    await openTab('pianoRoll');
    await page.getByText('Pattern 8', { exact: false }).first().dblclick(); await sleep(1300); await page.mouse.move(700, 300); await sleep(400);
    out.push(await shot(page, '201-lowres-timeline-and-pianoroll', { surface: 'dock-pianoroll', scope: null, note: 'Pattern 8 open in the dock' }));
  });
  await step('mixer', async () => { await openTab('mixer'); await page.mouse.move(700, 300); out.push(await shot(page, '202-lowres-mixer', { surface: 'dock-mixer', scope: DOCK })); });
  await step('sampler', async () => {
    await openTab('pianoRoll');
    await page.locator(`${DOCK} button[title^="Sampler Settings"], ${DOCK} button[aria-label^="Sampler Settings"]`).first().click(); await sleep(1400); await page.mouse.move(700, 300);
    out.push(await shot(page, '203-lowres-sampler', { surface: 'dock-sampler', scope: DOCK }));
  });
  await step('devices', async () => { await openTab('devices'); out.push(await shot(page, '204-lowres-devices', { surface: 'dock-devices', scope: DOCK })); });
  await step('fxgraph', async () => { await openTab('fxGraph'); out.push(await shot(page, '205-lowres-fxgraph', { surface: 'dock-fxgraph', scope: DOCK })); });
  return out.join('\n');
};
