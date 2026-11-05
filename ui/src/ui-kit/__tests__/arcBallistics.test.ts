import { describe, expect, it } from 'vitest';
import { ARC_START_DEG, arcPath, knobGeometry, normToDeg, polar } from '../arc';
import { initialMeterState, isSettled, stepMeter } from '../meterBallistics';

describe('arc geometry', () => {
  it('maps the range onto a 270 degree sweep opening at the bottom', () => {
    expect(normToDeg(0)).toBe(135);
    expect(normToDeg(0.5)).toBe(270); // straight up
    expect(normToDeg(1)).toBe(405);
    const [x, y] = polar(16, 16, 10, normToDeg(0.5));
    expect(x).toBeCloseTo(16);
    expect(y).toBeCloseTo(6); // up is smaller y
  });

  it('draws nothing for a zero-length arc', () => {
    expect(arcPath(16, 16, 12, 200, 200)).toBe('');
  });

  it('marks arcs longer than half a turn as large', () => {
    expect(arcPath(16, 16, 12, 135, 405)).toMatch(/ 0 1 1 /);
    expect(arcPath(16, 16, 12, 135, 200)).toMatch(/ 0 0 1 /);
  });

  it('unipolar value arc starts at the minimum', () => {
    const g = knobGeometry(0.25, null, 32);
    expect(g.zero).toBeNull();
    const [sx, sy] = polar(16, 16, 12, ARC_START_DEG);
    expect(g.value.startsWith(`M ${Math.round(sx * 100) / 100} ${Math.round(sy * 100) / 100}`)).toBe(true);
  });

  it('bipolar value arc starts at the centre, runs either way, and is empty at the centre', () => {
    const centre = 0.5;
    const up = knobGeometry(0.75, centre, 32);
    const down = knobGeometry(0.25, centre, 32);
    const [cx, cy] = polar(16, 16, 12, normToDeg(centre));
    const start = `M ${Math.round(cx * 100) / 100} ${Math.round(cy * 100) / 100}`;
    expect(up.value.startsWith(start)).toBe(true);
    // Going down, the arc is drawn clockwise from the value to the centre, so it ENDS at the centre.
    const end = `${Math.round(cx * 100) / 100} ${Math.round(cy * 100) / 100}`;
    expect(down.value.endsWith(end)).toBe(true);
    expect(knobGeometry(centre, centre, 32).value).toBe('');
    expect(up.zero).not.toBeNull();
  });

  it('the pointer crosses the ring (extends past the arc radius)', () => {
    const g = knobGeometry(0.5, null, 32);
    const r = 16 - 4;
    const outer = Math.hypot(g.pointer.x2 - 16, g.pointer.y2 - 16);
    const inner = Math.hypot(g.pointer.x1 - 16, g.pointer.y1 - 16);
    expect(outer).toBeGreaterThan(r);
    expect(inner).toBeLessThan(r);
  });

  it('clamps an out-of-range norm', () => {
    expect(() => knobGeometry(2, null, 32)).not.toThrow();
    expect(knobGeometry(-1, null, 32).value).toBe('');
  });
});

describe('meter ballistics (dB)', () => {
  const o = { min: -60 };

  it('attacks instantly', () => {
    const { state } = stepMeter(initialMeterState(-60), -6, 16, o);
    expect(state.level).toBe(-6);
    expect(state.peak).toBe(-6);
  });

  it('releases linearly in dB, not in amplitude', () => {
    let s = stepMeter(initialMeterState(-60), 0, 16, o).state;
    // 24 dB/s for one second with silence below.
    s = stepMeter(s, -60, 1000, o).state;
    expect(s.level).toBeCloseTo(-24);
    s = stepMeter(s, -60, 1000, o).state;
    expect(s.level).toBeCloseTo(-48); // the same 24 dB per second at every level
  });

  it('never falls below the input or the floor', () => {
    let s = stepMeter(initialMeterState(-60), -10, 16, o).state;
    s = stepMeter(s, -12, 10000, o).state;
    expect(s.level).toBe(-12);
    s = stepMeter(s, -Infinity, 100000, o).state;
    expect(s.level).toBe(-60);
  });

  it('holds the peak, then lets it fall (but never under the live level)', () => {
    let s = stepMeter(initialMeterState(-60), -6, 16, o).state;
    s = stepMeter(s, -60, 1000, o).state; // inside the 1500 ms hold
    expect(s.peak).toBe(-6);
    s = stepMeter(s, -60, 600, o).state; // hold expires
    expect(s.peak).toBe(-6);
    s = stepMeter(s, -60, 1000, o).state; // now falling at 12 dB/s
    expect(s.peak).toBeCloseTo(-18);
    expect(s.peak).toBeGreaterThanOrEqual(s.level);
  });

  it('a new higher level re-arms the hold', () => {
    let s = stepMeter(initialMeterState(-60), -20, 16, o).state;
    s = stepMeter(s, -60, 2000, o).state;
    s = stepMeter(s, -10, 16, o).state;
    expect(s.peak).toBe(-10);
    expect(s.hold).toBe(1500);
  });

  it('reports clipping at or above clipDb, and only then', () => {
    expect(stepMeter(initialMeterState(-60), -0.1, 16, o).clipped).toBe(false);
    expect(stepMeter(initialMeterState(-60), 0, 16, o).clipped).toBe(true);
    expect(stepMeter(initialMeterState(-60), 3, 16, o).clipped).toBe(true);
    expect(stepMeter(initialMeterState(-60), -3, 16, { min: -60, clipDb: -3 }).clipped).toBe(true);
  });

  it('settles once level and peak are back at the floor', () => {
    expect(isSettled(initialMeterState(-60), -60)).toBe(true);
    expect(isSettled({ level: -20, peak: -20, hold: 0 }, -60)).toBe(false);
  });

  it('treats NaN as silence', () => {
    expect(stepMeter(initialMeterState(-60), NaN, 16, o).state.level).toBe(-60);
  });
});
