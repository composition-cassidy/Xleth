// Export dialog (audio tab, then each video tab), the Xleth file picker modal (137) and the MIDI import dialog (132).
import path from 'node:path';
import { shot } from '../shotlib.mjs';
import { UI_DIR } from '../lib.mjs';
export default async ({ page, sleep }) => {
  const out = [];
  const esc = async () => { for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await sleep(150); } };
  const step = async (label, fn) => { try { await fn(); } catch (e) { out.push(`${label}: FAIL ${String(e.message).split('\n')[0]}`); await esc(); } };
  await page.keyboard.up('Control'); await esc();
  await page.mouse.click(1000, 1000); await sleep(200);
  const DLG = '.export-dialog, [role="dialog"]';

  await step('export audio', async () => {
    await page.keyboard.press('Control+e'); await sleep(1500);
    out.push('export dialog visible: ' + (await page.locator('[role="dialog"]').first().isVisible().catch(() => false)));
    out.push(await shot(page, '130-dialog-export-audio', { surface: 'dlg-export', scope: '[role="dialog"]', live: true }));
    for (const [tab, id] of [['YouTube', '131-dialog-export-video-youtube'], ['Discord', '131b-dialog-export-video-discord'], ['Custom', '131c-dialog-export-video-custom']]) {
      await step(tab, async () => {
        await page.locator('[role="dialog"]').getByRole('tab', { name: new RegExp(tab, 'i') }).or(page.locator('[role="dialog"]').getByRole('button', { name: new RegExp('^' + tab, 'i') })).first().click({ timeout: 3000 });
        await sleep(900);
        out.push(await shot(page, id, { surface: 'dlg-export', scope: '[role="dialog"]', live: true, note: tab + ' destination' }));
      });
    }
    await esc(); await sleep(500);
  });

  await step('midi import', async () => {
    await page.getByRole('button', { name: 'Import MIDI' }).first().click(); await sleep(1500);
    out.push('file picker modal: ' + await page.evaluate(() => [...document.querySelectorAll('[role="dialog"], [class*="file-picker"], [class*="FilePicker"]')].map((e) => e.className.toString().slice(0, 40) + ':' + (e.innerText || '').slice(0, 60).replace(/\n/g, ' | ')).join(' || ')));
    out.push(await shot(page, '137-filepicker-modal', { surface: 'filepicker', scope: '[role="dialog"]', live: true, note: 'Import MIDI opens the in-app file picker' }));
    const inputs = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] input')].map((i) => i.type + ':' + (i.placeholder || i.getAttribute('aria-label') || '') + ':' + i.value.slice(0, 40)));
    out.push('picker inputs: ' + JSON.stringify(inputs));
    // MIDI import dialog (132): type the repo's test.mid into the picker's File path field (same step: the chain closes dialogs between phases)
    const mid = path.resolve(UI_DIR, '..', 'test.mid');
    const input = page.locator('input[aria-label="File path"]').first();
    await input.fill(mid); await sleep(300);
    await input.press('Enter'); await sleep(1800);
    out.push('dialog now: ' + await page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].map((e) => (e.innerText || '').slice(0, 80).replace(/\n/g, ' | ')).join(' || ')));
    out.push(await shot(page, '132-dialog-midi-import', { surface: 'dlg-midi-import', scope: '[role="dialog"]', live: true }));
  });
  return out.join('\n');
};
