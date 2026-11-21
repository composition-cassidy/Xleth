// Round 2 step 20: the shots the first audit never took: Convert track dialog (156), media-row / sampler-knob / sandbox-selection menus (166, 167, 169).
import { shot } from '../shotlib.mjs';
export default async ({ page, sleep }) => {
  const out = [];
  const esc = async (n = 3) => { for (let i = 0; i < n; i++) { await page.keyboard.press('Escape'); await sleep(150); } };
  const step = async (label, fn) => { try { await fn(); } catch (e) { out.push(`${label}: FAIL ${String(e.message).split('\n')[0]}`); await esc(); } };
  await page.keyboard.up('Control'); await esc();

  await step('156 convert', async () => {
    const heads = page.locator('.track-header'); const n = await heads.count();
    for (let i = 0; i < n; i++) { await heads.nth(i).click({ button: 'right', position: { x: 60, y: 14 } }); await sleep(800); if (await page.evaluate(() => [...document.querySelectorAll('[role^=menuitem]')].some((x) => /Convert to Pattern Track/.test(x.textContent)))) break; await esc(2); await sleep(300); }
    await sleep(500);
    const item = page.locator('[role^=menuitem]', { hasText: /Convert to Pattern Track/ }).first();   // kit menu items are menuitem or menuitemcheckbox
    if (!(await item.count())) { out.push('156: no "Convert to Pattern Track" item (menu: ' + (await page.evaluate(() => [...document.querySelectorAll('[role^=menuitem]')].map((x) => x.textContent.trim()).join(' | '))) + ')'); await esc(); return; }
    await item.click({ timeout: 3000 }); await sleep(900);
    out.push(await shot(page, '156-dialog-convert-track', { surface: 'dlg-convert', scope: '[role="dialog"]', live: true }));
    await esc();
  });

  await step('166 media row', async () => {
    const sel = page.locator('[data-detail-tab][aria-selected="true"]').first();
    if (await sel.count()) { await sel.click(); await sleep(600); }
    await page.getByRole('tab', { name: /^Media/ }).first().click(); await sleep(600);
    await page.getByText(/tiktok_mi/).first().click({ button: 'right' }); await sleep(600);
    out.push(await shot(page, '166-context-menu-media-row', { surface: 'ctx-media-row', scope: '[role="menu"]', live: true }));
    await esc();
  });

  await step('167 sampler knob', async () => {
    const DOCK = '[data-testid="xleth-detail-dock"]';
    const prTab = page.locator('[data-detail-tab="pianoRoll"]').first();
    if ((await prTab.getAttribute('aria-selected')) !== 'true') { await prTab.click(); await sleep(800); }
    await page.getByText('Pattern 8', { exact: false }).first().dblclick(); await sleep(1300);   // the button is disabled until a pattern with a sample region is open
    await page.locator(`${DOCK} button[title^="Sampler settings" i], ${DOCK} button[aria-label^="Sampler settings" i]`).first().click(); await sleep(1200);
    await page.locator(`${DOCK} [role="slider"]:visible`).first().click({ button: 'right', timeout: 4000 }); await sleep(600);
    if (await page.locator('[role="menu"]').count()) out.push(await shot(page, '167-context-menu-sampler-knob', { surface: 'ctx-sampler-knob', scope: '[role="menu"]', live: true }));
    else out.push('167: right-click on a sampler knob opens no menu in this build; not photographed');
    await esc();
  });

  await step('169 sandbox selection', async () => {
    const tools = async (title) => {
      await page.getByRole('toolbar', { name: 'Panels' }).getByRole('button', { name: 'Tools', exact: true }).click(); await sleep(250);
      await page.getByRole('menuitemcheckbox', { name: title }).first().click(); await sleep(250);
    };
    await tools('Sample Sandbox'); await sleep(1400);
    const b = await page.evaluate(() => { const c = [...document.querySelectorAll('[data-testid="xleth-floating-window-layer"] canvas')].filter((e) => e.checkVisibility()).map((e) => e.getBoundingClientRect()).sort((p, q) => q.width * q.height - p.width * p.height)[0]; return c ? { x: c.x, y: c.y, width: c.width, height: c.height } : null; });   // the largest canvas is the waveform; the first is a strip
    if (!b) { out.push('169: no sandbox canvas'); return; }
    out.push('sandbox canvas ' + JSON.stringify(b));
    await page.mouse.move(b.x + b.width * 0.3, b.y + b.height * 0.5);
    await page.mouse.down(); await page.mouse.move(b.x + b.width * 0.6, b.y + b.height * 0.5, { steps: 8 }); await page.mouse.up(); await sleep(400);
    await page.mouse.click(b.x + b.width * 0.45, b.y + b.height * 0.5, { button: 'right' }); await sleep(600);
    out.push(await shot(page, '169-context-menu-sandbox-selection', { surface: 'ctx-sandbox-selection', scope: '[role="menu"]', live: true, note: 'needs a loaded sandbox source to show the selection menu; empty-state otherwise' }));
    await esc();
    await tools('Sample Sandbox');
  });
  return out.join('\n');
};
