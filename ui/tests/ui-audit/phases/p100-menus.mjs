// Menus and small dialogs: File / Edit / View menus, Unsaved changes, Export as ZIP, Clean up project, a toast.
import { shot } from '../shotlib.mjs';
export default async ({ page, sleep }) => {
  const out = [];
  const step = async (label, fn) => { try { await fn(); } catch (e) { out.push(`${label}: FAIL ${String(e.message).split('\n')[0]}`); await page.keyboard.press('Escape'); await sleep(200); } };
  const esc = async () => { for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await sleep(150); } };
  await page.keyboard.up('Control'); await esc();
  const menuBtn = (n) => page.getByRole('button', { name: n, exact: true }).first();
  for (const [name, id, surface, extra] of [['File', '110-menu-file', 'menu-file', ''], ['Edit', '111-menu-edit', 'menu-edit', ''], ['View', '112-menu-view', 'menu-view', '']]) {
    await step(name, async () => {
      await menuBtn(name).click(); await sleep(600);
      out.push(await shot(page, id, { surface, scope: '[role="menu"]', live: true }));
      if (name === 'View') {
        const lay = page.getByRole('menuitem', { name: /Layouts/ }).first();
        if (await lay.count()) { await lay.hover(); await sleep(500); out.push(await shot(page, '113-menu-view-layouts-submenu', { surface: 'menu-view', scope: '[role="menu"]', live: true })); }
      }
      await esc();
    });
  }
  // File > Export as ZIP / Clean up project
  for (const [label, id, surface] of [['Export as ZIP', '135-dialog-export-zip', 'dlg-export-zip'], ['Clean up project', '136-dialog-cleanup-project', 'dlg-cleanup']]) {
    await step(label, async () => {
      await menuBtn('File').click(); await sleep(500);
      await page.getByRole('menuitem', { name: new RegExp(label) }).first().click(); await sleep(1500);
      if (!(await page.locator('[role="dialog"]').count())) { out.push(`${id}: no dialog opened (${label} had nothing to do on this project; the status text says so); not photographed, listed in MANUAL-SHOTS.md`); await esc(); return; }
      out.push(await shot(page, id, { surface, scope: '[role="dialog"]', live: true }));
      await esc(); await sleep(400);
    });
  }
  // Toast: Ctrl+S saves to the project COPY. Done BEFORE the empty-project step so p105 reloads the saved state.
  await step('toast', async () => {
    await page.mouse.click(1000, 1000); await sleep(200);
    await page.keyboard.press('Control+s'); await sleep(500);
    out.push(await shot(page, '138-toast-save', { surface: 'toast', scope: '[data-testid="xleth-windowing-shell"]', live: true, note: 'Ctrl+S on the temp project copy' }));
    await sleep(2500);
  });
  // Unsaved changes: an edit (mute KICK), then File > New Project. Discard answers the dialog, which leaves the EMPTY project
  // that p105 photographs (19) and then replaces by reloading the copy saved above.
  await step('unsaved', async () => {
    await page.locator('button[aria-label="Mute KICK"]').first().click(); await sleep(250);
    await menuBtn('File').click(); await sleep(500);
    await page.getByRole('menuitem', { name: /^New Project/ }).first().click(); await sleep(1500);
    const n = await page.locator('[role="dialog"]').count();
    out.push('dialogs after edit + New Project: ' + n + ' ' + await page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].map((d) => (d.innerText || '').slice(0, 60).replace(/\n/g, ' | ')).join(' || ')));
    out.push(await shot(page, '134-dialog-unsaved-changes', { surface: 'dlg-unsaved', scope: n ? '[role="dialog"]' : null, live: true }));
    if (n) { await page.getByRole('button', { name: /Don.t save|Discard/i }).first().click(); await sleep(2500); out.push('discarded: empty project follows'); }
  });
  return out.join('\n');
};
