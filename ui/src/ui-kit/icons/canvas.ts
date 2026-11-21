import { PHOSPHOR } from './phosphor.generated';
import { CUSTOM, type CustomName } from './custom';
import type { IconName, IconWeight } from './index';

/**
 * Draw an icon on a canvas from the same path data the DOM <Icon> uses (docs/ICON_PROPOSAL.md:
 * canvas views never get DOM overlays). The colour is the caller's draw-time ink, so no theme
 * token is read here. Path2D objects are created lazily on first draw (jsdom, the test
 * environment, has no Path2D) and cached.
 */
const cache = new Map<string, Path2D[]>();

function paths(key: string, ds: string[]): Path2D[] {
  let p = cache.get(key);
  if (!p) { p = ds.map((d) => new Path2D(d)); cache.set(key, p); }
  return p;
}

export function drawIcon(
  ctx: CanvasRenderingContext2D,
  name: IconName,
  x: number,
  y: number,
  size: number,
  color: string,
  weight: IconWeight = 'regular',
): void {
  if (typeof Path2D === 'undefined') return;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 256, size / 256);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  const ph = (PHOSPHOR as Record<string, readonly [string, string]>)[name];
  if (ph) {
    const [p] = paths(`${name}:${weight}`, [weight === 'fill' ? ph[1] : ph[0]]);
    ctx.fill(p);
  } else {
    const g = CUSTOM[name as CustomName];
    if (g) {
      const prims = weight === 'fill' ? g.fill : g.regular;
      const ps = paths(`${name}:${weight}`, prims.map((q) => q.d));
      const [s, tx, ty] = g.tf;
      ctx.translate(tx, ty);
      ctx.scale(s, s);
      ctx.lineWidth = g.sw;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      prims.forEach((q, i) => {
        ctx.setLineDash(q.dash ? q.dash.split(/\s+/).map(Number) : []);
        if (q.fill) ctx.fill(ps[i], q.evenodd ? 'evenodd' : 'nonzero');
        if (q.stroke && g.sw > 0) ctx.stroke(ps[i]);
      });
    }
  }
  ctx.restore();
}
