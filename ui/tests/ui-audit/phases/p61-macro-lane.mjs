// Macro automation lane (153): p60 left a Macro node on ch1's graph. Right-click it, Create Automation Clip, collapse the dock,
// photograph the arrangement. Runs AFTER p80 because a lane under ch1 shifts every track below it (p80 clicks pixels).
import { shot, auditInPage } from '../shotlib.mjs';
export default async ({ page, sleep }) => {
  const out = [];
  const DOCK = '[data-testid="xleth-detail-dock"]';
  const esc = async (n = 3) => { for (let i = 0; i < n; i++) { await page.keyboard.press('Escape'); await sleep(150); } };
  try {
    await esc();
    const mt = page.locator('[data-detail-tab="mixer"]').first();
    if ((await mt.getAttribute('aria-selected')) !== 'true') { await mt.click(); await sleep(900); }
    await page.locator(`${DOCK} [class*="strip"]`).filter({ hasText: /^2\s*ch1/ }).first().click({ position: { x: 30, y: 14 } }); await sleep(500);
    await page.locator('[data-detail-tab="fxGraph"]').first().click(); await sleep(1500);
    const node = page.locator('input[aria-label^="Rename Macro"]').first();   // the node title is a rename field
    if (!(await node.count())) { out.push('153: no Macro node on the ch1 graph; the macro lane was not photographed; dock: ' + (await page.evaluate((d) => document.querySelector(d).innerText.slice(0, 300), DOCK)).split('\n').join(' | ')); return out.join('\n'); }
    const b = await node.boundingBox();
    await page.mouse.click(b.x + 10, b.y + 4, { button: 'right' }); await sleep(600);
    await page.getByRole('menuitem', { name: 'Create Automation Clip' }).click({ timeout: 4000 }); await sleep(900);
    await page.locator('[data-detail-tab][aria-selected="true"]').first().click(); await sleep(900);
    const m = await page.evaluate(auditInPage, { scopeSel: '.macro-automation-lanes-layer', minContrast: 4.5, minFontPx: 10 });
    out.push(m.error ? `macro lane layer: ${m.error}` : `macro lane layer: text ${m.text.total}, <4.5:1 ${m.text.lowContrast}, <10px ${m.text.small}, fs ${m.distinctFontSizes}, caps ${m.letterSpacedUppercaseCount}`);
    out.push(await shot(page, '153-timeline-macro-automation-lanes', { surface: 'timeline-macro-lanes', scope: '[data-testid="xleth-docked-window-layer"]', note: 'Macro 1 on ch1, Create Automation Clip' }));
  } catch (e) { out.push(`153: FAIL ${String(e.message).split('\n')[0]}`); await esc(); }
  return out.join('\n');
};
