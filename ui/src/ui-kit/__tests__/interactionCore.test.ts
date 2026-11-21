import { describe, expect, it } from 'vitest';
import { MINUS } from '../format';
import { parseSyncDivision, parseValue, syncBeats, syncCodec, syncLabel } from '../parse';
import { beginDrag, moveDrag, stepValue, type DragConfig } from '../valueDragCore';
import { clampToScale, dbTaperScale, linearScale, logScale, skewScale } from '../valueScale';

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('scales', () => {
  it('linear maps both ways and clamps', () => {
    const s = linearScale(-60, 0);
    expect(s.toNorm(-30)).toBe(0.5);
    expect(s.fromNorm(0.5)).toBe(-30);
    expect(s.fromNorm(2)).toBe(0);
    expect(s.toNorm(-90)).toBe(0);
  });

  it('skew matches the legacy sampler Knob law', () => {
    const s = skewScale(0, 100, 0.4);
    close(s.toNorm(25), 0.25 ** 0.4);
    close(s.fromNorm(s.toNorm(25)), 25, 1e-6);
    // skew 1 is exactly linear
    expect(skewScale(0, 10, 1).fromNorm(0.3)).toBeCloseTo(3);
  });

  it('log gives equal ratios per pixel', () => {
    const s = logScale(20, 20000);
    close(s.fromNorm(0), 20);
    close(s.fromNorm(1), 20000, 1e-6);
    close(s.fromNorm(0.5), Math.sqrt(20 * 20000), 1e-6);
    close(s.toNorm(632.4555320336759), 0.5, 1e-9);
  });

  it('dB taper: 0 -> -inf, 0.75 -> 0 dB, 1 -> +12 dB, round-trips', () => {
    expect(dbTaperScale.fromNorm(0)).toBe(-Infinity);
    close(dbTaperScale.fromNorm(0.75), 0);
    expect(dbTaperScale.fromNorm(1)).toBe(12);
    expect(dbTaperScale.toNorm(-Infinity)).toBe(0);
    expect(dbTaperScale.toNorm(12)).toBe(1);
    for (const db of [-60, -24, -6, 0, 3, 9]) close(dbTaperScale.fromNorm(dbTaperScale.toNorm(db)), db, 1e-9);
  });

  it('clampToScale pins values to the scale bounds', () => {
    const s = linearScale(1, 100);
    expect(clampToScale(s, 500)).toBe(100);
    expect(clampToScale(s, -3)).toBe(1);
    expect(clampToScale(dbTaperScale, -200)).toBe(-Infinity);
  });
});

describe('drag law', () => {
  const cfg: DragConfig = { scale: linearScale(0, 100), axis: 'y', pxPerRange: 200 };

  it('vertical: dragging UP increases, over a fixed pixel travel', () => {
    const st = beginDrag(cfg, 50, 400, false);
    expect(moveDrag(cfg, st, 300, false)).toBe(100); // 100px up of 200px travel = +50
    expect(moveDrag(cfg, st, 500, false)).toBe(0); // clamped at the bottom
  });

  it('horizontal: dragging RIGHT increases', () => {
    const h: DragConfig = { ...cfg, axis: 'x' };
    const st = beginDrag(h, 0, 100, false);
    expect(moveDrag(h, st, 140, false)).toBe(20);
  });

  it('range is independent of the parameter span (px per range, not per unit)', () => {
    const wide: DragConfig = { ...cfg, scale: linearScale(0, 1000) };
    const st = beginDrag(wide, 0, 0, false);
    expect(moveDrag(wide, st, -100, false)).toBe(500);
  });

  it('Shift is fine (x0.1)', () => {
    const st = beginDrag(cfg, 50, 400, true);
    close(moveDrag(cfg, st, 300, true), 55);
  });

  it('toggling Shift mid-drag rebases instead of jumping', () => {
    const st = beginDrag(cfg, 0, 400, false);
    expect(moveDrag(cfg, st, 300, false)).toBe(50); // 100px coarse
    // Shift pressed here: the value must stay put at this exact pointer position...
    close(moveDrag(cfg, st, 300, true), 50);
    // ...and then move 10x slower.
    close(moveDrag(cfg, st, 200, true), 55);
    // Releasing Shift rebases again, no jump.
    close(moveDrag(cfg, st, 200, false), 55);
    expect(moveDrag(cfg, st, 100, false)).toBe(100); // clamps at the top
  });

  it('a drag that started with Shift stays fine after Shift is released', () => {
    const st = beginDrag(cfg, 50, 400, true);
    close(moveDrag(cfg, st, 300, false), 55);
  });

  it('quantises emitted values and clamps them', () => {
    const q: DragConfig = { ...cfg, quantize: (v) => Math.round(v) };
    const st = beginDrag(q, 0, 400, false);
    expect(moveDrag(q, st, 398.5, false)).toBe(1); // 0.75 rounds to 1
  });

  it('marks the state moved and remembers the last value', () => {
    const st = beginDrag(cfg, 10, 0, false);
    expect(st.moved).toBe(false);
    const v = moveDrag(cfg, st, -20, false);
    expect(st.moved).toBe(true);
    expect(st.lastValue).toBe(v);
    expect(st.startValue).toBe(10); // what Escape returns to
  });
});

describe('stepping', () => {
  it('norm steps are 1% of the sweep; Shift x10; fine x0.1', () => {
    const cfg = { scale: linearScale(0, 100) };
    expect(stepValue(cfg, 50, 1)).toBe(51);
    expect(stepValue(cfg, 50, 1, 10)).toBe(60);
    close(stepValue(cfg, 50, -1, 0.1), 49.9);
  });

  it('value steps (integers) override norm steps and clamp', () => {
    const cfg = { scale: linearScale(0, 8), step: 1 };
    expect(stepValue(cfg, 7, 1, 10)).toBe(8);
    expect(stepValue(cfg, 0, -1)).toBe(0);
  });

  it('steps up from -inf on the fader taper', () => {
    const up = stepValue({ scale: dbTaperScale }, -Infinity, 1);
    expect(Number.isFinite(up)).toBe(true);
    expect(up).toBeLessThan(-80);
  });
});

describe('parseValue: dB', () => {
  it.each([
    ['-6', -6],
    ['-6 dB', -6],
    [`${MINUS}6.5dB`, -6.5],
    ['+3', 3],
    ['  0 DB ', 0],
    ['-inf', -Infinity],
    [`${MINUS}inf dB`, -Infinity],
    ['-∞', -Infinity],
  ])('%s -> %s', (text, expected) => expect(parseValue(text, 'dB')).toBe(expected));

  it.each(['abc', '', '6 Hz', '--6', 'inf'])('rejects %j', (text) => expect(parseValue(text, 'dB')).toBeNull());
});

describe('parseValue: Hz', () => {
  it.each([
    ['440', 440],
    ['440 Hz', 440],
    ['5k', 5000],
    ['5K', 5000],
    ['1.2 kHz', 1200],
    ['5.49 kHz', 5490],
    ['.5k', 500],
    ['20hz', 20],
  ])('%s -> %s', (text, expected) => expect(parseValue(text, 'Hz')).toBeCloseTo(expected as number));

  it.each(['k', '5 dB', 'hz'])('rejects %j', (text) => expect(parseValue(text, 'Hz')).toBeNull());
});

describe('parseValue: ms, %, ratio', () => {
  it('ms accepts seconds', () => {
    expect(parseValue('250', 'ms')).toBe(250);
    expect(parseValue('12.5 ms', 'ms')).toBe(12.5);
    expect(parseValue('0.5 s', 'ms')).toBe(500);
    expect(parseValue('2s', 'ms')).toBe(2000);
  });

  it('percent', () => {
    expect(parseValue('70', '%')).toBe(70);
    expect(parseValue('70 %', '%')).toBe(70);
    expect(parseValue('7x', '%')).toBeNull();
  });

  it('ratio: n, n:1, spaced colon, n:m, inf', () => {
    expect(parseValue('4', 'ratio')).toBe(4);
    expect(parseValue('4:1', 'ratio')).toBe(4);
    expect(parseValue('4.0 : 1', 'ratio')).toBe(4);
    expect(parseValue('8:2', 'ratio')).toBe(4);
    expect(parseValue('inf : 1', 'ratio')).toBe(Infinity);
    expect(parseValue('inf', 'ratio')).toBe(Infinity);
    expect(parseValue('4:0', 'ratio')).toBeNull();
  });

  it('thin spaces from formatValue output parse back', () => {
    expect(parseValue('−6.0 dB', 'dB')).toBe(-6);
    expect(parseValue('5.49 kHz', 'Hz')).toBeCloseTo(5490);
    expect(parseValue('70 %', '%')).toBe(70);
  });
});

describe('tempo-synced values', () => {
  it('parses divisions with D / T / dotted / triplet spellings', () => {
    expect(syncLabel(parseSyncDivision('1/8d')!)).toBe('1/8D');
    expect(syncLabel(parseSyncDivision('1/8 dotted')!)).toBe('1/8D');
    expect(syncLabel(parseSyncDivision('1/8.')!)).toBe('1/8D');
    expect(syncLabel(parseSyncDivision('1/8T')!)).toBe('1/8T');
    expect(syncLabel(parseSyncDivision('1/16 triplet')!)).toBe('1/16T');
    expect(syncLabel(parseSyncDivision('1/4')!)).toBe('1/4');
    expect(parseSyncDivision('1/0')).toBeNull();
    expect(parseSyncDivision('eighth')).toBeNull();
  });

  it('length in beats', () => {
    expect(syncBeats(parseSyncDivision('1/4')!)).toBe(1);
    expect(syncBeats(parseSyncDivision('1/8')!)).toBe(0.5);
    expect(syncBeats(parseSyncDivision('1/8D')!)).toBe(0.75);
    close(syncBeats(parseSyncDivision('1/8T')!), 1 / 3);
    expect(syncBeats(parseSyncDivision('1/1')!)).toBe(4);
  });

  it('the codec maps typed text to an index and back', () => {
    const c = syncCodec(['1/16', '1/8T', '1/8', '1/8D', '1/4']);
    expect(c.min).toBe(0);
    expect(c.max).toBe(4);
    expect(c.parse('1/8d')).toBe(3);
    expect(c.parse('1/8 triplet')).toBe(1);
    expect(c.parse('1/32')).toBeNull(); // not in this control's list
    expect(c.format(3)).toBe('1/8D');
    expect(c.format(99)).toBe('1/4');
  });
});
