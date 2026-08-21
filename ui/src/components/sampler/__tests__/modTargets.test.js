/**
 * Knob → ModTarget registry: the target table, the labels, the key round trip,
 * route validity, and the ring range math.
 *
 * The specs here are asserted against the engine's own numbers
 * (engine/src/model/SamplerModulationConfig.h, targetSpec()). If the engine
 * table changes and this one does not, every ring in the sampler silently lies
 * about how far a route reaches — so these assertions are a mirror check, not a
 * restatement of the implementation.
 */
import { describe, expect, it } from 'vitest'
import {
  TARGET_SLOT_VOLUME, TARGET_SLOT_PAN, TARGET_SLOT_SEM, TARGET_SLOT_FINE,
  TARGET_SLOT_COARSE, TARGET_SLOT_MANGLE_AMOUNT, TARGET_SLOT_MANGLE_MIX,
  TARGET_MASTER_VOLUME, TARGET_MASTER_PAN,
  TARGET_SRC_RATE, TARGET_SRC_PHASE, TARGET_SRC_RISE, TARGET_SRC_DELAY,
  TARGET_SRC_SMOOTH, TARGET_SRC_AMOUNT, TARGET_ENV_STAGE_TIME,
  LAW_ADDITIVE, LAW_EXPONENTIAL,
  targetSpec, targetLabel, sourceLabel, targetKey, parseTargetKey, routeKey,
  isRouteValid, modOffsetBounds, modRange, modRangeInKnobUnits,
  formatTargetValue, formatRouteDepth, routeTooltip, sourceIsBipolarNatural, modSourceColorVar,
  isCrossModTargetId,
} from '../modulation/modTargets.js'
import {
  ENV_SOURCE_0, LFO_SOURCE_0, VELO_SOURCE, NOTE_SOURCE,
  STAGE_ATTACK, STAGE_SUSTAIN, STAGE_RELEASE,
} from '../modulation/modConstants.js'

describe('target spec table', () => {
  it('mirrors the engine spans, laws and clamp windows', () => {
    expect(targetSpec(TARGET_SLOT_VOLUME)).toEqual({ law: LAW_ADDITIVE, span: 1, lo: 0, hi: 2 })
    expect(targetSpec(TARGET_SLOT_PAN)).toEqual({ law: LAW_ADDITIVE, span: 1, lo: -1, hi: 1 })
    expect(targetSpec(TARGET_SLOT_SEM)).toEqual({ law: LAW_ADDITIVE, span: 48, lo: -96, hi: 96 })
    expect(targetSpec(TARGET_SLOT_FINE)).toEqual({ law: LAW_ADDITIVE, span: 100, lo: -1200, hi: 1200 })
    expect(targetSpec(TARGET_SLOT_COARSE)).toEqual({ law: LAW_ADDITIVE, span: 48, lo: -96, hi: 96 })
    expect(targetSpec(TARGET_SLOT_MANGLE_AMOUNT)).toEqual({ law: LAW_ADDITIVE, span: 1, lo: 0, hi: 1 })
    expect(targetSpec(TARGET_SLOT_MANGLE_MIX)).toEqual({ law: LAW_ADDITIVE, span: 1, lo: 0, hi: 1 })
    expect(targetSpec(TARGET_MASTER_VOLUME)).toEqual({ law: LAW_ADDITIVE, span: 1, lo: 0, hi: 2 })
    expect(targetSpec(TARGET_MASTER_PAN)).toEqual({ law: LAW_ADDITIVE, span: 1, lo: -1, hi: 1 })
    expect(targetSpec(TARGET_SRC_PHASE)).toEqual({ law: LAW_ADDITIVE, span: 1, lo: -8, hi: 8 })
    expect(targetSpec(TARGET_SRC_SMOOTH)).toEqual({ law: LAW_ADDITIVE, span: 1, lo: 0, hi: 1 })
    expect(targetSpec(TARGET_SRC_AMOUNT)).toEqual({ law: LAW_ADDITIVE, span: 1, lo: -1, hi: 1 })
    // Every time/rate target is exponential with a 4-octave span, so a modulated
    // time can never reach zero or go negative.
    for (const t of [TARGET_SRC_RATE, TARGET_SRC_RISE, TARGET_SRC_DELAY, TARGET_ENV_STAGE_TIME]) {
      expect(targetSpec(t).law).toBe(LAW_EXPONENTIAL)
      expect(targetSpec(t).span).toBe(4)
    }
  })

  it('agrees with the engine on which targets are cross-modulation', () => {
    expect(isCrossModTargetId(TARGET_SLOT_MANGLE_MIX)).toBe(false)
    expect(isCrossModTargetId(TARGET_MASTER_PAN)).toBe(false)
    expect(isCrossModTargetId(TARGET_SRC_RATE)).toBe(true)
    expect(isCrossModTargetId(TARGET_ENV_STAGE_TIME)).toBe(true)
  })
})

describe('labels', () => {
  it('names sources by their flat index', () => {
    expect(sourceLabel(ENV_SOURCE_0)).toBe('ENV 1')
    expect(sourceLabel(ENV_SOURCE_0 + 5)).toBe('ENV 6')
    expect(sourceLabel(LFO_SOURCE_0)).toBe('LFO 1')
    expect(sourceLabel(LFO_SOURCE_0 + 5)).toBe('LFO 6')
    expect(sourceLabel(VELO_SOURCE)).toBe('VELO')
    expect(sourceLabel(NOTE_SOURCE)).toBe('NOTE')
  })

  it('reads slot, MANGLE-instance, master and cross-mod targets', () => {
    expect(targetLabel(TARGET_SLOT_SEM, 1)).toBe('Slot 2 SEM')
    expect(targetLabel(TARGET_SLOT_MANGLE_MIX, 0, 1)).toBe('Slot 1 MANGLE 2 MIX')
    expect(targetLabel(TARGET_MASTER_VOLUME)).toBe('Master VOLUME')
    expect(targetLabel(TARGET_SRC_RATE, LFO_SOURCE_0 + 1)).toBe('LFO 2 RATE')
    expect(targetLabel(TARGET_SRC_AMOUNT, VELO_SOURCE)).toBe('VELO OUT')
    expect(targetLabel(TARGET_ENV_STAGE_TIME, ENV_SOURCE_0 + 1, STAGE_RELEASE)).toBe('ENV 2 RELEASE')
  })

  it('colours a ring by its source family', () => {
    expect(modSourceColorVar(ENV_SOURCE_0 + 2)).toBe('--mod-env')
    expect(modSourceColorVar(LFO_SOURCE_0 + 2)).toBe('--mod-lfo')
    expect(modSourceColorVar(VELO_SOURCE)).toBe('--mod-velo')
    expect(modSourceColorVar(NOTE_SOURCE)).toBe('--mod-note')
  })
})

describe('target keys', () => {
  it('round-trips through the DOM attribute a drop hit-tests against', () => {
    const key = targetKey(TARGET_SLOT_MANGLE_AMOUNT, 3, 2)
    expect(key).toBe('6:3:2')
    expect(parseTargetKey(key)).toEqual({ target: TARGET_SLOT_MANGLE_AMOUNT, index: 3, stage: 2 })
  })

  it('rejects malformed keys rather than inventing a route', () => {
    expect(parseTargetKey('')).toBeNull()
    expect(parseTargetKey('6:3')).toBeNull()
    expect(parseTargetKey('a:b:c')).toBeNull()
  })

  it('keys a route by target identity, not by its source', () => {
    expect(routeKey({ source: 0, target: TARGET_SLOT_PAN, index: 1, stage: 0 }))
      .toBe(routeKey({ source: 9, target: TARGET_SLOT_PAN, index: 1, stage: 0 }))
  })
})

describe('route validity', () => {
  const base = { source: LFO_SOURCE_0, target: TARGET_SLOT_SEM, index: 0, stage: 0, amount: 0.5 }

  it('accepts an ordinary slot route', () => {
    expect(isRouteValid(base)).toBe(true)
  })

  it('rejects an out-of-range slot or MANGLE instance', () => {
    expect(isRouteValid({ ...base, index: 8 })).toBe(false)
    expect(isRouteValid({ ...base, target: TARGET_SLOT_MANGLE_MIX, stage: 4 })).toBe(false)
    expect(isRouteValid({ ...base, target: TARGET_SLOT_MANGLE_MIX, stage: 3 })).toBe(true)
  })

  it('rejects an envelope stage-time route to Sustain — a level, not a time', () => {
    const env = { source: LFO_SOURCE_0, target: TARGET_ENV_STAGE_TIME, index: ENV_SOURCE_0, stage: STAGE_ATTACK }
    expect(isRouteValid(env)).toBe(true)
    expect(isRouteValid({ ...env, stage: STAGE_SUSTAIN })).toBe(false)
  })

  it('confines LFO-only cross-mod targets to LFO sources, but not SrcAmount', () => {
    expect(isRouteValid({ source: 0, target: TARGET_SRC_RATE, index: LFO_SOURCE_0, stage: 0 })).toBe(true)
    expect(isRouteValid({ source: 0, target: TARGET_SRC_RATE, index: ENV_SOURCE_0, stage: 0 })).toBe(false)
    // Output amount is the one cross-mod target every source type carries.
    expect(isRouteValid({ source: 0, target: TARGET_SRC_AMOUNT, index: ENV_SOURCE_0, stage: 0 })).toBe(true)
    expect(isRouteValid({ source: 0, target: TARGET_SRC_AMOUNT, index: VELO_SOURCE, stage: 0 })).toBe(true)
  })

  it('rejects a stage-time route whose index is not an envelope', () => {
    expect(isRouteValid({ source: 0, target: TARGET_ENV_STAGE_TIME, index: LFO_SOURCE_0, stage: 1 })).toBe(false)
  })
})

describe('ring math', () => {
  it('sweeps one way from the base when unipolar', () => {
    // amount 0.5 on a 48-semitone span = +24 st, all above the base.
    expect(modOffsetBounds(TARGET_SLOT_SEM, 0.5, false)).toEqual({ min: 0, max: 24 })
    expect(modRange(TARGET_SLOT_SEM, 0, 0.5, false)).toEqual({ lo: 0, hi: 24 })
  })

  it('sweeps the other way for a negative unipolar amount', () => {
    expect(modOffsetBounds(TARGET_SLOT_SEM, -0.25, false)).toEqual({ min: -12, max: 0 })
    expect(modRange(TARGET_SLOT_SEM, 3, -0.25, false)).toEqual({ lo: -9, hi: 3 })
  })

  it('spreads symmetrically around the base when bipolar, whatever the sign', () => {
    expect(modOffsetBounds(TARGET_SLOT_SEM, 0.25, true)).toEqual({ min: -12, max: 12 })
    expect(modOffsetBounds(TARGET_SLOT_SEM, -0.25, true)).toEqual({ min: -12, max: 12 })
    expect(modRange(TARGET_SLOT_SEM, 7, 0.25, true)).toEqual({ lo: -5, hi: 19 })
  })

  it('collapses to the base at amount 0', () => {
    expect(modRange(TARGET_SLOT_PAN, 0.4, 0, true)).toEqual({ lo: 0.4, hi: 0.4 })
    expect(modRange(TARGET_SLOT_PAN, 0.4, 0, false)).toEqual({ lo: 0.4, hi: 0.4 })
  })

  it('clamps an additive range to the target window', () => {
    // Pan clamps at the target window, not at a symmetric distance: a full-depth
    // bipolar route from base 0.5 reaches -0.5 below and is clipped at +1 above.
    expect(modRange(TARGET_SLOT_PAN, 0.5, 1, true)).toEqual({ lo: -0.5, hi: 1 })
    expect(modRange(TARGET_SLOT_VOLUME, 1.8, 1, false)).toEqual({ lo: 1.8, hi: 2 })
  })

  it('scales rather than offsets an exponential target', () => {
    // span 4 octaves: amount 0.25 = one octave either side of 200 ms.
    const r = modRange(TARGET_ENV_STAGE_TIME, 200, 0.25, true)
    expect(r.lo).toBeCloseTo(100, 6)
    expect(r.hi).toBeCloseTo(400, 6)
    // Unipolar only stretches upward.
    const u = modRange(TARGET_SRC_RATE, 2, 0.25, false)
    expect(u.lo).toBeCloseTo(2, 6)
    expect(u.hi).toBeCloseTo(4, 6)
  })

  it('leaves a zero base at zero — modulating a zero-length time does nothing', () => {
    expect(modRange(TARGET_SRC_RISE, 0, 1, true)).toEqual({ lo: 0, hi: 0 })
  })
})

describe('ring range in the control’s own units', () => {
  it('converts through the registration scale and clips to the knob sweep', () => {
    // MANGLE Mix: a 0..100 % knob over a 0..1 engine parameter.
    const reg = { target: TARGET_SLOT_MANGLE_MIX, index: 0, stage: 0, scale: 0.01 }
    // Knob at 40 % (base 0.4), amount 0.2 unipolar → 0.4 … 0.6 → 40 … 60 %.
    const r = modRangeInKnobUnits(reg, 40, 0.2, false, 0, 100)
    expect(r.lo).toBeCloseTo(40, 9)
    expect(r.hi).toBeCloseTo(60, 9)
    // Bipolar at the top of the knob clips against the target window, not the
    // knob's: mix clamps at 1.0 either way.
    const b = modRangeInKnobUnits(reg, 90, 0.5, true, 0, 100)
    expect(b.lo).toBeCloseTo(40, 9)
    expect(b.hi).toBeCloseTo(100, 9)
  })

  it('passes engine-unit controls straight through at scale 1', () => {
    const reg = { target: TARGET_SLOT_SEM, index: 1, stage: 0, scale: 1 }
    // The mini's own sweep is ±12 st, so a ±24 st route is clipped for DRAWING
    // while the tooltip still reports the true reach.
    expect(modRangeInKnobUnits(reg, 0, 0.5, true, -12, 12)).toEqual({ lo: -12, hi: 12 })
  })
})

describe('tooltip', () => {
  it('reads source → target, depth and the computed range', () => {
    const reg = { target: TARGET_SLOT_SEM, index: 1, stage: 0, scale: 1 }
    const route = { source: LFO_SOURCE_0, target: TARGET_SLOT_SEM, index: 1, stage: 0, amount: 7 / 48, bipolar: false }
    const text = routeTooltip(route, reg, 0)
    expect(text).toContain('LFO 1 → Slot 2 SEM')
    expect(text).toContain('+7.0 st')
    expect(text).toContain('0.0 st … 7.0 st')
  })

  it('marks a bipolar route with ±', () => {
    const reg = { target: TARGET_SLOT_SEM, index: 1, stage: 0, scale: 1 }
    const route = { source: LFO_SOURCE_0, target: TARGET_SLOT_SEM, index: 1, stage: 0, amount: 7 / 48, bipolar: true }
    expect(routeTooltip(route, reg, 0)).toContain('±7.0 st')
  })

  it('reports an exponential route’s depth in octaves, not the base’s unit', () => {
    // amount 0.25 on a 4-octave span is one octave. Calling that "1.00 Hz" is
    // only true while the LFO happens to sit at 1 Hz.
    const route = { source: LFO_SOURCE_0, target: TARGET_SRC_RATE, index: LFO_SOURCE_0 + 1, stage: 0, amount: 0.25, bipolar: true }
    expect(formatRouteDepth(route)).toBe('±1.00 oct')
    expect(formatRouteDepth({ ...route, bipolar: false })).toBe('+1.00 oct')
    expect(formatRouteDepth({ ...route, bipolar: false, amount: -0.5 })).toBe('−2.00 oct')
    // The RANGE stays in the target's own unit, which is where Hz belongs.
    const reg = { target: TARGET_SRC_RATE, index: LFO_SOURCE_0 + 1, stage: 0, scale: 1 }
    const text = routeTooltip(route, reg, 1)
    expect(text).toContain('LFO 1 → LFO 2 RATE')
    expect(text).toContain('±1.00 oct')
    expect(text).toContain('0.50 Hz … 2.00 Hz')
  })

  it('renders percent targets as percent', () => {
    expect(formatTargetValue(TARGET_SLOT_MANGLE_MIX, 0.25)).toBe('25 %')
    expect(formatTargetValue(TARGET_SLOT_SEM, 12)).toBe('12.0 st')
  })
})

describe('default polarity', () => {
  it('follows the source: LFOs swing, envelopes and curves rise', () => {
    expect(sourceIsBipolarNatural(LFO_SOURCE_0)).toBe(true)
    expect(sourceIsBipolarNatural(LFO_SOURCE_0 + 5)).toBe(true)
    expect(sourceIsBipolarNatural(ENV_SOURCE_0)).toBe(false)
    expect(sourceIsBipolarNatural(VELO_SOURCE)).toBe(false)
    expect(sourceIsBipolarNatural(NOTE_SOURCE)).toBe(false)
  })
})
