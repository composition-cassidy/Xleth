// Value formatting for the UI kit (ui/DESIGN.md section 6).
//
//   number, THIN SPACE (U+2009), unit, with a true minus sign (U+2212).
//
//   dB     1 decimal                          -6.0 dB
//   Hz     below 1 k: 0 decimals; from 1 k up as kHz with 2 decimals
//                                             455 Hz   5.49 kHz
//   ms     below 100: 1 decimal; else 0       12.5 ms  250 ms
//   %      0 decimals                         70 %
//   ratio  1 decimal, spaced colon            4.0 : 1  inf : 1
//   Mbps   1 decimal                          5.0 Mbps
//   kbps   0 decimals                         384 kbps
//   MB     1 decimal                          9.6 MB
//   LUFS   1 decimal                          -14.0 LUFS  (dBTP, dBFS: 1 and 0 decimals)
//   s      below 60: 1 decimal (0 when whole); from 60 as m:ss   12.5 s   2:05
//
// Rounding is decided BEFORE the unit/precision switch, so a value that rounds
// up across a boundary is shown in the next unit (999.5 Hz -> 1.00 kHz,
// 99.95 ms -> 100 ms). A result that rounds to zero never shows a sign
// (-0, -0.04 dB -> 0.0 dB).

export const THIN_SPACE = ' ';
export const MINUS = '−';
const EM_DASH = '—';

export type Unit = 'dB' | 'Hz' | 'ms' | '%' | 'ratio' | 'Mbps' | 'kbps' | 'MB' | 'LUFS' | 'dBTP' | 'dBFS' | 's';

export interface FormatOptions {
  /** Override the decimals the unit would use. Ignored for kHz (always 2) and `inf`. */
  decimals?: number;
  /** Prefix positive values with "+" (gain, trim, detune). Zero never gets a sign. */
  signed?: boolean;
  /** Return the number only, without the unit (for fields that show the unit elsewhere). */
  unitless?: boolean;
}

/** Round |n| half away from zero to `d` decimals, immune to binary artefacts (1.005 -> 1.01). */
function roundAbs(abs: number, d: number): number {
  const s = String(abs);
  // Exponent notation (1e-7, 1e21) cannot take the "e" suffix trick below.
  if (s.includes('e')) return Math.round(abs * 10 ** d) / 10 ** d;
  return Number(`${Math.round(Number(`${s}e${d}`))}e-${d}`);
}

function signFor(negative: boolean, isZero: boolean, signed: boolean): string {
  if (isZero) return '';
  if (negative) return MINUS;
  return signed ? '+' : '';
}

/**
 * Format a value for display. Non-numeric input and NaN render as an em dash;
 * infinities render as `inf` (`inf : 1`, `−inf dB`).
 */
export function formatValue(value: number | null | undefined, unit: Unit, opts: FormatOptions = {}): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return EM_DASH;
  const { decimals, signed = false, unitless = false } = opts;
  const withUnit = (num: string, suffix: string): string => (unitless || !suffix ? num : `${num}${THIN_SPACE}${suffix}`);

  const negative = value < 0 || Object.is(value, -0);

  if (!Number.isFinite(value)) {
    const body = `${signFor(negative, false, signed)}inf`;
    return unit === 'ratio' ? (unitless ? body : `${body} : 1`) : withUnit(body, unit);
  }

  const abs = Math.abs(value);

  switch (unit) {
    case 'dB': {
      const d = decimals ?? 1;
      const r = roundAbs(abs, d);
      return withUnit(`${signFor(negative, r === 0, signed)}${r.toFixed(d)}`, 'dB');
    }
    case 'Hz': {
      const d = decimals ?? 0;
      const r = roundAbs(abs, d);
      if (r >= 1000) {
        const k = roundAbs(abs / 1000, 2);
        return withUnit(`${signFor(negative, false, signed)}${k.toFixed(2)}`, 'kHz');
      }
      return withUnit(`${signFor(negative, r === 0, signed)}${r.toFixed(d)}`, 'Hz');
    }
    case 'ms': {
      let d = decimals ?? (roundAbs(abs, 1) < 100 ? 1 : 0);
      let r = roundAbs(abs, d);
      // 99.95 rounds to 100.0 at one decimal: show it as "100 ms", not "100.0 ms".
      if (decimals === undefined && d === 1 && r >= 100) {
        d = 0;
        r = roundAbs(abs, 0);
      }
      return withUnit(`${signFor(negative, r === 0, signed)}${r.toFixed(d)}`, 'ms');
    }
    case '%': {
      const d = decimals ?? 0;
      const r = roundAbs(abs, d);
      return withUnit(`${signFor(negative, r === 0, signed)}${r.toFixed(d)}`, '%');
    }
    case 'ratio': {
      const d = decimals ?? 1;
      const r = roundAbs(abs, d);
      const num = `${signFor(negative, r === 0, signed)}${r.toFixed(d)}`;
      return unitless ? num : `${num} : 1`;
    }
    case 'Mbps':
    case 'MB':
    case 'LUFS':
    case 'dBTP':
    case 'dBFS':
    case 'kbps': {
      const d = decimals ?? (unit === 'kbps' || unit === 'dBFS' ? 0 : 1);
      const r = roundAbs(abs, d);
      return withUnit(`${signFor(negative, r === 0, signed)}${r.toFixed(d)}`, unit);
    }
    case 's': {
      // A duration: seconds with a decimal under a minute, then minutes and seconds.
      if (abs >= 59.95) {
        const total = Math.round(abs);
        const m = Math.floor(total / 60);
        const sec = total - m * 60;
        return `${signFor(negative, false, signed)}${m}:${String(sec).padStart(2, '0')}`;
      }
      const d = decimals ?? (Number.isInteger(roundAbs(abs, 1)) ? 0 : 1);
      const r = roundAbs(abs, d);
      return withUnit(`${signFor(negative, r === 0, signed)}${r.toFixed(d)}`, 's');
    }
  }
}

/**
 * Text for `aria-valuetext`: "Cutoff, 455 Hz" (DESIGN.md section 7). The label is
 * the control's accessible name; the value uses the same formatting as the display.
 */
export function formatValueText(label: string, value: number | null | undefined, unit: Unit, opts: FormatOptions = {}): string {
  return `${label}, ${formatValue(value, unit, opts)}`;
}
