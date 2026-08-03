import { describe, it, expect } from 'vitest'
import {
  clamp01,
  clamp,
  styleIndexOf,
  styleDsp,
  isLegacyBackend,
  backendTag,
  sizeScale,
  modalDelaysMs,
  diffuserDelaysMs,
  lateOnsetMs,
  effectiveRt60Sec,
  decayAmplitude,
  dampingCoeff,
  hfLossPerPass,
  meanDampingPassMs,
  hfAmplitude,
  hfRt60Ms,
  erLateBalance,
  erArrivals,
  plateBloomStages,
  recirculationTimesMs,
  modLfoHz,
  modExcursionSamples,
  modIntensity,
  timeToNorm,
  normToTime,
  ampToNorm,
  formatSeconds,
  formatTimeMs,
  REVERB_STYLE_DSP,
  REVERB_STYLE_LABELS,
  STYLE_GENERIC,
  STYLE_ROOM,
  STYLE_PLATE,
  STYLE_HALL,
  AXIS_T_MIN_MS,
  AXIS_T_MAX_MS,
} from '../reverbVizMath.js'

const ALL_STYLES = [STYLE_GENERIC, STYLE_ROOM, STYLE_PLATE, STYLE_HALL]

// ── Basics ───────────────────────────────────────────────────────────────────

describe('clamp01 / clamp', () => {
  it('passes through values already in range', () => {
    expect(clamp01(0)).toBe(0)
    expect(clamp01(0.5)).toBe(0.5)
    expect(clamp01(1)).toBe(1)
    expect(clamp(5, 0, 10)).toBe(5)
  })
  it('clamps outside the range', () => {
    expect(clamp01(-0.001)).toBe(0)
    expect(clamp01(999)).toBe(1)
    expect(clamp(-3, 0, 10)).toBe(0)
    expect(clamp(30, 0, 10)).toBe(10)
  })
})

// ── Style identity ───────────────────────────────────────────────────────────

describe('styleIndexOf', () => {
  it('passes valid indices through', () => {
    for (const s of ALL_STYLES) expect(styleIndexOf(s)).toBe(s)
  })
  it('rounds the float the bridge surfaces for a choice param', () => {
    expect(styleIndexOf(2.0000001)).toBe(2)
    expect(styleIndexOf(1.9999)).toBe(2)
    expect(styleIndexOf(0.4)).toBe(0)
  })
  it('clamps out-of-range and non-numeric input', () => {
    expect(styleIndexOf(-5)).toBe(0)
    expect(styleIndexOf(99)).toBe(3)
    expect(styleIndexOf(undefined)).toBe(0)
    expect(styleIndexOf(null)).toBe(0)
    expect(styleIndexOf('nonsense')).toBe(0)
  })
})

describe('REVERB_STYLE_DSP', () => {
  it('has one entry per engine style, in engine order', () => {
    expect(REVERB_STYLE_DSP).toHaveLength(4)
    expect(REVERB_STYLE_LABELS).toEqual(['GENERIC', 'ROOM', 'PLATE', 'HALL'])
    REVERB_STYLE_DSP.forEach((d, i) => expect(d.label).toBe(REVERB_STYLE_LABELS[i]))
  })

  it('mirrors the engine line counts: 8 / 8 / 4 tank / 16', () => {
    expect(styleDsp(STYLE_GENERIC).modalDelays).toHaveLength(8)
    expect(styleDsp(STYLE_ROOM).modalDelays).toHaveLength(8)
    expect(styleDsp(STYLE_PLATE).modalDelays).toHaveLength(4)
    expect(styleDsp(STYLE_HALL).modalDelays).toHaveLength(16)
  })

  it('mirrors the engine input-diffusion stage counts: 0 / 2 / 4 / 3', () => {
    expect(styleDsp(STYLE_GENERIC).diffuserDelays).toHaveLength(0)
    expect(styleDsp(STYLE_ROOM).diffuserDelays).toHaveLength(2)
    expect(styleDsp(STYLE_PLATE).diffuserDelays).toHaveLength(4)
    expect(styleDsp(STYLE_HALL).diffuserDelays).toHaveLength(3)
  })

  it('gives Plate no ER taps — it has no ER bus at all', () => {
    expect(styleDsp(STYLE_PLATE).erTaps).toHaveLength(0)
    expect(styleDsp(STYLE_GENERIC).erTaps).toHaveLength(12)
    expect(styleDsp(STYLE_ROOM).erTaps).toHaveLength(8)
    expect(styleDsp(STYLE_HALL).erTaps).toHaveLength(10)
  })

  it('mirrors the engine decayScale values', () => {
    expect(styleDsp(STYLE_GENERIC).decayScale).toBeCloseTo(1.0, 9)
    expect(styleDsp(STYLE_ROOM).decayScale).toBeCloseTo(0.75, 9)
    expect(styleDsp(STYLE_PLATE).decayScale).toBeCloseTo(1.0, 9)
    expect(styleDsp(STYLE_HALL).decayScale).toBeCloseTo(1.40, 9)
  })

  it('has one LFO rate per delay line on the FDN styles', () => {
    for (const s of [STYLE_GENERIC, STYLE_ROOM, STYLE_HALL]) {
      expect(styleDsp(s).modRates).toHaveLength(styleDsp(s).modalDelays.length)
    }
  })

  it('clamps the style index like every other accessor', () => {
    expect(styleDsp(99)).toBe(REVERB_STYLE_DSP[3])
    expect(styleDsp(-1)).toBe(REVERB_STYLE_DSP[0])
  })
})

// ── Legacy backend detection ─────────────────────────────────────────────────

describe('isLegacyBackend', () => {
  it('is true only for Generic at exactly smoothness 0', () => {
    expect(isLegacyBackend(STYLE_GENERIC, 0)).toBe(true)
  })
  it('is false for Generic once RING TAME leaves zero', () => {
    expect(isLegacyBackend(STYLE_GENERIC, 0.5)).toBe(false)
    expect(isLegacyBackend(STYLE_GENERIC, 100)).toBe(false)
  })
  it('is false for every other style regardless of smoothness', () => {
    for (const s of [STYLE_ROOM, STYLE_PLATE, STYLE_HALL]) {
      expect(isLegacyBackend(s, 0)).toBe(false)
      expect(isLegacyBackend(s, 50)).toBe(false)
    }
  })
})

describe('backendTag', () => {
  it('names the legacy path on Generic at RING TAME 0', () => {
    expect(backendTag(STYLE_GENERIC, 0)).toBe('LEGACY FDN')
  })
  it('names the enhanced path once RING TAME is engaged', () => {
    expect(backendTag(STYLE_GENERIC, 20)).toBe('8-LINE FDN')
  })
  it('names each dedicated backend', () => {
    expect(backendTag(STYLE_ROOM, 0)).toBe('8-LINE FDN')
    expect(backendTag(STYLE_PLATE, 0)).toBe('DATTORRO TANK')
    expect(backendTag(STYLE_HALL, 0)).toBe('16-LINE FDN')
  })
})

// ── Size ─────────────────────────────────────────────────────────────────────

describe('sizeScale', () => {
  it('matches the engine mapping (size/100)*0.5 + 0.75', () => {
    expect(sizeScale(0)).toBeCloseTo(0.75, 9)
    expect(sizeScale(50)).toBeCloseTo(1.0, 9)
    expect(sizeScale(100)).toBeCloseTo(1.25, 9)
  })
  it('clamps outside 0–100', () => {
    expect(sizeScale(-20)).toBeCloseTo(0.75, 9)
    expect(sizeScale(200)).toBeCloseTo(1.25, 9)
  })
})

describe('modalDelaysMs', () => {
  it('converts the engine sample tables to ms at 48 kHz', () => {
    // Room's shortest line is 277 samples → 277/48 ms at sizeScale 1.
    const room = modalDelaysMs(STYLE_ROOM, 50)
    expect(Math.min(...room)).toBeCloseTo(277 / 48, 6)
    // Hall's longest is 2999 samples.
    const hall = modalDelaysMs(STYLE_HALL, 50)
    expect(Math.max(...hall)).toBeCloseTo(2999 / 48, 6)
  })

  it('scales every line with size', () => {
    const small = modalDelaysMs(STYLE_HALL, 0)
    const large = modalDelaysMs(STYLE_HALL, 100)
    small.forEach((v, i) => expect(large[i] / v).toBeCloseTo(1.25 / 0.75, 6))
  })

  it('swaps Generic to the frozen legacy delay set at RING TAME 0', () => {
    const legacy = modalDelaysMs(STYLE_GENERIC, 50, 0)
    const enhanced = modalDelaysMs(STYLE_GENERIC, 50, 50)
    // 809 vs 601 samples for the shortest line — a genuinely different network.
    expect(Math.min(...legacy)).toBeCloseTo(809 / 48, 6)
    expect(Math.min(...enhanced)).toBeCloseTo(601 / 48, 6)
    expect(legacy).not.toEqual(enhanced)
  })

  it('keeps Room the shortest and Hall the longest network', () => {
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length
    expect(mean(modalDelaysMs(STYLE_ROOM, 50)))
      .toBeLessThan(mean(modalDelaysMs(STYLE_GENERIC, 50)))
    expect(mean(modalDelaysMs(STYLE_GENERIC, 50)))
      .toBeLessThan(mean(modalDelaysMs(STYLE_HALL, 50)))
  })
})

describe('diffuserDelaysMs', () => {
  it('returns one entry per engine diffusion stage', () => {
    expect(diffuserDelaysMs(STYLE_GENERIC)).toEqual([])
    expect(diffuserDelaysMs(STYLE_ROOM)).toHaveLength(2)
    expect(diffuserDelaysMs(STYLE_HALL)).toHaveLength(3)
    expect(diffuserDelaysMs(STYLE_PLATE)).toHaveLength(4)
  })
  it('converts samples to ms at 48 kHz', () => {
    expect(diffuserDelaysMs(STYLE_PLATE)[0]).toBeCloseTo(149 / 48, 6)
  })
})

// ── Onset ────────────────────────────────────────────────────────────────────

describe('lateOnsetMs', () => {
  it('is pre-delay plus the shortest line on FDN styles', () => {
    expect(lateOnsetMs(STYLE_ROOM, 50, 10)).toBeCloseTo(10 + 277 / 48, 6)
  })
  it('uses the shortest output TAP on Plate, not its shortest tank delay', () => {
    // 195 samples ≈ 4.06 ms — far earlier than the 5102-sample delay it reads
    // from. A plate speaks immediately; that is the point.
    const onset = lateOnsetMs(STYLE_PLATE, 50, 0)
    expect(onset).toBeCloseTo(195 / 48, 6)
    expect(onset).toBeLessThan(lateOnsetMs(STYLE_HALL, 50, 0))
  })
  it('moves one-for-one with pre-delay', () => {
    const a = lateOnsetMs(STYLE_HALL, 50, 0)
    const b = lateOnsetMs(STYLE_HALL, 50, 40)
    expect(b - a).toBeCloseTo(40, 6)
  })
  it('grows with size', () => {
    expect(lateOnsetMs(STYLE_HALL, 100, 0)).toBeGreaterThan(lateOnsetMs(STYLE_HALL, 0, 0))
  })
  it('treats a missing pre-delay as zero rather than NaN', () => {
    expect(Number.isFinite(lateOnsetMs(STYLE_GENERIC, 50, undefined))).toBe(true)
  })
})

// ── Decay ────────────────────────────────────────────────────────────────────

describe('effectiveRt60Sec', () => {
  it('applies the per-style decayScale', () => {
    expect(effectiveRt60Sec(2, STYLE_GENERIC)).toBeCloseTo(2.0, 9)
    expect(effectiveRt60Sec(2, STYLE_ROOM)).toBeCloseTo(1.5, 9)
    expect(effectiveRt60Sec(2, STYLE_PLATE)).toBeCloseTo(2.0, 9)
    expect(effectiveRt60Sec(2, STYLE_HALL)).toBeCloseTo(2.8, 9)
  })
  it('makes Hall the longest and Room the shortest at one knob position', () => {
    const at = (s) => effectiveRt60Sec(5, s)
    expect(at(STYLE_ROOM)).toBeLessThan(at(STYLE_GENERIC))
    expect(at(STYLE_GENERIC)).toBeLessThan(at(STYLE_HALL))
  })
  it('floors the decay knob at its engine minimum', () => {
    expect(effectiveRt60Sec(0, STYLE_GENERIC)).toBeCloseTo(0.1, 9)
    expect(effectiveRt60Sec(-4, STYLE_GENERIC)).toBeCloseTo(0.1, 9)
  })
})

describe('decayAmplitude', () => {
  it('is unity at the onset', () => {
    expect(decayAmplitude(0, 2)).toBe(1)
    expect(decayAmplitude(-5, 2)).toBe(1)
  })
  it('is exactly -60 dB at t = RT60, by definition', () => {
    expect(decayAmplitude(2000, 2)).toBeCloseTo(1e-3, 9)
    expect(decayAmplitude(30000, 30)).toBeCloseTo(1e-3, 9)
  })
  it('is -30 dB at half of RT60', () => {
    expect(20 * Math.log10(decayAmplitude(1000, 2))).toBeCloseTo(-30, 6)
  })
  it('decreases monotonically', () => {
    let prev = Infinity
    for (const t of [0, 100, 500, 1000, 4000]) {
      const a = decayAmplitude(t, 2)
      expect(a).toBeLessThan(prev)
      prev = a
    }
  })
})

// ── Damping ──────────────────────────────────────────────────────────────────

describe('dampingCoeff', () => {
  it('matches the FDN formula damping/100 + offset + smooth*0.20', () => {
    expect(dampingCoeff(50, STYLE_GENERIC, 0)).toBeCloseTo(0.5, 9)
    expect(dampingCoeff(50, STYLE_ROOM, 0)).toBeCloseTo(0.65, 9)     // +0.15 offset
    expect(dampingCoeff(50, STYLE_GENERIC, 100)).toBeCloseTo(0.7, 9) // +0.20 smooth
  })
  it('matches the Plate formula 0.05 + (damping/100)*0.55 + smooth*0.20', () => {
    expect(dampingCoeff(0, STYLE_PLATE, 0)).toBeCloseTo(0.05, 9)
    expect(dampingCoeff(100, STYLE_PLATE, 0)).toBeCloseTo(0.60, 9)
    expect(dampingCoeff(0, STYLE_PLATE, 50)).toBeCloseTo(0.15, 9)
  })
  it('respects each style ceiling (0.95 FDN, 0.90 Plate)', () => {
    expect(dampingCoeff(100, STYLE_ROOM, 100)).toBeCloseTo(0.95, 9)
    expect(dampingCoeff(100, STYLE_PLATE, 100)).toBeCloseTo(0.80, 9)
    expect(dampingCoeff(100, STYLE_PLATE, 100)).toBeLessThanOrEqual(0.9)
  })
  it('never returns a coefficient outside [0, ceiling]', () => {
    for (const s of ALL_STYLES) {
      for (const d of [-50, 0, 33, 100, 250]) {
        for (const sm of [0, 50, 100]) {
          const g = dampingCoeff(d, s, sm)
          expect(g).toBeGreaterThanOrEqual(0)
          expect(g).toBeLessThanOrEqual(styleDsp(s).dampingCeiling + 1e-9)
        }
      }
    }
  })
})

describe('hfLossPerPass', () => {
  it('is unity (no HF loss) when the coefficient is zero', () => {
    expect(hfLossPerPass(0, STYLE_GENERIC, 0)).toBeCloseTo(1, 9)
  })
  it('matches the one-pole Nyquist gain (1-g)/(1+g)', () => {
    const g = dampingCoeff(50, STYLE_GENERIC, 0)
    expect(hfLossPerPass(50, STYLE_GENERIC, 0)).toBeCloseTo((1 - g) / (1 + g), 9)
  })
  it('falls monotonically as damping rises', () => {
    let prev = Infinity
    for (const d of [0, 25, 50, 75, 100]) {
      const l = hfLossPerPass(d, STYLE_GENERIC, 0)
      expect(l).toBeLessThan(prev)
      prev = l
    }
  })
  it('keeps a Plate HF floor even at damping 0 (engine 0.05 floor)', () => {
    const l = hfLossPerPass(0, STYLE_PLATE, 0)
    expect(l).toBeLessThan(1)
    expect(l).toBeCloseTo(0.95 / 1.05, 9)
  })
  it('stays inside (0, 1]', () => {
    for (const s of ALL_STYLES) {
      for (const d of [0, 50, 100]) {
        const l = hfLossPerPass(d, s, 100)
        expect(l).toBeGreaterThan(0)
        expect(l).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('meanDampingPassMs', () => {
  it('is the mean line length on FDN styles', () => {
    const delays = modalDelaysMs(STYLE_HALL, 50)
    const mean = delays.reduce((a, b) => a + b, 0) / delays.length
    expect(meanDampingPassMs(STYLE_HALL, 50)).toBeCloseTo(mean, 6)
  })
  it('is half the Plate round trip — the LPF sits at each arm input', () => {
    // Dattorro round trip at sizeScale 1 is ~725 ms, so a pass is ~363 ms.
    const pass = meanDampingPassMs(STYLE_PLATE, 50)
    expect(pass).toBeGreaterThan(340)
    expect(pass).toBeLessThan(390)
  })
  it('is positive and finite for every style and size', () => {
    for (const s of ALL_STYLES) {
      for (const size of [0, 50, 100]) {
        const v = meanDampingPassMs(s, size)
        expect(Number.isFinite(v)).toBe(true)
        expect(v).toBeGreaterThan(0)
      }
    }
  })
})

describe('hfAmplitude', () => {
  it('equals the broadband envelope when there is no HF loss', () => {
    for (const t of [0, 250, 1000]) {
      expect(hfAmplitude(t, 2, 30, 1)).toBeCloseTo(decayAmplitude(t, 2), 9)
    }
  })
  it('never exceeds the broadband envelope', () => {
    for (const t of [0, 100, 500, 2000]) {
      expect(hfAmplitude(t, 2, 30, 0.7)).toBeLessThanOrEqual(decayAmplitude(t, 2) + 1e-12)
    }
  })
  it('collapses further ahead of the broadband curve as loss increases', () => {
    const light = hfAmplitude(1000, 2, 30, 0.9)
    const heavy = hfAmplitude(1000, 2, 30, 0.5)
    expect(heavy).toBeLessThan(light)
  })
  it('applies one loss factor per pass', () => {
    // At exactly one pass, the ratio to broadband is exactly the loss.
    const pass = 30
    const ratio = hfAmplitude(pass, 2, pass, 0.8) / decayAmplitude(pass, 2)
    expect(ratio).toBeCloseTo(0.8, 9)
  })
})

describe('hfRt60Ms', () => {
  it('equals the broadband RT60 when there is no HF loss', () => {
    expect(hfRt60Ms(2, 30, 1)).toBeCloseTo(2000, 6)
  })
  it('is shorter than the broadband RT60 whenever damping is active', () => {
    expect(hfRt60Ms(2, 30, 0.7)).toBeLessThan(2000)
  })
  it('lands where the HF envelope is actually -60 dB', () => {
    const t = hfRt60Ms(2, 30, 0.7)
    expect(hfAmplitude(t, 2, 30, 0.7)).toBeCloseTo(1e-3, 8)
  })
  it('shortens monotonically as loss increases', () => {
    let prev = Infinity
    for (const l of [0.95, 0.8, 0.6, 0.3]) {
      const t = hfRt60Ms(4, 30, l)
      expect(t).toBeLessThan(prev)
      prev = t
    }
  })
  it('stays finite at the extremes', () => {
    expect(Number.isFinite(hfRt60Ms(30, 60, 0.01))).toBe(true)
    expect(Number.isFinite(hfRt60Ms(0.1, 5, 0.99))).toBe(true)
  })
})

// ── ER / late balance ────────────────────────────────────────────────────────

describe('erLateBalance', () => {
  it('is the trim-independent erGainScale / lateGainScale ratio', () => {
    expect(erLateBalance(STYLE_GENERIC)).toBeCloseTo(1.0, 9)
    expect(erLateBalance(STYLE_ROOM)).toBeCloseTo(1.15 / 0.75, 9)
    expect(erLateBalance(STYLE_HALL)).toBeCloseTo(0.45 / 1.20, 9)
  })
  it('makes Room ER-forward and Hall tail-forward', () => {
    expect(erLateBalance(STYLE_ROOM)).toBeGreaterThan(1)
    expect(erLateBalance(STYLE_HALL)).toBeLessThan(1)
  })
  it('returns 1 for Plate, which has no ER bus', () => {
    expect(erLateBalance(STYLE_PLATE)).toBe(1)
  })
})

describe('erArrivals', () => {
  it('returns one arrival per engine ER tap', () => {
    expect(erArrivals(STYLE_GENERIC, 50, 0)).toHaveLength(12)
    expect(erArrivals(STYLE_ROOM, 50, 0)).toHaveLength(8)
    expect(erArrivals(STYLE_HALL, 50, 0)).toHaveLength(10)
  })
  it('returns nothing for Plate rather than inventing taps', () => {
    expect(erArrivals(STYLE_PLATE, 100, 0)).toEqual([])
  })
  it('shifts every arrival by pre-delay', () => {
    const a = erArrivals(STYLE_ROOM, 50, 0)
    const b = erArrivals(STYLE_ROOM, 50, 25)
    a.forEach((tap, i) => expect(b[i].ms - tap.ms).toBeCloseTo(25, 9))
  })
  it('scales heights by er_level', () => {
    const half = erArrivals(STYLE_GENERIC, 50, 0)
    const full = erArrivals(STYLE_GENERIC, 100, 0)
    half.forEach((tap, i) => expect(full[i].g).toBeCloseTo(tap.g * 2, 9))
  })
  it('collapses to silence at er_level 0', () => {
    for (const tap of erArrivals(STYLE_HALL, 0, 0)) expect(tap.g).toBe(0)
  })
  it('applies the per-style erGainScale — Hall is quieter than Room', () => {
    const room = erArrivals(STYLE_ROOM, 100, 0)[0]
    const hall = erArrivals(STYLE_HALL, 100, 0)[0]
    // Room 0.715*1.15 = 0.822 vs Hall 0.55*0.45 = 0.2475
    expect(room.g).toBeGreaterThan(hall.g)
  })
  it('keeps every height inside [0, 1]', () => {
    for (const s of [STYLE_GENERIC, STYLE_ROOM, STYLE_HALL]) {
      for (const tap of erArrivals(s, 100, 0)) {
        expect(tap.g).toBeGreaterThanOrEqual(0)
        expect(tap.g).toBeLessThanOrEqual(1)
      }
    }
  })
  it('orders arrivals in time', () => {
    const taps = erArrivals(STYLE_GENERIC, 50, 5)
    for (let i = 1; i < taps.length; i++) expect(taps[i].ms).toBeGreaterThan(taps[i - 1].ms)
  })
})

describe('plateBloomStages', () => {
  it('returns the 4 engine diffuser stages', () => {
    const stages = plateBloomStages(50, 0)
    expect(stages).toHaveLength(4)
    expect(stages.map(s => s.stage)).toEqual([1, 2, 3, 4])
  })
  it('accumulates arrival time across the cascade', () => {
    const stages = plateBloomStages(50, 0)
    for (let i = 1; i < stages.length; i++) {
      expect(stages[i].atMs).toBeGreaterThan(stages[i - 1].atMs)
    }
    // Last stage lands at the sum of all four delays.
    const total = (149 + 263 + 421 + 587) / 48
    expect(stages[3].atMs).toBeCloseTo(total, 6)
  })
  it('offsets the whole cascade by pre-delay', () => {
    const a = plateBloomStages(50, 0)
    const b = plateBloomStages(50, 30)
    a.forEach((st, i) => expect(b[i].atMs - st.atMs).toBeCloseTo(30, 9))
  })
  it('tracks er_level as the blend, 0 to 1', () => {
    expect(plateBloomStages(0, 0).every(s => s.g === 0)).toBe(true)
    expect(plateBloomStages(100, 0).every(s => s.g === 1)).toBe(true)
    expect(plateBloomStages(50, 0)[0].g).toBeCloseTo(0.5, 9)
  })
  it('reports each stage span as its own allpass delay', () => {
    expect(plateBloomStages(50, 0)[0].spanMs).toBeCloseTo(149 / 48, 6)
  })
})

// ── Density comb ─────────────────────────────────────────────────────────────

describe('recirculationTimesMs', () => {
  it('returns every multiple of every line inside the window', () => {
    // 50 appears twice on purpose: it is both 10×5 and 25×2. Coincident
    // arrivals are not a bug to dedupe — two lines landing on the same instant
    // is precisely the modal pile-up the engine's mutually-incommensurate prime
    // delay sets exist to avoid, so the comb should show it when it happens.
    const t = recirculationTimesMs([10, 25], 55)
    expect(t).toEqual([10, 20, 25, 30, 40, 50, 50])
  })
  it('returns sorted times', () => {
    const t = recirculationTimesMs([7, 11, 13], 200)
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThanOrEqual(t[i - 1])
  })
  it('is empty when nothing fits in the window', () => {
    expect(recirculationTimesMs([100], 50)).toEqual([])
    expect(recirculationTimesMs([], 5000)).toEqual([])
  })
  it('ignores non-positive delays instead of looping forever', () => {
    expect(recirculationTimesMs([0, -3], 1000)).toEqual([])
  })
  it('respects maxPerLine', () => {
    expect(recirculationTimesMs([1], 10000, 5)).toEqual([1, 2, 3, 4, 5])
  })
  it('respects maxTotal', () => {
    const t = recirculationTimesMs([1, 2, 3], 10000, 100, 12)
    expect(t.length).toBeLessThanOrEqual(12)
  })
  it('makes Hall denser than Plate over the same tail', () => {
    const hall = recirculationTimesMs(modalDelaysMs(STYLE_HALL, 50), 3000)
    const plate = recirculationTimesMs(modalDelaysMs(STYLE_PLATE, 50), 3000)
    expect(hall.length).toBeGreaterThan(plate.length)
  })
})

// ── Modulation ───────────────────────────────────────────────────────────────

describe('modLfoHz', () => {
  it('is zero at mod_rate 0 — the engine freezes the phasor', () => {
    for (const s of ALL_STYLES) expect(modLfoHz(0, s)).toBe(0)
  })
  it('scales linearly with the knob', () => {
    expect(modLfoHz(50, STYLE_GENERIC)).toBeCloseTo(modLfoHz(100, STYLE_GENERIC) / 2, 9)
  })
  it('is the mean of the style base rates at 100 %', () => {
    const rates = styleDsp(STYLE_GENERIC).modRates
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length
    expect(modLfoHz(100, STYLE_GENERIC)).toBeCloseTo(mean, 9)
  })
  it('keeps Room the slowest FDN style, as its table is', () => {
    expect(modLfoHz(100, STYLE_ROOM)).toBeLessThan(modLfoHz(100, STYLE_GENERIC))
  })
})

describe('modExcursionSamples', () => {
  it('matches the FDN mapping (depth/100)*3*modDepthScale', () => {
    expect(modExcursionSamples(100, STYLE_GENERIC)).toBeCloseTo(3.0, 9)
    expect(modExcursionSamples(100, STYLE_ROOM)).toBeCloseTo(3.0 * 0.45, 9)
    expect(modExcursionSamples(100, STYLE_HALL)).toBeCloseTo(3.0 * 0.45, 9)
  })
  it('matches the Plate ceiling of 24 samples', () => {
    expect(modExcursionSamples(100, STYLE_PLATE)).toBeCloseTo(24, 9)
  })
  it('is zero at depth 0 for every style', () => {
    for (const s of ALL_STYLES) expect(modExcursionSamples(0, s)).toBe(0)
  })
  it('makes the Plate excursion an order of magnitude larger', () => {
    expect(modExcursionSamples(100, STYLE_PLATE))
      .toBeGreaterThan(modExcursionSamples(100, STYLE_GENERIC) * 5)
  })
})

describe('modIntensity', () => {
  it('is zero when depth is zero regardless of rate', () => {
    for (const s of ALL_STYLES) expect(modIntensity(100, 0, s)).toBe(0)
  })
  it('is reduced but non-zero when rate is zero and depth is not', () => {
    const v = modIntensity(0, 100, STYLE_PLATE)
    expect(v).toBeGreaterThan(0)
    expect(v).toBeLessThan(modIntensity(100, 100, STYLE_PLATE))
  })
  it('stays inside [0, 1] across the whole parameter space', () => {
    for (const s of ALL_STYLES) {
      for (const r of [0, 50, 100]) {
        for (const d of [0, 50, 100]) {
          const v = modIntensity(r, d, s)
          expect(v).toBeGreaterThanOrEqual(0)
          expect(v).toBeLessThanOrEqual(1)
        }
      }
    }
  })
  it('ripples the Plate harder than an FDN style at the same knobs', () => {
    expect(modIntensity(100, 100, STYLE_PLATE))
      .toBeGreaterThan(modIntensity(100, 100, STYLE_HALL))
  })
})

// ── Axes ─────────────────────────────────────────────────────────────────────

describe('timeToNorm / normToTime', () => {
  it('pins the axis ends to 0 and 1', () => {
    expect(timeToNorm(AXIS_T_MIN_MS)).toBeCloseTo(0, 9)
    expect(timeToNorm(AXIS_T_MAX_MS)).toBeCloseTo(1, 9)
  })
  it('clamps outside the axis', () => {
    expect(timeToNorm(0.01)).toBeCloseTo(0, 9)
    expect(timeToNorm(1e9)).toBeCloseTo(1, 9)
  })
  it('is logarithmic — equal ratios take equal width', () => {
    const a = timeToNorm(10) - timeToNorm(1)
    const b = timeToNorm(100) - timeToNorm(10)
    const c = timeToNorm(1000) - timeToNorm(100)
    expect(a).toBeCloseTo(b, 9)
    expect(b).toBeCloseTo(c, 9)
  })
  it('round-trips through normToTime', () => {
    for (const ms of [1, 12, 100, 2500, 42000]) {
      expect(normToTime(timeToNorm(ms))).toBeCloseTo(ms, 6)
    }
  })
  it('grows monotonically', () => {
    expect(timeToNorm(5)).toBeLessThan(timeToNorm(50))
    expect(normToTime(0.2)).toBeLessThan(normToTime(0.8))
  })
})

describe('ampToNorm', () => {
  it('puts unity amplitude at the top of the plot', () => {
    expect(ampToNorm(1)).toBeCloseTo(0, 9)
  })
  it('puts -60 dB at the floor', () => {
    expect(ampToNorm(1e-3)).toBeCloseTo(1, 9)
  })
  it('puts -30 dB at the midpoint', () => {
    expect(ampToNorm(Math.pow(10, -30 / 20))).toBeCloseTo(0.5, 9)
  })
  it('clamps beyond the plot rather than escaping it', () => {
    expect(ampToNorm(5)).toBe(0)
    expect(ampToNorm(0)).toBe(1)
    expect(ampToNorm(-1)).toBe(1)
  })
})

// ── Formatting ───────────────────────────────────────────────────────────────

describe('formatSeconds', () => {
  it('uses 2 decimals below 10 s and 1 above', () => {
    expect(formatSeconds(2)).toBe('2.00 s')
    expect(formatSeconds(0.85)).toBe('0.85 s')
    expect(formatSeconds(12.44)).toBe('12.4 s')
  })
})

describe('formatTimeMs', () => {
  it('switches unit at 1 s', () => {
    expect(formatTimeMs(1500)).toBe('1.50 s')
    expect(formatTimeMs(250)).toBe('250 ms')
  })
  it('keeps a decimal on sub-100 ms values, where ER taps live', () => {
    expect(formatTimeMs(5.77)).toBe('5.8 ms')
    expect(formatTimeMs(12.5)).toBe('12.5 ms')
  })
})
