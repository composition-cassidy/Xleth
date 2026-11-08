// Timeline: default, zoomed, selection, mute, folder row, context menus, toolbar.
import { shot } from '../shotlib.mjs';

export default async ({ page, sleep }) => {
  const out = [];
  const esc = async (n = 2) => { for (let i = 0; i < n; i++) { await page.keyboard.press('Escape'); await sleep(150); } };
  const step = async (label, fn) => { try { await fn(); } catch (e) { out.push(`${label}: FAIL ${String(e.message).split('\n')[0]}`); await esc(); } };
  const rd = async () => parseFloat(await page.locator('.timeline-zoom-display').first().textContent());
  const stable = async () => { let p = -1; for (let i = 0; i < 30; i++) { const v = await rd(); if (v === p) return v; p = v; await sleep(250); } return p; };
  // Ctrl+wheel over the canvas zooms (about x1.2 per 240 units); the readout follows a spring, so wait for it to settle.
  const zoomTo = async (target) => {
    await page.keyboard.up('Control');
    await page.mouse.move(1000, 480);
    for (let pass = 0; pass < 6; pass++) {
      const v = await stable();
      if (Math.abs(v - target) / target < 0.15) return v;
      const ticks = Math.max(1, Math.round(Math.abs(Math.log(target / v) / Math.log(1.2))));
      await page.keyboard.down('Control');
      for (let i = 0; i < ticks; i++) { await page.mouse.wheel(0, v < target ? -240 : 240); await sleep(130); }
      await page.keyboard.up('Control'); await sleep(700);
    }
    return stable();
  };
  await esc();
  // Dock collapsed so the arrangement has the full height: click the selected dock tab.
  const sel = page.locator('[data-detail-tab][aria-selected="true"]').first();
  if (await sel.count()) { await sel.click(); await sleep(700); }
  const dockH = await page.evaluate(() => document.querySelector('[data-testid="xleth-detail-dock"]').getBoundingClientRect().height);
  out.push('dock height after toggle: ' + dockH);
  out.push('zoom normalised to ' + await zoomTo(40));
  const lane = (n) => page.locator('.track-header', { hasText: n }).first();

  await step('10', async () => out.push(await shot(page, '10-timeline-default-clips-and-patterns', { surface: 'panel-timeline', scope: '[data-testid="xleth-docked-window-layer"]' })));

  await step('18', async () => {
    const b = await page.locator('button[aria-label="Select tool"]').first().boundingBox();
    out.push(await shot(page, '18-timeline-toolbar', { surface: 'timeline-toolbar', clip: { x: 258, y: Math.max(0, b.y - 10), width: 1662, height: 44 }, scope: '[data-testid="xleth-docked-window-layer"] [class*="toolbar"], [data-testid="xleth-docked-window-layer"]' }));
  });

  // Zoom in on the clips (ctrl+wheel over the canvas)
  await step('11', async () => {
    await zoomTo(300); await sleep(900);
    out.push(await shot(page, '11-timeline-zoomed-in-clips', { surface: 'panel-timeline', scope: '[data-testid="xleth-docked-window-layer"]', note: 'wheel zoom-in over the canvas (~300 px/beat)' }));
    // reset zoom
    out.push('zoom at shot: ' + await page.locator('.timeline-zoom-display').first().textContent());
    await zoomTo(40); await sleep(500);
    out.push('zoom after reset: ' + await page.locator('.timeline-zoom-display').first().textContent());
  });

  await step('12', async () => {
    await page.mouse.click(660, 526); await sleep(700);
    out.push(await shot(page, '12-timeline-clip-selected', { surface: 'panel-timeline', scope: '[data-testid="xleth-docked-window-layer"]' }));
  });

  await step('13', async () => {
    await page.locator('button[aria-label="Mute KICK"]').first().click(); await sleep(600);
    out.push(await shot(page, '13-timeline-track-muted', { surface: 'timeline-headers', scope: '[data-testid="xleth-docked-window-layer"]', note: 'KICK muted' }));
    await page.locator('button[aria-label="Mute KICK"]').first().click(); await sleep(300);
  });

  await step('14', async () => {
    const n = await page.evaluate(() => document.querySelectorAll('[class*="macro-lane"], [class*="macroLane"], [data-testid*="macro"]').length);
    out.push('macro/automation lane elements in project: ' + n);
  });

  await step('15', async () => {
    await page.locator('button[aria-label*="older"]').first().click({ timeout: 5000 }); await sleep(800);
    out.push(await shot(page, '15-timeline-folder-row', { surface: 'panel-timeline', scope: '[data-testid="xleth-docked-window-layer"]', note: 'empty folder row created via toolbar (project copy)' }));
    await page.keyboard.press('Control+z'); await sleep(600);
  });

  await step('16', async () => {
    await lane('ch1').click({ button: 'right', position: { x: 60, y: 14 } }); await sleep(600);
    out.push(await shot(page, '16-timeline-track-context-menu', { surface: 'timeline-track-ctx', scope: '[role="menu"]', live: true }));
    await esc();
  });

  await step('17', async () => {
    await page.mouse.click(1250, 484, { button: 'right' }); await sleep(600);
    out.push(await shot(page, '17-timeline-clip-context-menu', { surface: 'timeline-clip-ctx', scope: '[role="menu"]', live: true }));
    await esc();
  });
  return out.join('\n');
};
