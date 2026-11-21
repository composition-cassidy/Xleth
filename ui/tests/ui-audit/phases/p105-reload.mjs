// File > New Project (run by p100) left an empty project: photograph it, then load the temp project copy back (harness-level project.load,
import os from 'node:os';
import path from 'node:path';
// the same call Welcome makes) and reload the renderer so every panel refetches.
import { shot } from '../shotlib.mjs';
export default async ({ page, sleep, projectDir }) => {
  const out = [];
  const dir = path.join(os.tmpdir(), 'xleth-ui-audit', 'tiki');
  await page.keyboard.press('Escape'); await sleep(300);
  out.push(await shot(page, '19-timeline-empty-project', { surface: 'panel-timeline', scope: '[data-testid="xleth-docked-window-layer"]', note: 'File > New Project result: no tracks, no media, no patterns' }));
  const ok = await page.evaluate(async (d) => window.xleth.project.load(d), dir);
  out.push('project.load -> ' + ok);
  await page.reload(); await page.waitForSelector('[data-testid="xleth-detail-dock"]', { timeout: 60000 }); await sleep(3500);
  out.push('tracks after reload: ' + await page.locator('.track-header').count());
  return out.join('\n');
};
