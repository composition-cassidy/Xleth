// Menus and small dialogs: File / Edit / View menus, Unsaved changes, Export as ZIP, Clean up project, a toast, Quantize.
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
      out.push(await shot(page, id, { surface, scope: '[role="dialog"]', live: true }));
      await esc(); await sleep(400);
    });
  }
  // Unsaved changes: New Project after edits
  await step('unsaved', async () => {
    await menuBtn('File').click(); await sleep(500);
    await page.getByRole('menuitem', { name: /^New Project/ }).first().click(); await sleep(1500);
    out.push('dialogs after New Project: ' + await page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].map((d) => (d.innerText || '').slice(0, 60).replace(/\n/g, ' | ')).join(' || ')));
    out.push(await shot(page, '134-dialog-unsaved-changes', { surface: 'dlg-unsaved', scope: '[role="dialog"]', live: true }));
    await esc(); await sleep(500);
  });
  // Toast: Ctrl+S saves to the project COPY
  await step('toast', async () => {
    await page.mouse.click(1000, 1000); await sleep(200);
    await page.keyboard.press('Control+s'); await sleep(500);
    out.push(await shot(page, '138-toast-save', { surface: 'toast', scope: '[data-testid="xleth-windowing-shell"]', live: true, note: 'Ctrl+S on the temp project copy' }));
  });
  // Quantize
  await step('quantize', async () => {
    await page.mouse.click(660, 592); await sleep(500);
    const q = page.locator('button[aria-label^="Quantize"], button[title^="Quantize"]').first();
    await q.click({ timeout: 4000 }); await sleep(900);
    out.push(await shot(page, '139-quantize-dialog', { surface: 'timeline-quantize', scope: '[role="dialog"], .quantize-dialog, [class*="quantize"]', live: true }));
    await esc();
  });
  return out.join('\n');
};
