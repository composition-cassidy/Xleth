import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { validatePreset } from '../fxPresetSchema.js'
import { slugifyPresetName, isSlugSafe } from '../slugify.js'
import { EFFECT_CATEGORIES } from '../../components/mixer/effectCatalog.js'

// Every shipped audio-effect preset, checked against the engine's own parameter
// surface. The engine ignores an unknown parameter id and clamps an out-of-range
// value without a word, so a typo in a preset file would load "successfully" and
// do the wrong thing; this suite is what catches it.
//
// fixtures/stockEffectParamRanges.json is that surface: [min, max] for every
// parameter of every stock effect, dumped from the running engine through
// audio_getEffectParameters (EQ bands, filter slots and filter lanes are keyed
// by field name with the b<N>_ / s<N>_ / m<N>_ prefix removed). Regenerate it
// when an effect gains a parameter that presets should carry.

const __dirname = dirname(fileURLToPath(import.meta.url))
const FACTORY_DIR = join(__dirname, '..', 'factory')
const RANGES = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'stockEffectParamRanges.json'), 'utf8'))

// GLOSS is the APEX DSP under another id and lists the apex presets (deviceRegistry presetType).
const PRESET_TYPE_ALIAS = { gloss: 'apex' }
const STOCK_PRESET_TYPES = [...new Set(
  EFFECT_CATEGORIES.flatMap(c => c.submenu.map(e => PRESET_TYPE_ALIAS[e.id] ?? e.id)),
)]
const MIN_PRESETS_PER_EFFECT = 5

// GLOSS loads its four banks by these file names, whatever their display names say.
const FIXED_SLUGS = { apex: ['gloss-a', 'gloss-b', 'gloss-c', 'gloss-d'] }

// Instance, routing and audition state a shipped preset must not carry at all.
const NEVER_CARRIED = {
  compressor: ['sc_external'],
  uniflange: ['mode'],
  szkrezh: ['midi_track'],
  fedda: ['variation', 'mono_check', 'compare'],
}
// Switches a preset may only carry in their off position.
const ONLY_OFF = {
  apex: ['lo_solo', 'md_solo', 'hi_solo'],
  resonancesuppressor: ['delta'],
  szkrezh: ['freeze'],
}

function loadAll(effectType) {
  let files = []
  try { files = readdirSync(join(FACTORY_DIR, effectType)).filter(f => f.endsWith('.json')) } catch { return [] }
  return files.map(f => ({
    slug: f.replace(/\.json$/, ''),
    doc: JSON.parse(readFileSync(join(FACTORY_DIR, effectType, f), 'utf8')),
  }))
}

function rangeProblems(where, values, ranges) {
  const out = []
  for (const [id, value] of Object.entries(values || {})) {
    const range = ranges[id]
    if (!range) { out.push(`${where}${id}: not a parameter the engine has`); continue }
    if (typeof value !== 'number' || !Number.isFinite(value)) { out.push(`${where}${id}: ${JSON.stringify(value)} is not a number`); continue }
    if (value < range[0] - 1e-6 || value > range[1] + 1e-6) out.push(`${where}${id}: ${value} is outside ${range[0]}..${range[1]}`)
  }
  return out
}

function stateProblems(effectType, state) {
  if (effectType === 'xletheq') {
    const out = []
    if (!Array.isArray(state.bands) || state.bands.length === 0) return ['no bands']
    if (state.bands.length > 16) out.push('more than 16 bands')
    state.bands.forEach((band, i) => out.push(...rangeProblems(`band ${i} `, band, RANGES.xletheq.band)))
    out.push(...rangeProblems('global ', state.global, RANGES.xletheq.global))
    return out
  }
  if (effectType === 'xlethfilter') {
    const out = []
    if (!Array.isArray(state.slots) || state.slots.length === 0) return ['no slots']
    if (state.slots.length > 8) out.push('more than 8 slots')
    state.slots.forEach((slot, i) => {
      out.push(...rangeProblems(`slot ${i} `, slot.params, RANGES.xlethfilter.slot))
      // All six lanes, so a lane the previous preset left modulating is switched off.
      if (!Array.isArray(slot.mods) || slot.mods.length !== 6) { out.push(`slot ${i}: needs all 6 modulation lanes`); return }
      slot.mods.forEach((lane, j) => {
        if (typeof lane.kind !== 'number') out.push(`slot ${i} lane ${j}: no kind`)
        out.push(...rangeProblems(`slot ${i} lane ${j} `, lane, RANGES.xlethfilter.lane))
      })
    })
    return out
  }

  const ranges = RANGES.scalar[effectType]
  if (!ranges) return [`no parameter ranges recorded for "${effectType}"`]
  const params = state.params || {}
  const out = rangeProblems('', params, ranges)
  for (const id of NEVER_CARRIED[effectType] || []) if (id in params) out.push(`${id}: instance state, must not be in a preset`)
  for (const id of ONLY_OFF[effectType] || []) if (params[id]) out.push(`${id}: must stay off in a preset`)

  if (effectType === 'pitchshifter' && params.mode === 3) out.push('mode 3 (Clip) re-renders the track\'s clips; presets stay in the live modes')
  if (effectType === 'apex') {
    for (const curve of state.curves || []) {
      if (!(curve.band >= 0 && curve.band <= 3)) out.push(`curve band ${curve.band}`)
      if (!Array.isArray(curve.nodes) || curve.nodes.length < 2) { out.push(`curve ${curve.band}: needs 2+ nodes`); continue }
      for (const n of curve.nodes) {
        if (!(n.in >= -96 && n.in <= 12 && n.out >= -96 && n.out <= 12)) out.push(`curve ${curve.band}: node outside -96..12 dB`)
      }
      if (curve.tensions.length !== curve.nodes.length - 1) out.push(`curve ${curve.band}: one tension per segment`)
      if (curve.tensions.some(t => !(t >= -1 && t <= 1))) out.push(`curve ${curve.band}: tension outside -1..1`)
    }
  }
  if (effectType === 'waveshaper') {
    // A named shape and a drawn curve are exclusive: the points always win in the engine.
    const custom = Array.isArray(state.points)
    if (custom && params.preset !== 0) out.push('a custom curve carries preset 0')
    if (!custom && !(params.preset > 0)) out.push('no points and no named shape')
    if (custom) {
      if (state.points.length < 2 || state.points.length > 32) out.push('2..32 curve points')
      for (const p of state.points) {
        if (!(Array.isArray(p) && Math.abs(p[0]) <= 1 && Math.abs(p[1]) <= 1)) out.push(`curve point ${JSON.stringify(p)} outside -1..1`)
      }
    }
  }
  return out
}

describe('factory presets for stock audio effects', () => {
  it('every stock effect ships a preset set', () => {
    const thin = STOCK_PRESET_TYPES
      .map(type => [type, loadAll(type).length])
      .filter(([, count]) => count < MIN_PRESETS_PER_EFFECT)
    expect(thin).toEqual([])
  })

  describe.each(STOCK_PRESET_TYPES)('%s', (effectType) => {
    const presets = loadAll(effectType)

    it('has valid envelopes, filed under their own effect and name', () => {
      const problems = []
      for (const { slug, doc } of presets) {
        const check = validatePreset(doc, effectType)
        if (!check.ok) problems.push(`${slug}: ${check.errors[0].message}`)
        if (!isSlugSafe(slug)) problems.push(`${slug}: unsafe file name`)
        const fixed = (FIXED_SLUGS[effectType] || []).includes(slug)
        if (!fixed && slugifyPresetName(doc.name) !== slug) problems.push(`${slug}: file name does not match "${doc.name}"`)
        if (doc.author !== 'XLETH') problems.push(`${slug}: author`)
      }
      expect(problems).toEqual([])
    })

    it('has no two presets with the same name', () => {
      const names = presets.map(p => p.doc.name.toLowerCase())
      expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([])
    })

    it('only sets parameters the engine has, inside their ranges', () => {
      const problems = presets.flatMap(({ slug, doc }) =>
        stateProblems(effectType, doc.state).map(problem => `${slug}: ${problem}`))
      expect(problems).toEqual([])
    })
  })
})
