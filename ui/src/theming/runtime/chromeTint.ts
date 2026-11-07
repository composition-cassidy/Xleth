// "Tinted chrome" detection. Xleth's shell has to stay neutral so picture colour on
// the Preview is judged against a grey surround (ui/DESIGN.md section 3.1). This
// module measures how far a theme's chrome surfaces drift from grey and is shared
// by the theme editor (warning + Neutralize), the loader diagnostics and the tests.

import { hexToOklch } from '../../ui-kit/colorMath';

/**
 * OKLCH chroma above which a chrome surface reads as tinted. 0.012 is about 3-4 8-bit
 * channel steps at mid grey: enough room for a faint warm or cool cast, little enough
 * that picture colour still reads neutral next to it. The shipped ramps are 0.
 */
export const TINT_CHROMA_CAP = 0.012;

/** The `--theme-*` tokens that paint chrome around content. Ink and accent are not surfaces. */
export const CHROME_SURFACE_TOKENS: ReadonlyArray<string> = [
  '--theme-ui-g0',
  '--theme-ui-g1',
  '--theme-ui-g2',
  '--theme-ui-g3',
  '--theme-bg-primary',
  '--theme-bg-surface',
  '--theme-bg-inset',
  '--theme-preview-loaded-bg',
];

/** Follow `var(--x)` references through a resolved token map to a concrete #RRGGBB, or null. */
export function resolveHex(values: Record<string, string>, name: string, depth = 0): string | null {
  const raw = values[name];
  if (typeof raw !== 'string' || depth > 8) return null;
  const v = raw.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  if (/^#[0-9a-f]{3}$/i.test(v)) return '#' + v.slice(1).split('').map((c) => c + c).join('');
  const m = /^var\((--[\w-]+)/.exec(v);
  return m ? resolveHex(values, m[1], depth + 1) : null;
}

/** OKLCH chroma of a #RRGGBB colour (0 for an exact grey). */
export function chromaOf(hex: string): number {
  return hexToOklch(hex).c;
}

export interface TintedSurface {
  token: string;
  hex: string;
  chroma: number;
}

/** Chrome surfaces in a resolved theme whose chroma exceeds the cap, worst first. */
export function findTintedSurfaces(values: Record<string, string>, cap = TINT_CHROMA_CAP): TintedSurface[] {
  const out: TintedSurface[] = [];
  for (const token of CHROME_SURFACE_TOKENS) {
    const hex = resolveHex(values, token);
    if (!hex) continue;
    const chroma = chromaOf(hex);
    if (chroma > cap) out.push({ token, hex, chroma });
  }
  return out.sort((a, b) => b.chroma - a.chroma);
}
