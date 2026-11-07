// File > Open Project through the in-app picker -> the Missing media dialog (xleth:project open validates media).
import os from 'node:os';
import path from 'node:path';
import { shot } from '../shotlib.mjs';
export default async ({ page, sleep }) => {
  const out = [];
  const dir = path.join(os.tmpdir(), 'xleth-ui-audit', 'tiki-missing');
  await page.keyboard.press('Escape'); await sleep(300);
  await page.getByRole('button', { name: 'File', exact: true }).first().click(); await sleep(500);
  await page.getByRole('menuitem', { name: /^Open Project/ }).first().click(); await sleep(1500);
  out.push('after menu: ' + await page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].map((d) => (d.innerText || '').slice(0, 60).replace(/\n/g, ' | ')).join(' || ')));
  const dlgText = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].map((d) => d.innerText).join(' '));
  if (/Unsaved/.test(dlgText)) {
    out.push('unsaved dialog buttons: ' + await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].map((b) => b.textContent.trim()).join(' | ')));
    await page.getByRole('button', { name: /Don.t save|Discard/i }).first().click(); await sleep(1500);
  }
  const input = page.locator('input[aria-label="File path"]').first();
  await input.fill(dir); await sleep(300); await input.press('Enter'); await sleep(1200);
  out.push('picker buttons: ' + await page.evaluate(() => [...document.querySelectorAll('.xleth-file-picker button')].map((b) => (b.textContent || '').trim().slice(0, 18)).filter(Boolean).slice(-6).join(' | ')));
  const act = page.locator('.xleth-file-picker').getByRole('button', { name: /^Open Project$/ }).first();
  if (await act.count()) { await act.click(); await sleep(6000); }
  out.push('dialogs: ' + await page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].map((d) => (d.innerText || '').slice(0, 100).replace(/\n/g, ' | ')).join(' || ')));
  out.push(await shot(page, '133-dialog-missing-media', { surface: 'dlg-missing-media', scope: (await page.locator('[role="dialog"]').count()) ? '[role="dialog"]' : null, live: true, note: 'File > Open Project on a copy whose video source path was broken' }));
  return out.join('\n');
};
