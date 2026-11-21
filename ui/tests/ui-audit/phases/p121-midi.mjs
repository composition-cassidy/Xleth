// MIDI import: Browser > Import MIDI opens the in-app file picker; the repo's test.mid is typed in; then the MIDI import dialog.
import { shot } from '../shotlib.mjs';
export default async ({ page, sleep }) => {
  const out = [];
  const esc = async () => { for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await sleep(150); } };
  await esc();
  if (await page.locator('[role="dialog"]').count()) { await page.locator('[role="dialog"] button[aria-label="Close"]').first().click().catch(() => {}); await sleep(700); out.push('closed the Export dialog via its Close button (Escape does not close it)'); }
  await page.getByRole('tab', { name: /^Media/ }).first().click(); await sleep(600);
  const btn = page.locator('button[title*="MIDI"], button[aria-label*="MIDI"]').first();
  out.push('import midi buttons: ' + await page.locator('button[title*="MIDI"], button[aria-label*="MIDI"]').count());
  await btn.click({ timeout: 5000 }); await sleep(1500);
  out.push('after click: ' + await page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].map((e) => (e.className.toString().slice(0, 40)) + ':' + (e.innerText || '').slice(0, 80).replace(/\n/g, ' | ')).join(' || ')));
  out.push(await shot(page, '137-filepicker-modal', { surface: 'filepicker', scope: '[role="dialog"]', live: true, note: 'Import MIDI opens the in-app file picker' }));
  out.push('inputs: ' + JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] input')].map((i) => i.type + ':' + (i.placeholder || i.getAttribute('aria-label') || '') + ':' + i.value.slice(0, 50)))));
  return out.join('\n');
};
