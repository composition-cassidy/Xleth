// Settings: every section (Project > General, Clip FX; Application > Audio, Plugins, Graphics, Appearance, Shortcuts, Launchers, Logs) and the theme editor.
import { shot } from '../shotlib.mjs';
export default async ({ page, sleep }) => {
  const out = [];
  const esc = async () => { for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await sleep(150); } };
  const step = async (label, fn) => { try { await fn(); } catch (e) { out.push(`${label}: FAIL ${String(e.message).split('\n')[0]}`); } };
  await page.getByRole('button', { name: 'Cancel' }).first().click({ timeout: 1500 }).catch(() => {}); await sleep(500);
  await esc();
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click(); await sleep(1500);
  const mark = () => page.evaluate(() => {
    document.querySelectorAll('[data-audit-settings]').forEach((e) => e.removeAttribute('data-audit-settings'));
    const r = document.querySelector('[role="dialog"][aria-labelledby="settings-panel-title"]');
    if (r) { r.setAttribute('data-audit-settings', '1'); const b = r.getBoundingClientRect(); return { cls: String(r.className).slice(0, 40), w: Math.round(b.width), h: Math.round(b.height) }; }
    return null;
  });
  out.push('settings root: ' + JSON.stringify(await mark()));
  const sections = [['Project', 'General', '120-settings-project-general'], ['Project', 'Clip FX', '121-settings-project-clipfx'], ['Application', 'Audio', '122-settings-audio'], ['Application', 'Plugins', '123-settings-plugins'], ['Application', 'Graphics', '124-settings-graphics'], ['Application', 'Appearance', '125-settings-appearance'], ['Application', 'Shortcuts', '126-settings-shortcuts-keyboard'], ['Application', 'Launchers', '127-settings-launchers'], ['Application', 'Logs', '128-settings-logs']];
  let lastTab = null;
  for (const [tab, sec, id] of sections) {
    await step(id, async () => {
      lastTab = tab;   // round 2 step 20: one nav lists both scope groups, so there is no tab to click first
      await page.getByRole('button', { name: sec, exact: true }).or(page.getByRole('tab', { name: sec, exact: true })).first().click({ timeout: 4000 }); await sleep(1100);
      await mark(); await page.mouse.move(960, 1040);
      out.push(await shot(page, id, { surface: id.includes('shortcuts') ? 'settings-shortcuts' : 'settings-' + sec.toLowerCase().replace(/ /g, '').replace('general', 'project'), scope: '[data-audit-settings]', live: sec === 'Audio' }));
    });
  }
  await step('theme editor', async () => {
    await page.getByRole('button', { name: 'Appearance', exact: true }).first().click(); await sleep(800);
    await page.getByRole('button', { name: /Open editor/ }).first().click({ timeout: 4000 }); await sleep(1800);
    const scroller = await page.evaluate(() => { document.querySelectorAll('[data-audit-scroller]').forEach((e) => e.removeAttribute('data-audit-scroller')); const ed = [...document.querySelectorAll('[class*="theme-editor"]')][0]; return ed ? String(ed.className).slice(0, 40) : null; });
    out.push('theme editor root class: ' + scroller);
    out.push(await shot(page, '129-theme-editor', { surface: 'theme-editor', scope: '[class*="theme-editor"]', live: true, note: 'Settings > Appearance > Open editor' }));
    await page.getByRole('button', { name: /Close editor/ }).first().click().catch(() => {}); await sleep(500);
  });
  return out.join('\n');
};
