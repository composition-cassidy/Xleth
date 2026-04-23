// Gradient compiler — converts a GradientValue object (spec §3.6) into a
// canonical CSS gradient string suitable for `setProperty('--...', value)`.
//
// Deterministic: same input → same output. No rounding beyond what the CSS
// parser does itself.

import type {
  ConicGradientValue,
  GradientStop,
  GradientValue,
  LinearGradientValue,
  RadialGradientValue,
} from './types';

function formatStops(stops: ReadonlyArray<GradientStop>): string {
  return stops
    .map(s => `${s.color} ${clampPct(s.position)}%`)
    .join(', ');
}

function clampPct(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(100, p));
}

function compileLinear(g: LinearGradientValue): string {
  const angle = Number.isFinite(g.angle) ? g.angle : 180;
  return `linear-gradient(${angle}deg, ${formatStops(g.stops)})`;
}

function compileRadial(g: RadialGradientValue): string {
  const shape = g.shape ?? 'ellipse';
  const size = g.size ? ` ${g.size}` : '';
  const pos = g.position ? ` at ${g.position}` : '';
  return `radial-gradient(${shape}${size}${pos}, ${formatStops(g.stops)})`;
}

function compileConic(g: ConicGradientValue): string {
  const fromAngle = Number.isFinite(g.angle) ? `from ${g.angle}deg` : '';
  const pos = g.position ? `at ${g.position}` : '';
  const prefix = [fromAngle, pos].filter(Boolean).join(' ');
  const head = prefix ? `${prefix}, ` : '';
  return `conic-gradient(${head}${formatStops(g.stops)})`;
}

/**
 * Compile a gradient value object to its CSS string form.
 * Throws on unrecognized gradient types so the validator is single-source-of-truth.
 */
export function compileGradient(g: GradientValue): string {
  switch (g.type) {
    case 'linear-gradient': return compileLinear(g);
    case 'radial-gradient': return compileRadial(g);
    case 'conic-gradient':  return compileConic(g);
    default: {
      const exhaustive: never = g;
      throw new Error(`gradientCompiler: unknown gradient type ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Compile a token value. Strings pass through; gradient objects compile.
 */
export function compileTokenValue(v: string | GradientValue): string {
  return typeof v === 'string' ? v : compileGradient(v);
}
