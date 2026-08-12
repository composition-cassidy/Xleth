import { describe, expect, it } from 'vitest';
import {
  backendToY,
  degreesToPhaseOffset,
  detectPreset,
  formatLfoParameterCount,
  phaseOffsetToDegrees,
  readLfoNodeData,
  yToBackend,
  type LfoWaveformPoint,
} from './LfoEditor';

// Pure-function-only coverage, mirroring EnvelopeEditor.test.tsx's style: no
// component rendering (LfoShapeGraph/LfoEditor/LfoNodeBody need a canvas + DOM
// event model this suite deliberately does not stand up), just the ported
// Sampler codec (backendToY/yToBackend), preset detection, and the
// normalization delegation readLfoNodeData provides to the UI layer.

// Mirrors the private LFO_PRESETS_Y table inside LfoEditor.tsx (not exported —
// this file duplicates the three required-preset shapes on purpose, the same
// "mirror, don't generalize" convention the rest of this codebase uses).
const SINE_Y = [0, 0.707, 1, 0.707, 0, -0.707, -1, -0.707];
const TRIANGLE_Y = [0, 0.5, 1, 0.5, 0, -0.5, -1, -0.5];
const SQUARE_Y = [1, 1, 1, 1, -1, -1, -1, -1];
const ARBITRARY_Y = [0.1, -0.6, 0.3, 0.9, -0.2, 0.05, -0.8, 0.4];

describe('backendToY / yToBackend — 8-point Catmull-Rom codec round trip', () => {
  it('round-trips a known 8-point shape through yToBackend then backendToY within tolerance', () => {
    for (const shape of [SINE_Y, TRIANGLE_Y, SQUARE_Y, ARBITRARY_Y]) {
      const backend = yToBackend(shape);
      const roundTripped = backendToY(backend);
      expect(roundTripped).toHaveLength(8);
      for (let i = 0; i < 8; i += 1) {
        expect(roundTripped[i]).toBeCloseTo(shape[i], 2);
      }
    }
  });

  it('yToBackend returns COMMIT_SAMPLES(32)+1 points spanning t=[0,1], strictly ascending', () => {
    const backend = yToBackend(SINE_Y);
    expect(backend).toHaveLength(33);
    expect(backend[0].t).toBe(0);
    expect(backend.at(-1)!.t).toBe(1);
    for (let i = 1; i < backend.length; i += 1) {
      expect(backend[i].t).toBeGreaterThan(backend[i - 1].t);
    }
  });

  it('yToBackend closes the periodic loop: the last point equals the first Y control point', () => {
    const Y = [0.3, 0.6, 0.9, 0.2, -0.1, -0.5, -0.8, -0.3];
    const backend = yToBackend(Y);
    expect(backend.at(-1)!.v).toBeCloseTo(Y[0], 3);
  });

  it('backendToY falls back to a default 8-point sine for a missing or too-short waveform', () => {
    const fallbackForUndefined = backendToY(undefined);
    expect(fallbackForUndefined).toHaveLength(8);
    expect(backendToY([])).toEqual(fallbackForUndefined);
    expect(backendToY([{ t: 0, v: 0 }] as LfoWaveformPoint[])).toEqual(fallbackForUndefined);
    // The fallback is itself a sine: matches the sine shape within tolerance.
    for (let i = 0; i < 8; i += 1) {
      expect(fallbackForUndefined[i]).toBeCloseTo(Math.sin((i / 8) * Math.PI * 2), 3);
    }
  });

  it('backendToY sorts an out-of-order waveform before sampling', () => {
    const ordered = yToBackend(TRIANGLE_Y);
    const shuffled = [...ordered].reverse();
    expect(backendToY(shuffled)).toEqual(backendToY(ordered));
  });
});

describe('detectPreset', () => {
  it('detects sine/triangle/square from their own round-tripped backend waveform', () => {
    expect(detectPreset(yToBackend(SINE_Y))).toBe('sine');
    expect(detectPreset(yToBackend(TRIANGLE_Y))).toBe('triangle');
    expect(detectPreset(yToBackend(SQUARE_Y))).toBe('square');
  });

  it('matches within the per-sample tolerance, not just exact equality', () => {
    // A small nudge (well inside the 0.02-per-sample tolerance) still reads as square.
    const nearSquare = SQUARE_Y.map((v, i) => (i === 0 ? v - 0.01 : v));
    expect(detectPreset(yToBackend(nearSquare))).toBe('square');
  });

  it('returns null ("Custom") for a curve that matches no preset within tolerance', () => {
    expect(detectPreset(yToBackend(ARBITRARY_Y))).toBeNull();
  });

  it('a curve well outside every preset tolerance is not detected as any preset', () => {
    const farFromSquare = SQUARE_Y.map((v, i) => (i === 0 ? v - 0.4 : v));
    expect(detectPreset(yToBackend(farFromSquare))).not.toBe('square');
  });

  it('detects the same preset regardless of which node the waveform originated from (pure function of shape)', () => {
    // detectPreset only reads the waveform argument — calling it twice with an
    // equivalent (but distinct) array must produce the same result.
    const a = detectPreset(yToBackend([...TRIANGLE_Y]));
    const b = detectPreset(yToBackend([...TRIANGLE_Y]));
    expect(a).toBe(b);
    expect(a).toBe('triangle');
  });
});

describe('readLfoNodeData', () => {
  it('delegates to normalizeLfoNodeData, applying the closed-schema defaults for missing data', () => {
    expect(readLfoNodeData(undefined)).toMatchObject({
      label: 'LFO',
      rateMode: 'free',
      rateMs: 250,
      syncDivision: 4,
      phaseOffset: 0,
    });
  });

  it('repairs malformed fields per-field rather than falling back to the whole default object', () => {
    const data = readLfoNodeData({
      label: 'Tremolo',
      rateMs: -50, // out-of-range finite value clamps rather than falls back
      syncDivision: 3, // not a supported straight division
      phaseOffset: 1.25, // wraps into [0,1)
    } as Record<string, unknown>);
    expect(data.label).toBe('Tremolo'); // valid field untouched
    expect(data.rateMs).toBe(1); // clamped to the [1, 60000] floor
    expect(data.syncDivision).toBe(4); // repaired to the default division
    expect(data.phaseOffset).toBeCloseTo(0.25); // wrapped, not defaulted
  });

  it('drops unknown fields via the same closed schema as the graph model', () => {
    const data = readLfoNodeData({ bogus: 'nope', amount: 0.5 } as Record<string, unknown>);
    expect(data).not.toHaveProperty('bogus');
    expect(data).not.toHaveProperty('amount');
  });
});

describe('formatLfoParameterCount', () => {
  it('pluralizes correctly and floors/clamps non-finite or negative input to 0', () => {
    expect(formatLfoParameterCount(0)).toBe('0 params');
    expect(formatLfoParameterCount(1)).toBe('1 param');
    expect(formatLfoParameterCount(2)).toBe('2 params');
    expect(formatLfoParameterCount(2.9)).toBe('2 params');
    expect(formatLfoParameterCount(-3)).toBe('0 params');
    expect(formatLfoParameterCount(Number.NaN)).toBe('0 params');
  });
});

// The model stores phase as a 0..1 cycle fraction; the editor speaks degrees
// (0..360), matching how every other DAW labels LFO phase. These two helpers are
// the only conversion point, so they carry the wrapping contract.
describe('LFO phase degree conversion', () => {
  it('maps cycle fractions to degrees', () => {
    expect(phaseOffsetToDegrees(0)).toBe(0);
    expect(phaseOffsetToDegrees(0.25)).toBe(90);
    expect(phaseOffsetToDegrees(0.5)).toBe(180);
    expect(phaseOffsetToDegrees(0.75)).toBe(270);
  });

  it('maps degrees back to cycle fractions', () => {
    expect(degreesToPhaseOffset(0)).toBeCloseTo(0);
    expect(degreesToPhaseOffset(90)).toBeCloseTo(0.25);
    expect(degreesToPhaseOffset(180)).toBeCloseTo(0.5);
    expect(degreesToPhaseOffset(270)).toBeCloseTo(0.75);
  });

  it('wraps a full turn back onto zero in both directions', () => {
    expect(degreesToPhaseOffset(360)).toBeCloseTo(0);
    expect(degreesToPhaseOffset(450)).toBeCloseTo(0.25);
    expect(degreesToPhaseOffset(-90)).toBeCloseTo(0.75);
    expect(phaseOffsetToDegrees(1)).toBe(0);
    expect(phaseOffsetToDegrees(1.25)).toBe(90);
    expect(phaseOffsetToDegrees(-0.25)).toBe(270);
  });

  it('round-trips every quarter turn', () => {
    for (const degrees of [0, 45, 90, 135, 180, 225, 270, 315]) {
      expect(phaseOffsetToDegrees(degreesToPhaseOffset(degrees))).toBe(degrees);
    }
  });

  it('falls back to zero for non-finite input rather than emitting NaN', () => {
    expect(phaseOffsetToDegrees(Number.NaN)).toBe(0);
    expect(degreesToPhaseOffset(Number.NaN)).toBe(0);
    expect(degreesToPhaseOffset(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
