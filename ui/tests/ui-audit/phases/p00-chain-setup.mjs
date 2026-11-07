// Setup (no screenshots): put one of every stock effect in the Devices chain of the base track, through the picker UI.
import { openDock, addEffect, EFFECT_MENU, PLUGIN_ID, devicePlugins } from './common.mjs';
export default async ({ page }) => {
  await openDock(page, 'devices');
  const log = [];
  for (const [cat, items] of EFFECT_MENU) {
    for (const it of items) {
      if ((await devicePlugins(page)).includes(PLUGIN_ID[it])) { log.push(`${it}: already present`); continue; }
      try { await addEffect(page, cat, it); log.push(`${it}: added`); } catch (e) { log.push(`${it}: FAIL ${String(e.message).split('\n')[0]}`); }
    }
  }
  const plugins = await devicePlugins(page);
  log.push('chain: ' + plugins.join(','));
  const missing = Object.values(PLUGIN_ID).filter((p) => !plugins.includes(p));
  log.push('missing: ' + (missing.join(',') || 'none'));
  return log.join('\n');
};
