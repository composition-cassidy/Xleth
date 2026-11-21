// FX Graph: ch1's graph, then Macro / Envelope / LFO / Sidechain Input nodes added through the canvas add menu.
import { shot } from '../shotlib.mjs';

export default async ({ page, sleep }) => {
  const out = [];
  const DOCK = '[data-testid="xleth-detail-dock"]';
  const step = async (label, fn) => { try { await fn(); } catch (e) { out.push(`${label}: FAIL ${String(e.message).split('\n')[0]}`); await page.keyboard.press('Escape'); } };
  await page.keyboard.up('Control'); await page.keyboard.press('Escape'); await sleep(200);
  const mt = page.locator('[data-detail-tab="mixer"]').first();
  if ((await mt.getAttribute('aria-selected')) !== 'true') { await mt.click(); await sleep(900); }
  await page.locator(`${DOCK} [class*="strip"]`).filter({ hasText: /^2\s*ch1/ }).first().click({ position: { x: 30, y: 14 } }); await sleep(500);
  await page.locator('[data-detail-tab="fxGraph"]').first().click(); await sleep(1500);
  await page.mouse.move(1000, 250);
  const info = await page.evaluate((d) => { const e = document.querySelector(d); return { text: e.innerText.replace(/\n+/g, ' | ').slice(0, 400), nodes: e.querySelectorAll('.react-flow__node, [data-graph-node], [class*="graph-node"]').length }; }, DOCK);
  out.push(JSON.stringify(info));
  await step('70a', async () => out.push(await shot(page, '70-fxgraph-ch1-initial', { surface: 'dock-fxgraph', scope: DOCK, note: 'ch1 graph before adding nodes' })));

  const canvas = await page.evaluate((d) => { const e = document.querySelector(d); const c = e.querySelector('.react-flow__pane, [class*="canvas"], [class*="graph"]'); const r = (c || e).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cls: c ? String(c.className).slice(0, 40) : null }; }, DOCK);
  out.push('canvas ' + JSON.stringify(canvas));
  const addNode = async (label, dx, dy) => {
    await page.mouse.click(canvas.x + dx, canvas.y + dy, { button: 'right' }); await sleep(500);
    // Pointer activation of the Modulators items is not delivered by the harness (focus + Enter is); see COMPARE.md "Found while capturing".
    const it = page.getByRole('menuitem', { name: label, exact: true }).first();
    await it.focus({ timeout: 4000 }); await page.keyboard.press('Enter'); await sleep(900);
  };
  await step('menu', async () => {
    await page.mouse.click(canvas.x + canvas.w * 0.55, canvas.y + canvas.h * 0.35, { button: 'right' }); await sleep(600);
    out.push(await shot(page, '72-fxgraph-canvas-add-menu', { surface: 'fxgraph-add-menu', scope: '[role="menu"]', live: true }));
    await page.keyboard.press('Escape'); await sleep(300);
  });
  await step('macro', () => addNode('Macro', canvas.w * 0.3, canvas.h * 0.2));
  await step('lfo', () => addNode('LFO', canvas.w * 0.42, canvas.h * 0.3));
  await step('env', () => addNode('Envelope', canvas.w * 0.62, canvas.h * 0.3));
  await step('sc', () => addNode('Sidechain input', canvas.w * 0.15, canvas.h * 0.7));
  await page.mouse.move(1000, 250); await sleep(500);
  await step('70b', async () => out.push(await shot(page, '71-fxgraph-several-nodes', { surface: 'dock-fxgraph', scope: DOCK, note: 'macro, LFO, envelope and sidechain-input nodes added via the canvas menu' })));
  await step('picker', async () => {
    await page.mouse.click(canvas.x + canvas.w * 0.8, canvas.y + canvas.h * 0.25, { button: 'right' }); await sleep(500);
    // One picker: the graph's add menu embeds the Devices chain's list, so a category opens its submenu.
    await page.getByRole('menuitem', { name: /^Dynamics/ }).first().hover({ timeout: 4000 }); await sleep(600);
    out.push(await shot(page, '73-fxgraph-effect-picker-open', { surface: 'fx-picker-graph', scope: '[role="menu"]', live: true }));
    await page.keyboard.press('Escape'); await sleep(400);
  });
  // The envelope and LFO editors were never captured before round 2: each opens in its own sheet.
  await step('lfo-editor', async () => {
    await page.getByRole('button', { name: /^Edit .* LFO$/ }).first().click({ timeout: 4000 }); await sleep(700);
    out.push(await shot(page, '74a-fxgraph-lfo-editor', { surface: 'fx-lfo-editor', scope: '[data-testid="fx-lfo-sheet"]', live: true }));
    await page.keyboard.press('Escape'); await sleep(300);
  });
  await step('env-editor', async () => {
    await page.getByRole('button', { name: /^Edit .* envelope$/ }).first().click({ timeout: 4000 }); await sleep(700);
    out.push(await shot(page, '74b-fxgraph-envelope-editor', { surface: 'fx-envelope-editor', scope: '[data-testid="fx-envelope-sheet"]', live: true }));
    await page.keyboard.press('Escape'); await sleep(300);
  });
  return out.join('\n');
};
