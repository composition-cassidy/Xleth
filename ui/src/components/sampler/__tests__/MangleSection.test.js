import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// MANGLE's mode ids are PERSISTED in the project file, and they live in two
// places: the C++ enum the engine dispatches on and the dropdown the user picks
// from. Nothing structurally links them, so this suite reads both and asserts
// they agree. A mode appended to the enum without a dropdown entry (or worse, a
// dropdown entry pointing at the wrong id — silently selecting a different
// effect) is exactly the drift this catches.

function readUiSource(relativePath) {
  return readFileSync(path.resolve(process.cwd(), 'src', relativePath), 'utf8')
}

function readEngineSource(relativePath) {
  return readFileSync(path.resolve(process.cwd(), '..', 'engine', 'src', relativePath), 'utf8')
}

// Pull `Name = 12,` pairs out of `enum class Mode : int { ... };`.
function parseEngineModeIds() {
  const src = readEngineSource('audio/MangleDsp.h')
  const body = src.match(/enum class Mode : int\s*{([\s\S]*?)};/)?.[1]
  expect(body, 'engine Mode enum should be parseable').toBeTruthy()

  const ids = new Map()
  for (const [, name, value] of body.matchAll(/^\s*(\w+)\s*=\s*(\d+)\s*,/gm)) {
    ids.set(name, Number(value))
  }
  return ids
}

// Pull `{ v: 12, l: 'Even' },` pairs out of the MANGLE_GROUPS literal.
function parseUiModes() {
  const src = readUiSource('components/sampler/mangleModes.js')
  const body = src.match(/const MANGLE_GROUPS = \[([\s\S]*?)\n\]/)?.[1]
  expect(body, 'MANGLE_GROUPS should be parseable').toBeTruthy()

  const groups = []
  for (const chunk of body.split(/label:\s*'/).slice(1)) {
    const label = chunk.slice(0, chunk.indexOf("'"))
    const modes = [...chunk.matchAll(/\{\s*v:\s*(\d+),\s*l:\s*'([^']*)'\s*\}/g)]
      .map(([, v, l]) => ({ v: Number(v), l }))
    groups.push({ label, modes })
  }
  return groups
}

describe('MANGLE mode catalogue', () => {
  const engineIds = parseEngineModeIds()
  const groups = parseUiModes()
  const uiModes = groups.flatMap((g) => g.modes)

  it('parsed both sides', () => {
    expect(engineIds.size).toBeGreaterThan(30)
    expect(uiModes.length).toBeGreaterThan(30)
  })

  it('offers exactly the engine modes, Off excluded (it is the standalone bypass option)', () => {
    const enginePlayable = [...engineIds.entries()]
      .filter(([name]) => name !== 'Off' && name !== 'Count')
      .map(([, v]) => v)
      .sort((a, b) => a - b)

    const uiIds = uiModes.map((m) => m.v).sort((a, b) => a - b)
    expect(uiIds).toEqual(enginePlayable)
  })

  it('renders Off as its own option outside the groups', () => {
    const src = readUiSource('components/sampler/mangleModes.js')
    expect(src).toContain('const MANGLE_OFF = 0')
    expect(engineIds.get('Off')).toBe(0)
    const view = readUiSource('components/sampler/SamplerPlaybackView.jsx')
    expect(view).toContain("{ value: MANGLE_OFF, label: 'Off' }")
    // Off must never also appear inside a group, or the dropdown shows it twice.
    expect(uiModes.some((m) => m.v === 0)).toBe(false)
  })

  it('assigns every mode a unique id and label', () => {
    const ids = uiModes.map((m) => m.v)
    const labels = uiModes.map((m) => m.l)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('groups the modes as ALT / FILTER / DISTORTION / MODULATION', () => {
    expect(groups.map((g) => g.label)).toEqual(['Alt', 'Filter', 'Distortion', 'Modulation'])
  })

  it('puts each engine mode in the group its id range belongs to', () => {
    // The enum is laid out in contiguous group blocks; the dropdown must not
    // quietly file a filter under distortion.
    const byLabel = Object.fromEntries(groups.map((g) => [g.label, g.modes.map((m) => m.v)]))
    expect(byLabel.Alt).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
    expect(byLabel.Filter).toEqual([
      engineIds.get('Lpf'), engineIds.get('Hpf'),
      engineIds.get('Bpf'), engineIds.get('Notch'),
    ])
    expect(byLabel.Distortion).toEqual([
      engineIds.get('Tube'), engineIds.get('SoftClip'), engineIds.get('HardClip'),
      engineIds.get('Diode1'), engineIds.get('Diode2'), engineIds.get('LinearFold'),
      engineIds.get('SineFold'), engineIds.get('ZeroSquare'), engineIds.get('Asym'),
      engineIds.get('Rectify'), engineIds.get('SineShaper'), engineIds.get('StompBox'),
      engineIds.get('TapeSat'), engineIds.get('SoftSat'),
    ])
    expect(byLabel.Modulation).toEqual([
      engineIds.get('Fm'), engineIds.get('Pd'),
      engineIds.get('Am'), engineIds.get('Rm'),
    ])
  })

  it('marks the FILTER group as the one with a bipolar Amount', () => {
    // A there is a cutoff sweep AROUND a key-tracked base, so its neutral is
    // the midpoint, not the minimum. Everything else treats 0 as off.
    const src = readUiSource('components/sampler/mangleModes.js')
    const fn = src.match(/const mangleAmountIsBipolar = \(v\) =>([^\n]*)/)?.[1]
    expect(fn).toBeTruthy()
    expect(fn).toContain(String(engineIds.get('Lpf')))
    expect(fn).toContain(String(engineIds.get('Notch')))
  })
})


describe('MANGLE chain wiring', () => {
  const modes = readUiSource('components/sampler/mangleModes.js')
  const panel = readUiSource('components/sampler/SamplerPanelContent.jsx')
  const view = readUiSource('components/sampler/SamplerPlaybackView.jsx')

  it('caps the chain at the engine instance limit', () => {
    // The UI cap must match xleth::mangle::kMaxInstances or the engine would
    // silently drop instances the UI let the user add.
    const uiCap = Number(modes.match(/const MANGLE_MAX = (\d+)/)[1])
    const engine = readEngineSource('audio/MangleDsp.h')
    const engineCap = Number(engine.match(/kMaxInstances\s*=\s*(\d+)/)[1])
    expect(uiCap).toBe(engineCap)
    // The add button disables at the cap; commitChain clamps as a backstop.
    expect(view).toContain('disabled={chain.length >= MANGLE_MAX}')
    expect(panel).toContain('chain.slice(0, MANGLE_MAX)')
  })

  it('routes MANGLE through the per-slot commit path as an ordered array', () => {
    expect(panel).toContain('mangleChain: Array.isArray(sl.mangleChain)')
    expect(panel).toContain('commit({ mangleChain: next })')
    expect(view).toContain("actions.commitChainField(index, 'mode', Number(v))")
  })

  it('previews Amount and Mix locally and commits once', () => {
    expect(view).toMatch(/onChange=\{\(v\) => actions\.previewChainField\(index, 'amount'/)
    expect(view).toMatch(/onCommit=\{\(v\) => actions\.commitChainField\(index, 'amount'/)
    expect(view).toMatch(/onChange=\{\(v\) => actions\.previewChainField\(index, 'mix'/)
    expect(view).toMatch(/onCommit=\{\(v\) => actions\.commitChainField\(index, 'mix'/)
  })

  it('defaults to an empty chain, matching the engine model', () => {
    expect(panel).toContain('mangleChain: [],')
    const engine = readEngineSource('model/TimelineTypes.h')
    expect(engine).toMatch(/std::vector<MangleInstance>\s+mangleChain;/)
  })

  it('mirrors the engine bypass gate for the active state', () => {
    const gate = modes.match(/const mangleInstanceActive = \(mi\) =>([\s\S]*?)\n\n/)?.[1] ?? ''
    expect(gate).toContain('MANGLE_OFF')
    expect(gate).toContain('bypass')
    expect(gate).toContain('mix')
    expect(view).toContain('const mangleOn = chain.some(mangleInstanceActive)')
  })

  it('never calls tokenValue() at module scope', () => {
    for (const src of [modes, panel, view]) {
      const head = src.slice(0, Math.max(0, src.indexOf('export default function')))
      expect(head).not.toContain('tokenValue(')
    }
  })
})
