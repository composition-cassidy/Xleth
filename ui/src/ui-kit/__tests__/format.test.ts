import { describe, expect, it } from 'vitest';
import { formatValue, formatValueText, MINUS, THIN_SPACE } from '../format';

const T = THIN_SPACE;
const M = MINUS;

describe('formatValue: separators and signs', () => {
  it('uses a thin space (U+2009) between number and unit, never a regular space', () => {
    const s = formatValue(6, 'dB');
    expect(s).toBe(`6.0${T}dB`);
    expect(s).toContain(' ');
    expect(s).not.toContain(' ');
  });

  it('uses the true minus sign (U+2212), never a hyphen-minus', () => {
    const s = formatValue(-6, 'dB');
    expect(s).toBe(`${M}6.0${T}dB`);
    expect(s).not.toContain('-');
    expect(s.codePointAt(0)).toBe(0x2212);
  });

  it('can prefix a plus sign for positive values; zero never gets a sign', () => {
    expect(formatValue(3, 'dB', { signed: true })).toBe(`+3.0${T}dB`);
    expect(formatValue(-3, 'dB', { signed: true })).toBe(`${M}3.0${T}dB`);
    expect(formatValue(0, 'dB', { signed: true })).toBe(`0.0${T}dB`);
  });
});

describe('formatValue: the -0 and round-to-zero edge cases', () => {
  it('shows -0 as 0.0 dB (no sign)', () => {
    expect(formatValue(-0, 'dB')).toBe(`0.0${T}dB`);
  });

  it('shows a small negative that rounds to zero as unsigned zero', () => {
    expect(formatValue(-0.04, 'dB')).toBe(`0.0${T}dB`);
    expect(formatValue(-0.4, 'Hz')).toBe(`0${T}Hz`);
    expect(formatValue(-0.4, '%')).toBe(`0${T}%`);
    expect(formatValue(-0.04, 'ms')).toBe(`0.0${T}ms`);
    expect(formatValue(-0.04, 'ratio')).toBe('0.0 : 1');
  });

  it('keeps the sign when the value only just rounds away from zero', () => {
    expect(formatValue(-0.05, 'dB')).toBe(`${M}0.1${T}dB`);
  });
});

describe('formatValue: dB (1 decimal)', () => {
  it.each([
    [0, `0.0${T}dB`],
    [-6, `${M}6.0${T}dB`],
    [-6.04, `${M}6.0${T}dB`],
    [-6.05, `${M}6.1${T}dB`],
    [12.34, `12.3${T}dB`],
    [-96, `${M}96.0${T}dB`],
  ])('%s', (v, out) => expect(formatValue(v, 'dB')).toBe(out));

  it('rounds half away from zero without binary artefacts (1.005, 2.675)', () => {
    expect(formatValue(1.05, 'dB')).toBe(`1.1${T}dB`);
    expect(formatValue(2.675, 'dB', { decimals: 2 })).toBe(`2.68${T}dB`);
  });

  it('renders silence as minus infinity', () => {
    expect(formatValue(-Infinity, 'dB')).toBe(`${M}inf${T}dB`);
    expect(formatValue(Infinity, 'dB')).toBe(`inf${T}dB`);
  });
});

describe('formatValue: Hz (0 decimals below 1 k, kHz with 2 above)', () => {
  it.each([
    [20, `20${T}Hz`],
    [455, `455${T}Hz`],
    [455.4, `455${T}Hz`],
    [455.5, `456${T}Hz`],
    [999.4, `999${T}Hz`],
    [1000, `1.00${T}kHz`],
    [5490, `5.49${T}kHz`],
    [5494, `5.49${T}kHz`],
    [5495, `5.50${T}kHz`],
    [20000, `20.00${T}kHz`],
  ])('%s', (v, out) => expect(formatValue(v, 'Hz')).toBe(out));

  it('rolls over to kHz when rounding crosses 1000 (999.5 Hz -> 1.00 kHz, not "1000 Hz")', () => {
    expect(formatValue(999.5, 'Hz')).toBe(`1.00${T}kHz`);
    expect(formatValue(999.99, 'Hz')).toBe(`1.00${T}kHz`);
  });

  it('formats negative frequencies (offsets) with the true minus', () => {
    expect(formatValue(-1250, 'Hz')).toBe(`${M}1.25${T}kHz`);
    expect(formatValue(-12, 'Hz')).toBe(`${M}12${T}Hz`);
  });
});

describe('formatValue: ms (1 decimal below 100, else 0)', () => {
  it.each([
    [0, `0.0${T}ms`],
    [12.5, `12.5${T}ms`],
    [12.54, `12.5${T}ms`],
    [99.9, `99.9${T}ms`],
    [100, `100${T}ms`],
    [250.4, `250${T}ms`],
    [250.5, `251${T}ms`],
    [1250, `1250${T}ms`],
  ])('%s', (v, out) => expect(formatValue(v, 'ms')).toBe(out));

  it('shows 99.95 ms as "100 ms", not "100.0 ms"', () => {
    expect(formatValue(99.95, 'ms')).toBe(`100${T}ms`);
    expect(formatValue(99.99, 'ms')).toBe(`100${T}ms`);
    expect(formatValue(99.94, 'ms')).toBe(`99.9${T}ms`);
  });
});

describe('formatValue: % (0 decimals)', () => {
  it.each([
    [0, `0${T}%`],
    [70, `70${T}%`],
    [70.4, `70${T}%`],
    [70.5, `71${T}%`],
    [100, `100${T}%`],
    [-25, `${M}25${T}%`],
  ])('%s', (v, out) => expect(formatValue(v, '%')).toBe(out));
});

describe('formatValue: ratio (1 decimal, spaced colon, inf)', () => {
  it.each([
    [4, '4.0 : 1'],
    [2.5, '2.5 : 1'],
    [1, '1.0 : 1'],
    [20, '20.0 : 1'],
    [4.04, '4.0 : 1'],
    [4.05, '4.1 : 1'],
  ])('%s', (v, out) => expect(formatValue(v, 'ratio')).toBe(out));

  it('renders an infinite ratio as "inf : 1"', () => {
    expect(formatValue(Infinity, 'ratio')).toBe('inf : 1');
  });
});

describe('formatValue: options and non-numbers', () => {
  it('lets callers override decimals, except kHz which is always 2', () => {
    expect(formatValue(-6.04, 'dB', { decimals: 2 })).toBe(`${M}6.04${T}dB`);
    expect(formatValue(455, 'Hz', { decimals: 1 })).toBe(`455.0${T}Hz`);
    expect(formatValue(5490, 'Hz', { decimals: 0 })).toBe(`5.49${T}kHz`);
  });

  it('can return the number alone', () => {
    expect(formatValue(-6, 'dB', { unitless: true })).toBe(`${M}6.0`);
    expect(formatValue(5490, 'Hz', { unitless: true })).toBe('5.49');
    expect(formatValue(4, 'ratio', { unitless: true })).toBe('4.0');
  });

  it('renders NaN, null and undefined as an em dash', () => {
    expect(formatValue(NaN, 'dB')).toBe('—');
    expect(formatValue(null, 'Hz')).toBe('—');
    expect(formatValue(undefined, 'ms')).toBe('—');
  });

  it('survives exponent-notation magnitudes', () => {
    expect(formatValue(1e-7, 'dB')).toBe(`0.0${T}dB`);
    expect(formatValue(-1e-7, 'dB')).toBe(`0.0${T}dB`);
    // Not a realistic value; just must not produce NaN.
    expect(formatValue(1e21, 'dB')).toBe(`1e+21${T}dB`);
  });
});

describe('formatValueText (aria-valuetext)', () => {
  it('reads "Label, value unit"', () => {
    expect(formatValueText('Cutoff', 455, 'Hz')).toBe(`Cutoff, 455${T}Hz`);
    expect(formatValueText('Threshold', -18, 'dB')).toBe(`Threshold, ${M}18.0${T}dB`);
    expect(formatValueText('Ratio', Infinity, 'ratio')).toBe('Ratio, inf : 1');
  });
});
