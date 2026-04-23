// ΔE2000 perceptual distance helper — test-only. Kept inline (no culori
// or color-diff dep) so the production bundle stays dependency-free per
// spec §6.3 and the Track B constraints.
//
// Pipeline:  CSS color string → sRGB [0..255] → linear RGB → XYZ (D65)
//           → CIE Lab → ΔE2000 against another Lab triple.
//
// Accepts "#rgb", "#rrggbb", "#rrggbbaa", and "rgba(r, g, b, a)" forms.
// For rgba() with partial alpha, callers must pass an explicit composite
// background (the resolved token is composed against it before conversion);
// otherwise alpha is ignored and the raw channels are used.
//
// References:
//   - CIEDE2000 formula: Sharma, Wu, Dalal (2005), "The CIEDE2000 Color-
//     Difference Formula: Implementation Notes, …"
//   - sRGB → XYZ: IEC 61966-2-1, D65 white point (Xn=95.047, Yn=100, Zn=108.883).

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface RGB { r: number; g: number; b: number; a: number; }
export interface Lab { L: number; a: number; b: number; }

// ──────────────────────────────────────────────────────────────────────────
// Parsing
// ──────────────────────────────────────────────────────────────────────────

export function parseColor(css: string): RGB {
  const s = css.trim();
  if (s.startsWith('#')) {
    const h = s.slice(1);
    const expand = (n: number, i: number) => parseInt(h.slice(i, i + n).repeat(n === 1 ? 2 : 1), 16);
    if (h.length === 3) return { r: expand(1, 0), g: expand(1, 1), b: expand(1, 2), a: 1 };
    if (h.length === 6) return { r: expand(2, 0), g: expand(2, 2), b: expand(2, 4), a: 1 };
    if (h.length === 8) return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: parseInt(h.slice(6, 8), 16) / 255,
    };
    throw new Error(`parseColor: unsupported hex "${css}"`);
  }
  const m = s.match(/^rgba?\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*(?:,\s*(-?\d+(?:\.\d+)?)\s*)?\)$/i);
  if (!m) throw new Error(`parseColor: unsupported format "${css}"`);
  return {
    r: Number(m[1]),
    g: Number(m[2]),
    b: Number(m[3]),
    a: m[4] !== undefined ? Number(m[4]) : 1,
  };
}

// Compose rgba over a solid background. `bg` must be fully opaque.
export function composeOver(fg: RGB, bg: RGB): RGB {
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// sRGB → Lab
// ──────────────────────────────────────────────────────────────────────────

function srgbToLinear(c: number): number {
  const n = c / 255;
  return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
}

export function rgbToLab(rgb: RGB): Lab {
  const R = srgbToLinear(rgb.r);
  const G = srgbToLinear(rgb.g);
  const B = srgbToLinear(rgb.b);

  // Linear sRGB → XYZ (D65) — matrix from IEC 61966-2-1.
  const X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) * 100;
  const Y = (R * 0.2126729 + G * 0.7151522 + B * 0.0721750) * 100;
  const Z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) * 100;

  // Normalize by D65 white point.
  const xn = X / 95.047;
  const yn = Y / 100.000;
  const zn = Z / 108.883;

  const f = (t: number) => t > 216 / 24389 ? Math.cbrt(t) : (t * (24389 / 27) + 16) / 116;
  const fx = f(xn), fy = f(yn), fz = f(zn);

  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// ΔE2000 (CIEDE2000)
// ──────────────────────────────────────────────────────────────────────────

export function deltaE2000(lab1: Lab, lab2: Lab): number {
  const { L: L1, a: a1, b: b1 } = lab1;
  const { L: L2, a: a2, b: b2 } = lab2;

  const avgLp = (L1 + L2) / 2;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const avgC = (C1 + C2) / 2;

  const G = 0.5 * (1 - Math.sqrt(Math.pow(avgC, 7) / (Math.pow(avgC, 7) + Math.pow(25, 7))));
  const a1p = a1 * (1 + G);
  const a2p = a2 * (1 + G);

  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const avgCp = (C1p + C2p) / 2;

  const toDeg = (r: number) => (r * 180 / Math.PI + 360) % 360;
  const h1p = (a1p === 0 && b1 === 0) ? 0 : toDeg(Math.atan2(b1, a1p));
  const h2p = (a2p === 0 && b2 === 0) ? 0 : toDeg(Math.atan2(b2, a2p));

  let dhp: number;
  if (C1p * C2p === 0) dhp = 0;
  else if (Math.abs(h2p - h1p) <= 180) dhp = h2p - h1p;
  else if (h2p - h1p > 180) dhp = h2p - h1p - 360;
  else dhp = h2p - h1p + 360;

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI / 180) / 2);

  let avgHp: number;
  if (C1p * C2p === 0) avgHp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) avgHp = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) avgHp = (h1p + h2p + 360) / 2;
  else avgHp = (h1p + h2p - 360) / 2;

  const T = 1
    - 0.17 * Math.cos(((avgHp -  30) * Math.PI) / 180)
    + 0.24 * Math.cos(((2 * avgHp)     * Math.PI) / 180)
    + 0.32 * Math.cos(((3 * avgHp + 6) * Math.PI) / 180)
    - 0.20 * Math.cos(((4 * avgHp - 63) * Math.PI) / 180);

  const dTheta = 30 * Math.exp(-Math.pow((avgHp - 275) / 25, 2));
  const Rc = 2 * Math.sqrt(Math.pow(avgCp, 7) / (Math.pow(avgCp, 7) + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(avgLp - 50, 2)) / Math.sqrt(20 + Math.pow(avgLp - 50, 2));
  const Sc = 1 + 0.045 * avgCp;
  const Sh = 1 + 0.015 * avgCp * T;
  const Rt = -Math.sin((2 * dTheta * Math.PI) / 180) * Rc;

  return Math.sqrt(
    Math.pow(dLp / Sl, 2)
    + Math.pow(dCp / Sc, 2)
    + Math.pow(dHp / Sh, 2)
    + Rt * (dCp / Sc) * (dHp / Sh),
  );
}

// Convenience — accept two CSS strings, optionally composed over bg.
export function deltaE(cssA: string, cssB: string, bg?: string): number {
  const ra = parseColor(cssA);
  const rb = parseColor(cssB);
  const bgRgb = bg ? parseColor(bg) : null;
  const solidA = ra.a < 1 && bgRgb ? composeOver(ra, bgRgb) : ra;
  const solidB = rb.a < 1 && bgRgb ? composeOver(rb, bgRgb) : rb;
  return deltaE2000(rgbToLab(solidA), rgbToLab(solidB));
}
