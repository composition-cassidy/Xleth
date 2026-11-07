// MIDI import dialog: type the repo's test.mid into the picker's File path field.
import path from 'node:path';
import { shot } from '../shotlib.mjs';
import { UI_DIR } from '../lib.mjs';
export default async ({ page, sleep }) => {
  const out = [];
  const mid = path.resolve(UI_DIR, '..', 'test.mid');
  const input = page.locator('input[aria-label="File path"]').first();
  await input.fill(mid); await sleep(300);
  await input.press('Enter'); await sleep(1500);
  out.push('buttons: ' + await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].map((b) => (b.textContent || '').trim().slice(0, 20)).join(' | ')));
  out.push('dialog now: ' + await page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].map((e) => (e.innerText || '').slice(0, 80).replace(/\n/g, ' | ')).join(' || ')));
  const open = page.locator('[role="dialog"]').getByRole('button', { name: /^(Open|Choose|Select|Import)/ }).last();
  if (await open.count()) { await open.click().catch(() => {}); await sleep(2500); }
  out.push('after confirm: ' + await page.evaluate(() => [...document.querySelectorAll('[role="dialog"], [class*="midi-import"]')].map((e) => e.className.toString().slice(0, 30) + ':' + (e.innerText || '').slice(0, 80).replace(/\n/g, ' | ')).join(' || ')));
  out.push(await shot(page, '132-dialog-midi-import', { surface: 'dlg-midi-import', scope: '.midi-dialog', live: true }));
  return out.join('\n');
};
