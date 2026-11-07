// Shell extras on the freshly loaded project: hint bar text for a hovered control, keyboard focus ring after Tab, Quantize dialog.
import { shot } from '../shotlib.mjs';
export default async ({ page, sleep }) => {
  const out = [];
  const esc = async () => { for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await sleep(150); } };
  const step = async (label, fn) => { try { await fn(); } catch (e) { out.push(`${label}: FAIL ${String(e.message).split('\n')[0]}`); await esc(); } };
  await page.keyboard.up('Control'); await esc(); await sleep(500);
  await step('hint', async () => {
    await page.locator('button[aria-label="Mute base"]').first().hover(); await sleep(700);
    out.push('hint text: ' + await page.evaluate(() => document.querySelector('[data-testid="hint-bar"]').innerText.replace(/\n/g, ' | ')));
    out.push(await shot(page, '07-shell-hintbar-hovering-mute', { surface: 'hintbar', scope: '[data-testid="hint-bar"]', live: true, note: 'pointer on the Mute button of the base track' }));
  });
  await step('focus', async () => {
    await page.mouse.click(1200, 1000); await sleep(200);
    await page.keyboard.press('Escape');
    for (let i = 0; i < 7; i++) { await page.keyboard.press('Tab'); await sleep(120); }
    out.push('focused: ' + await page.evaluate(() => { const a = document.activeElement; return a.tagName + ':' + (a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 30) + ' outline=' + getComputedStyle(a).outlineStyle + '/' + getComputedStyle(a).outlineWidth + ' boxShadow=' + getComputedStyle(a).boxShadow.slice(0, 40); }));
    out.push(await shot(page, '08-shell-keyboard-focus-ring-after-tab', { surface: 'shell', scope: null, live: true, note: '7 Tab presses from the arrangement; focus ring visible on the focused control' }));
  });
  await step('quantize', async () => {
    await page.mouse.click(660, 526); await sleep(600);
    const q = page.locator('button[aria-label^="Quantize"], button[title^="Quantize"]').first();
    out.push('quantize btn: ' + await q.evaluate((b) => b.outerHTML.slice(0, 160) + ' disabled=' + b.disabled));
    await q.click({ timeout: 4000 }); await sleep(900);
    out.push('dialogs: ' + await page.locator('[role="dialog"], .quantize-dialog').count());
    out.push(await shot(page, '139-quantize-dialog', { surface: 'timeline-quantize', scope: '[role="dialog"], .quantize-dialog, [class*="quantize"]', live: true }));
    await esc();
  });
  return out.join('\n');
};
