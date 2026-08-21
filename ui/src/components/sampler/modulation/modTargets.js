// ── Knob → ModTarget registry ────────────────────────────────────────────────
// The declarative half of drag-to-route. A control that can RECEIVE modulation
// declares one registration object:
//
//   { target, index, stage, scale }
//
//   target — a TARGET_* id below; index = the engine ModRoute.index (slot for
//   slot targets, SOURCE index for cross-mod targets); stage = the MANGLE chain
//   instance for the two MANGLE targets and the EnvStage for ENV_STAGE_TIME;
//   scale converts the control's OWN display units into the target's engine
//   units (a MANGLE Amount knob reads 0..100 % for a 0..1 engine parameter, so
//   it registers scale 0.01).
//
// Everything else — the ring geometry, the tooltip, the route-list label — is
// derived from that one object plus TARGET_SPECS, which mirrors the engine's
// targetSpec() table in engine/src/model/SamplerModulationConfig.h. Enum ids
// are persisted BY INDEX, so this table is append-only; never reorder it.
//
// This module is pure data + math: no React, no DOM, no tokenValue().

import {
  ENV_SOURCE_0, LFO_SOURCE_0, VELO_SOURCE, NOTE_SOURCE,
  NUM_ENVS, NUM_LFOS, NUM_SOURCES,
  STAGE_SUSTAIN,
} from './modConstants.js'

// ── Target ids (index = engine ModTarget) ────────────────────────────────────
export const TARGET_NONE = 0
export const TARGET_SLOT_VOLUME = 1
export const TARGET_SLOT_PAN = 2
export const TARGET_SLOT_SEM = 3
export const TARGET_SLOT_FINE = 4
export const TARGET_SLOT_COARSE = 5
export const TARGET_SLOT_MANGLE_AMOUNT = 6
export const TARGET_SLOT_MANGLE_MIX = 7
export const TARGET_MASTER_VOLUME = 8
export const TARGET_MASTER_PAN = 9
export const TARGET_SRC_RATE = 10
export const TARGET_SRC_PHASE = 11
export const TARGET_SRC_RISE = 12
export const TARGET_SRC_DELAY = 13
export const TARGET_SRC_SMOOTH = 14
export const TARGET_SRC_AMOUNT = 15
export const TARGET_ENV_STAGE_TIME = 16
export const NUM_TARGETS = 17

// Engine caps — mirrors kMaxModSlots / kMaxMangleInstances.
export const MAX_MOD_SLOTS = 8
export const MAX_MANGLE_INSTANCES = 4

export const LAW_ADDITIVE = 'additive'
export const LAW_EXPONENTIAL = 'exponential'

// `span` is the move an amount of 1.0 produces; `lo`/`hi` clamp the RESULT and
// apply to the additive law only (an exponential target scales its base and can
// never cross zero, so it needs no clamp). Mirrors targetSpec() exactly.
export const TARGET_SPECS = {
  [TARGET_SLOT_VOLUME]:        { law: LAW_ADDITIVE,    span: 1,    lo: 0,     hi: 2 },
  [TARGET_SLOT_PAN]:           { law: LAW_ADDITIVE,    span: 1,    lo: -1,    hi: 1 },
  [TARGET_SLOT_SEM]:           { law: LAW_ADDITIVE,    span: 48,   lo: -96,   hi: 96 },
  [TARGET_SLOT_FINE]:          { law: LAW_ADDITIVE,    span: 100,  lo: -1200, hi: 1200 },
  [TARGET_SLOT_COARSE]:        { law: LAW_ADDITIVE,    span: 48,   lo: -96,   hi: 96 },
  [TARGET_SLOT_MANGLE_AMOUNT]: { law: LAW_ADDITIVE,    span: 1,    lo: 0,     hi: 1 },
  [TARGET_SLOT_MANGLE_MIX]:    { law: LAW_ADDITIVE,    span: 1,    lo: 0,     hi: 1 },
  [TARGET_MASTER_VOLUME]:      { law: LAW_ADDITIVE,    span: 1,    lo: 0,     hi: 2 },
  [TARGET_MASTER_PAN]:         { law: LAW_ADDITIVE,    span: 1,    lo: -1,    hi: 1 },
  [TARGET_SRC_RATE]:           { law: LAW_EXPONENTIAL, span: 4,    lo: 0,     hi: 0 },
  [TARGET_SRC_PHASE]:          { law: LAW_ADDITIVE,    span: 1,    lo: -8,    hi: 8 },
  [TARGET_SRC_RISE]:           { law: LAW_EXPONENTIAL, span: 4,    lo: 0,     hi: 0 },
  [TARGET_SRC_DELAY]:          { law: LAW_EXPONENTIAL, span: 4,    lo: 0,     hi: 0 },
  [TARGET_SRC_SMOOTH]:         { law: LAW_ADDITIVE,    span: 1,    lo: 0,     hi: 1 },
  [TARGET_SRC_AMOUNT]:         { law: LAW_ADDITIVE,    span: 1,    lo: -1,    hi: 1 },
  [TARGET_ENV_STAGE_TIME]:     { law: LAW_EXPONENTIAL, span: 4,    lo: 0,     hi: 0 },
}

export function targetSpec(target) {
  return TARGET_SPECS[target] || { law: LAW_ADDITIVE, span: 0, lo: 0, hi: 0 }
}

// ── Scope + presentation ─────────────────────────────────────────────────────
// `scope` decides what `index` means and therefore how the label reads:
//   slot   — index is a sample slot        (MANGLE targets also use `stage`)
//   master — index is unused
//   src    — index is another SOURCE       (ENV_STAGE_TIME also uses `stage`)
export const TARGET_INFO = {
  [TARGET_SLOT_VOLUME]:        { scope: 'slot',   name: 'VOL',    unit: '',   digits: 2 },
  [TARGET_SLOT_PAN]:           { scope: 'slot',   name: 'PAN',    unit: '',   digits: 2 },
  [TARGET_SLOT_SEM]:           { scope: 'slot',   name: 'SEM',    unit: 'st', digits: 1 },
  [TARGET_SLOT_FINE]:          { scope: 'slot',   name: 'FINE',   unit: 'c',  digits: 0 },
  [TARGET_SLOT_COARSE]:        { scope: 'slot',   name: 'CRS',    unit: 'st', digits: 1 },
  [TARGET_SLOT_MANGLE_AMOUNT]: { scope: 'slot',   name: 'AMOUNT', unit: '%',  digits: 0, pct: true },
  [TARGET_SLOT_MANGLE_MIX]:    { scope: 'slot',   name: 'MIX',    unit: '%',  digits: 0, pct: true },
  [TARGET_MASTER_VOLUME]:      { scope: 'master', name: 'VOLUME', unit: '',   digits: 2 },
  [TARGET_MASTER_PAN]:         { scope: 'master', name: 'PAN',    unit: '',   digits: 2 },
  [TARGET_SRC_RATE]:           { scope: 'src',    name: 'RATE',   unit: 'Hz', digits: 2 },
  [TARGET_SRC_PHASE]:          { scope: 'src',    name: 'PHASE',  unit: '%',  digits: 0, pct: true },
  [TARGET_SRC_RISE]:           { scope: 'src',    name: 'RISE',   unit: 'ms', digits: 0 },
  [TARGET_SRC_DELAY]:          { scope: 'src',    name: 'DELAY',  unit: 'ms', digits: 0 },
  [TARGET_SRC_SMOOTH]:         { scope: 'src',    name: 'SMOOTH', unit: '%',  digits: 0, pct: true },
  [TARGET_SRC_AMOUNT]:         { scope: 'src',    name: 'OUT',    unit: '%',  digits: 0, pct: true },
  [TARGET_ENV_STAGE_TIME]:     { scope: 'src',    name: 'STAGE',  unit: 'ms', digits: 0 },
}

// Stage names for ENV_STAGE_TIME. Sustain is a LEVEL, not a time — the engine
// rejects a route to it, so it is never a registrable target.
export const STAGE_NAMES = ['DELAY', 'ATTACK', 'HOLD', 'DECAY', 'SUSTAIN', 'RELEASE']

export function isCrossModTargetId(target) {
  return target >= TARGET_SRC_RATE && target <= TARGET_ENV_STAGE_TIME
}

// ── Labels ───────────────────────────────────────────────────────────────────
export function sourceLabel(source) {
  if (source >= ENV_SOURCE_0 && source < ENV_SOURCE_0 + NUM_ENVS) return `ENV ${source - ENV_SOURCE_0 + 1}`
  if (source >= LFO_SOURCE_0 && source < LFO_SOURCE_0 + NUM_LFOS) return `LFO ${source - LFO_SOURCE_0 + 1}`
  if (source === VELO_SOURCE) return 'VELO'
  if (source === NOTE_SOURCE) return 'NOTE'
  return '—'
}

// LFOs swing about zero; envelopes and the two response curves rise from it.
// Mirrors the engine's sourceIsBipolarNatural() — it is what a NEW route's
// default polarity follows, so dropping an LFO gives a symmetric ring and
// dropping an envelope gives a one-sided one without the user touching either.
export function sourceIsBipolarNatural(source) {
  return source >= LFO_SOURCE_0 && source < LFO_SOURCE_0 + NUM_LFOS
}

// The ring is drawn in its SOURCE's colour, so a glance at a knob says which
// card is driving it. Returns the custom property NAME, not a var() expression:
// the ring lands on a canvas, which cannot parse var(), so the knob resolves the
// property off its own element with getComputedStyle. app.css defines these four
// on the sampler panel body as well as the tray, so a knob outside the tray
// still inherits them.
export function modSourceColorVar(source) {
  if (source >= ENV_SOURCE_0 && source < ENV_SOURCE_0 + NUM_ENVS) return '--mod-env'
  if (source >= LFO_SOURCE_0 && source < LFO_SOURCE_0 + NUM_LFOS) return '--mod-lfo'
  if (source === VELO_SOURCE) return '--mod-velo'
  if (source === NOTE_SOURCE) return '--mod-note'
  return '--theme-accent'
}

export function targetLabel(target, index = 0, stage = 0) {
  const info = TARGET_INFO[target]
  if (!info) return '—'
  if (info.scope === 'master') return `Master ${info.name}`
  if (info.scope === 'slot') {
    if (target === TARGET_SLOT_MANGLE_AMOUNT || target === TARGET_SLOT_MANGLE_MIX)
      return `Slot ${index + 1} MANGLE ${stage + 1} ${info.name}`
    return `Slot ${index + 1} ${info.name}`
  }
  if (target === TARGET_ENV_STAGE_TIME)
    return `${sourceLabel(index)} ${STAGE_NAMES[stage] || '?'}`
  return `${sourceLabel(index)} ${info.name}`
}

// A stable identity for one registration — the drop-target key and the dedupe
// key for "does a route to this control already exist".
export function targetKey(target, index = 0, stage = 0) {
  return `${target}:${index}:${stage}`
}

// The inverse. A drop lands on a DOM node carrying data-mod-target, so the key
// IS the registration as far as route creation is concerned — target, index and
// stage are the only three fields a ModRoute needs from the control (`scale` is
// presentation only and never crosses the bridge).
export function parseTargetKey(key) {
  const parts = String(key || '').split(':')
  if (parts.length !== 3) return null
  const [target, index, stage] = parts.map(Number)
  if (![target, index, stage].every(Number.isInteger)) return null
  return { target, index, stage }
}

export function routeKey(route) {
  if (!route) return ''
  return targetKey(route.target, route.index ?? 0, route.stage ?? 0)
}

// Mirrors the engine's isRouteValid(). The UI checks it before committing so an
// impossible registration surfaces here rather than as a silent rejection.
export function isRouteValid(r) {
  if (!r) return false
  if (!(r.source >= 0 && r.source < NUM_SOURCES)) return false
  if (!(r.target > TARGET_NONE && r.target < NUM_TARGETS)) return false
  const index = r.index ?? 0
  const stage = r.stage ?? 0
  if (isCrossModTargetId(r.target)) {
    if (!(index >= 0 && index < NUM_SOURCES)) return false
    if (r.target === TARGET_ENV_STAGE_TIME) {
      if (index < ENV_SOURCE_0 || index >= ENV_SOURCE_0 + NUM_ENVS) return false
      if (stage < 0 || stage >= STAGE_NAMES.length) return false
      if (stage === STAGE_SUSTAIN) return false
    } else if (r.target !== TARGET_SRC_AMOUNT) {
      if (index < LFO_SOURCE_0 || index >= LFO_SOURCE_0 + NUM_LFOS) return false
    }
  } else if (r.target <= TARGET_SLOT_MANGLE_MIX) {
    if (index < 0 || index >= MAX_MOD_SLOTS) return false
    if ((r.target === TARGET_SLOT_MANGLE_AMOUNT || r.target === TARGET_SLOT_MANGLE_MIX)
        && (stage < 0 || stage >= MAX_MANGLE_INSTANCES)) return false
  }
  return true
}

// ── Ring math ────────────────────────────────────────────────────────────────
// The engine's routeOffset() maps the source through `m`, then multiplies by
// amount · span:
//
//   unipolar → m ∈ [0, 1]   ⇒ offset sweeps 0 … amount·span   (one-sided)
//   bipolar  → m ∈ [-1, +1] ⇒ offset spans ∓|amount·span|     (symmetric)
//
// so the ring for a unipolar route grows FROM the knob's current value in the
// sign of `amount`, and a bipolar ring spreads equally either side of it. The
// source's own output amount also multiplies in at run time; the ring shows the
// route's full-scale reach, which is what the amount is actually setting.
export function modOffsetBounds(target, amount, bipolar) {
  const span = targetSpec(target).span
  const d = (Number(amount) || 0) * span
  if (bipolar) {
    const m = Math.abs(d)
    return { min: -m, max: m }
  }
  return { min: Math.min(0, d), max: Math.max(0, d) }
}

// The modulated range in the TARGET's own engine units, given the base value
// (also in engine units). Additive clamps to the target's window; exponential
// scales the base by 2^offset and therefore collapses to nothing at base 0 —
// which is honest: modulating a zero-length time does nothing.
export function modRange(target, base, amount, bipolar) {
  const spec = targetSpec(target)
  const b = Number.isFinite(base) ? base : 0
  const { min, max } = modOffsetBounds(target, amount, bipolar)
  if (spec.law === LAW_EXPONENTIAL) {
    const lo = b * Math.pow(2, min)
    const hi = b * Math.pow(2, max)
    return { lo: Math.min(lo, hi), hi: Math.max(lo, hi) }
  }
  const clamp = (v) => Math.max(spec.lo, Math.min(spec.hi, v))
  return { lo: clamp(b + min), hi: clamp(b + max) }
}

// Same range, expressed in the CONTROL's display units — what the ring is
// actually drawn against. `scale` is the registration's units conversion, and
// knobMin/knobMax clip the ring to the control's own sweep.
export function modRangeInKnobUnits(reg, knobValue, amount, bipolar, knobMin, knobMax) {
  const scale = reg?.scale || 1
  const base = (Number(knobValue) || 0) * scale
  const { lo, hi } = modRange(reg.target, base, amount, bipolar)
  const clip = (v) => {
    const k = v / scale
    if (Number.isFinite(knobMin) && k < knobMin) return knobMin
    if (Number.isFinite(knobMax) && k > knobMax) return knobMax
    return k
  }
  return { lo: clip(lo), hi: clip(hi) }
}

// ── Value formatting ─────────────────────────────────────────────────────────
export function formatTargetValue(target, v) {
  const info = TARGET_INFO[target]
  if (!info) return String(v)
  const scaled = info.pct ? v * 100 : v
  const text = scaled.toFixed(info.digits)
  return info.unit ? `${text} ${info.unit}` : text
}

function signed(target, v) {
  const info = TARGET_INFO[target]
  const scaled = info?.pct ? v * 100 : v
  const sign = scaled > 0 ? '+' : ''
  return `${sign}${scaled.toFixed(info?.digits ?? 2)}${info?.unit ? ` ${info.unit}` : ''}`
}

// How deep a route reaches, in the units the DEPTH is actually expressed in.
// For an additive target that is the target's own unit; for an exponential one
// the offset is a multiplier exponent, so the honest unit is OCTAVES — calling
// it "±1.00 Hz" on a 1 Hz LFO would be a coincidence that stops being true the
// moment the base changes.
export function formatRouteDepth(route) {
  if (!route) return ''
  const spec = targetSpec(route.target)
  const depth = (route.amount || 0) * spec.span
  if (spec.law === LAW_EXPONENTIAL) {
    const text = `${Math.abs(depth).toFixed(2)} oct`
    if (route.bipolar) return `±${text}`
    return `${depth >= 0 ? '+' : '−'}${text}`
  }
  return route.bipolar
    ? `±${formatTargetValue(route.target, Math.abs(depth))}`
    : signed(route.target, depth)
}

// The hover tooltip: who drives what, by how much, and where that lands.
export function routeTooltip(route, reg, knobValue) {
  if (!route) return ''
  const head = `${sourceLabel(route.source)} → ${targetLabel(route.target, route.index, route.stage)}`
  const amountText = formatRouteDepth(route)
  if (reg == null || knobValue == null) return `${head}: ${amountText}`
  const base = (Number(knobValue) || 0) * (reg.scale || 1)
  const { lo, hi } = modRange(route.target, base, route.amount, route.bipolar)
  return `${head}: ${amountText} · ${formatTargetValue(route.target, lo)} … ${formatTargetValue(route.target, hi)}`
}
