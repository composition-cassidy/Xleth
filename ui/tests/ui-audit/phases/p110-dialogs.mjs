// Dialogs: Clean up project, Unsaved changes (an edit, then File > New Project before autosave), Quantize, Export (audio / video), MIDI import + the Xleth file picker.
import { shot } from '../shotlib.mjs';
export default async ({ page, sleep }) => {
  const out = [];
  const step = async (label, fn) => { try { await fn(); } catch (e) { out.push(`${label}: FAIL ${String(e.message).split('\n')[0]}`); await esc(); } };
  const esc = async () => { for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await sleep(150); } };
  const dlgScope = async () => ((await page.locator('[role="dialog"]').count()) ? '[role="dialog"]' : null);
  const menu = async (item) => { await page.getByRole('button', { name: 'File', exact: true }).first().click(); await sleep(500); await page.getByRole('menuitem', { name: item }).first().click(); await sleep(1500); };
  await page.keyboard.up('Control'); await esc();

  await step('cleanup', async () => {
    await menu(/Clean up project/);
    const sc = await dlgScope();
    out.push('cleanup dialogs: ' + (await page.locator('[role="dialog"]').count()));
    out.push(await shot(page, '136-dialog-cleanup-project', { surface: 'dlg-cleanup', scope: sc, live: true }));
    await esc(); await sleep(500);
  });

  await step('unsaved', async () => {
    await page.locator('button[aria-label="Mute KICK"]').first().click(); await sleep(150);   // an edit
    await page.getByRole('button', { name: 'File', exact: true }).first().click(); await sleep(250);
    await page.getByRole('menuitem', { name: /^New Project/ }).first().click(); await sleep(1200);
    const n = await page.locator('[role="dialog"]').count();
    out.push('dialogs after edit + New Project: ' + n + ' ' + (await page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].map((d) => (d.innerText || '').slice(0, 70).replace(/\n/g, ' | ')).join(' || '))));
    out.push(await shot(page, '134-dialog-unsaved-changes', { surface: 'dlg-unsaved', scope: n ? '[role="dialog"]' : null, live: true }));
    if (n) { await esc(); } else { out.push('no dialog: project was not dirty or New Project opened another surface'); }
  });
  return out.join('\n');
};
