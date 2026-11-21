// Shell: the default layout (dock collapsed) and each detail-dock tab opened in turn.
import { shot } from '../shotlib.mjs';
export default async ({ page, sleep }) => {
  const out = [];
  await page.mouse.move(1000, 600); await sleep(800);
  out.push(await shot(page, '01-shell-default-dock-collapsed', { surface: 'shell', note: 'fresh profile, default layout, project just loaded' }));
  const tabs = [['devices', '02-shell-dock-devices', 'dock-devices'], ['mixer', '03-shell-dock-mixer', 'dock-mixer'], ['pianoRoll', '04-shell-dock-pianoroll', 'dock-pianoroll'], ['sampler', '05-shell-dock-sampler', 'dock-sampler'], ['fxGraph', '06-shell-dock-fxgraph', 'dock-fxgraph']];
  for (const [id, name, surface] of tabs) {
    const t = page.locator(`[data-detail-tab="${id}"]`).first();
    if ((await t.getAttribute('aria-selected')) !== 'true') await t.click();
    await sleep(1000); await page.mouse.move(1000, 300);
    out.push(await shot(page, name, { surface, scope: '[data-testid="xleth-detail-dock"]', note: 'dock opened at its default 304 px height, nothing selected yet' }));
  }
  return out.join('\n');
};
