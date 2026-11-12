// Knob arc geometry (pure). A 270 degree sweep opening at the bottom:
// minimum at 135 degrees (bottom left), maximum at 405 (bottom right), measured
// clockwise from 3 o'clock in SVG's y-down space, so 270 is straight up.

export const ARC_START_DEG = 135;
export const ARC_SWEEP_DEG = 270;

export const normToDeg = (norm: number): number => ARC_START_DEG + norm * ARC_SWEEP_DEG;

export function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

const f = (n: number): string => String(Math.round(n * 100) / 100);

/** Clockwise arc between two angles. Returns '' for a zero-length arc. */
export function arcPath(cx: number, cy: number, r: number, fromDeg: number, toDeg: number): string {
  const sweep = toDeg - fromDeg;
  if (Math.abs(sweep) < 0.05) return '';
  const [lo, hi] = sweep >= 0 ? [fromDeg, toDeg] : [toDeg, fromDeg];
  const [sx, sy] = polar(cx, cy, r, lo);
  const [ex, ey] = polar(cx, cy, r, hi);
  const large = hi - lo > 180 ? 1 : 0;
  return `M ${f(sx)} ${f(sy)} A ${f(r)} ${f(r)} 0 ${large} 1 ${f(ex)} ${f(ey)}`;
}

export interface KnobGeometry {
  /** The full-range track. */
  track: string;
  /** The value arc: from the minimum, or from the centre when bipolar. '' when empty. */
  value: string;
  /** The pointer: a tick crossing the ring at the current value. */
  pointer: { x1: number; y1: number; x2: number; y2: number };
  /** Bipolar only: a short tick marking the centre (zero) just outside the ring. */
  zero: { x1: number; y1: number; x2: number; y2: number } | null;
}

export interface MinimalDialGeometry {
  /** Centre of the disc, and its radius (the stroke stays inside the box). */
  c: number;
  r: number;
  /** A spoke from near the centre to the rim at the current value. */
  pointer: { x1: number; y1: number; x2: number; y2: number };
}

/** A plain dial: a disc and one pointer, on the same 270 degree sweep as the full knob. */
export function minimalDialGeometry(norm: number, size: number): MinimalDialGeometry {
  const c = size / 2;
  const r = c - 1;
  const deg = normToDeg(Math.max(0, Math.min(1, norm)));
  const [x1, y1] = polar(c, c, r * 0.2, deg);
  const [x2, y2] = polar(c, c, r - 0.5, deg);
  return { c, r, pointer: { x1, y1, x2, y2 } };
}

/**
 * @param norm        current value, normalised 0..1
 * @param centreNorm  normalised centre for a bipolar control, or null for a unipolar one
 * @param size        the SVG's width and height
 */
export function knobGeometry(norm: number, centreNorm: number | null, size: number): KnobGeometry {
  const c = size / 2;
  const r = c - 4;
  const n = Math.max(0, Math.min(1, norm));
  const from = normToDeg(centreNorm ?? 0);
  const to = normToDeg(n);
  const [px1, py1] = polar(c, c, r - 6, to);
  const [px2, py2] = polar(c, c, r + 2, to);
  let zero: KnobGeometry['zero'] = null;
  if (centreNorm !== null) {
    const z = normToDeg(centreNorm);
    const [zx1, zy1] = polar(c, c, r + 1.5, z);
    const [zx2, zy2] = polar(c, c, r + 3.5, z);
    zero = { x1: zx1, y1: zy1, x2: zx2, y2: zy2 };
  }
  return {
    track: arcPath(c, c, r, ARC_START_DEG, ARC_START_DEG + ARC_SWEEP_DEG),
    value: arcPath(c, c, r, from, to),
    pointer: { x1: px1, y1: py1, x2: px2, y2: py2 },
    zero,
  };
}
