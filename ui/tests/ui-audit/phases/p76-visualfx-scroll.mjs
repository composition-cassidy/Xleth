// Visual FX (continued): the Devices tab's Video view, scrolled left to right, one
// shot per page of the chain (round 2 step 17; before it these shots were the
// Inspector column scrolled top to bottom). Shot names are kept: 85-preview-visualfx-NNofM.
import fs from 'node:fs';
import path from 'node:path';
import { shot, metrics } from '../shotlib.mjs';
import { SHOTS } from '../lib.mjs';

export default async ({ page, sleep }) => {
  const out = [];
  for (const f of fs.readdirSync(SHOTS)) if (f.startsWith('85-preview-visualfx-')) fs.rmSync(path.join(SHOTS, f));
  for (let i = metrics.length - 1; i >= 0; i--) if (metrics[i].shot.startsWith('85-preview-visualfx-')) metrics.splice(i, 1);
  const SCOPE = '[data-testid="xleth-video-chain"]';
  const info = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { sw: el.scrollWidth, cw: el.clientWidth, x: r.x, y: r.y, w: r.width, h: r.height };
  }, SCOPE);
  out.push('video chain ' + JSON.stringify(info));
  if (!info) return out.join('\n');
  const step = Math.max(400, info.cw - 40);
  const n = Math.max(1, Math.ceil(info.sw / step));
  for (let i = 0; i < n; i++) {
    await page.evaluate(([sel, x]) => { document.querySelector(sel).scrollLeft = x; }, [SCOPE, i * step]);
    await sleep(450);
    out.push(await shot(page, `85-preview-visualfx-${String(i + 1).padStart(2, '0')}of${String(n).padStart(2, '0')}`, {
      surface: 'devices-video', scope: SCOPE,
      clip: { x: info.x, y: info.y, width: info.w, height: info.h },
      note: `Devices tab, Video view, page ${i + 1}/${n}; every video effect added to the pitch track`,
    }));
  }
  await page.evaluate((sel) => { document.querySelector(sel).scrollLeft = 0; }, SCOPE);
  return out.join('\n');
};
