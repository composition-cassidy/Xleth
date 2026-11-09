// Helpers shared by the capture phases. Everything goes through the real UI (clicks / keys).
import { sleep } from '../lib.mjs';

export const EFFECT_MENU = [
  ['Dynamics', ['Compressor', 'Glue Comp', 'Opto Comp', 'FET Comp', 'Vari-Mu Comp', 'Limiter', 'APEX', 'GLOSS', 'Overdone', 'Transient Proc', 'Resonance Suppressor']],
  ['EQ & Filter', ['Xleth EQ', 'Xleth Filter']],
  ['Distortion', ['Distortion', 'Waveshaper', 'Amp Stack']],
  ['Modulation', ['UniFlange', 'Chorus', 'Flanger', 'Phaser', 'Phanjer']],
  ['Time', ['Delay', 'Reverb']],
  ['Pitch', ['Pitch Shifter']],
  ['Utility', ['Smart Balance']],
];
// pluginId for each menu label (effectCatalog.js)
export const PLUGIN_ID = {
  Compressor: 'compressor', 'Glue Comp': 'glue', 'Opto Comp': 'opto', 'FET Comp': 'fet', 'Vari-Mu Comp': 'varimu', Limiter: 'limiter', APEX: 'apex', GLOSS: 'gloss',
  Overdone: 'overdone', 'Transient Proc': 'transientproc', 'Resonance Suppressor': 'resonancesuppressor', 'Xleth Filter': 'xlethfilter', Distortion: 'distortion',
  Waveshaper: 'waveshaper', 'Amp Stack': 'amp', UniFlange: 'uniflange', Chorus: 'chorus', Flanger: 'flanger', Phaser: 'phaser', Phanjer: 'phanjer', Delay: 'delay',
  Reverb: 'reverb', 'Pitch Shifter': 'pitchshifter', 'Smart Balance': 'smartbalance',
};

// 'Xleth EQ' is not in PLUGIN_ID: p10's popout numbering (42 = xletheq, then PLUGIN_ID order) depends on its key order.
export const EXTRA_PLUGIN_ID = { 'Xleth EQ': 'xletheq' };

export const devicePlugins = (page) => page.evaluate(() => [...document.querySelectorAll('[data-device-plugin]')].map((e) => e.getAttribute('data-device-plugin')));

export async function openDock(page, id) {
  const t = page.locator(`[data-detail-tab="${id}"]`).first();
  if ((await t.getAttribute('aria-selected')) !== 'true') await t.click();
  await sleep(700);
}

/** Close any open menu/popover. */
export async function esc(page, n = 1) { for (let i = 0; i < n; i++) { await page.keyboard.press('Escape'); await sleep(150); } }

/**
 * Add one stock effect to the Devices chain through the "Drop effects here" picker. The picker is opened with the keyboard
 * and the pointer parked away, because with 20+ devices the drop zone sits at the window's right edge and a pointer left on
 * the menu opens a submenu that covers the rest of the root list.
 */
export async function addEffect(page, category, label) {
  const ci = EFFECT_MENU.findIndex(([c]) => c === category);
  await esc(page, 3);
  const z = page.getByText('Drop effects here').first();
  await z.scrollIntoViewIfNeeded();
  await page.mouse.move(900, 300);
  await z.evaluate((e) => (e.closest('button,[role=button]') || e).focus());
  await page.keyboard.press('Enter'); await sleep(350);
  // Keyboard first (a pointer parked on the root list opens a submenu that covers it); if the category item is not focused after
  // the arrows (the last category can sit below the menu's visible area), focus it directly and open it with ArrowRight.
  for (let i = 0; i <= ci; i++) { await page.keyboard.press('ArrowDown'); await sleep(130); }
  const cat = page.getByRole('menuitem', { name: category, exact: false }).first();   // category labels hold no regex characters
  if (await cat.count()) { await cat.focus().catch(() => {}); await sleep(150); }
  await page.keyboard.press('ArrowRight'); await sleep(250);
  if (!(await page.getByRole('menuitem', { name: label, exact: true }).count())) { await page.keyboard.press('Enter'); await sleep(300); }
  await page.getByRole('menuitem', { name: label, exact: true }).first().click({ timeout: 4000 });
  await sleep(600);
}

/** Selected track header by visible name; returns whether it was clicked. */
export async function clickTrack(page, name) {
  const h = page.locator('.track-header', { hasText: name }).first();
  if (!(await h.count())) return false;
  await h.click({ position: { x: 60, y: 14 } }); await sleep(400); return true;
}
