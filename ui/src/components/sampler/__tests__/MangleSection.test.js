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

function cssRule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = [...css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*{([\\s\\S]*?)}`, 'g'))]
  return matches.at(-1)?.[1] ?? ''
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
  const src = readUiSource('components/sampler/SamplerPanelContent.jsx')
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
    const src = readUiSource('components/sampler/SamplerPanelContent.jsx')
    expect(src).toContain('const MANGLE_OFF = 0')
    expect(engineIds.get('Off')).toBe(0)
    expect(src).toMatch(/<option value=\{MANGLE_OFF\}>\{offLabel\}<\/option>/)
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
    const src = readUiSource('components/sampler/SamplerPanelContent.jsx')
    const fn = src.match(/const mangleAmountIsBipolar = \(v\) =>([^\n]*)/)?.[1]
    expect(fn).toBeTruthy()
    expect(fn).toContain(String(engineIds.get('Lpf')))
    expect(fn).toContain(String(engineIds.get('Notch')))
  })
})

describe('MANGLE chain panel section', () => {
  const src = readUiSource('components/sampler/SamplerPanelContent.jsx')

  it('renders a mode dropdown plus AMOUNT and MIX knobs per instance', () => {
    expect(src).toContain('sampler-range-card--mangle')
    expect(src).toContain('<SelGrouped')
    expect(src).toContain('groups={MANGLE_GROUPS}')
    // Knobs bind to the per-instance chain field, not a flat slot scalar.
    expect(src).toMatch(/label="Amount"[\s\S]{0,400}previewChainField\(i, 'amount'/)
    expect(src).toMatch(/label="Mix"[\s\S]{0,400}previewChainField\(i, 'mix'/)
  })

  it('offers add / remove / reorder / bypass chain controls', () => {
    expect(src).toContain('sampler-mangle-add')
    expect(src).toContain('addMangleInstance')
    expect(src).toContain('removeMangleInstance')
    expect(src).toContain('moveMangleInstance')
    expect(src).toContain('sampler-mangle-bypass')
  })

  it('caps the chain at the engine instance limit', () => {
    // The UI cap must match xleth::mangle::kMaxInstances or the engine would
    // silently drop instances the UI let the user add.
    expect(src).toMatch(/const MANGLE_MAX = (\d+)/)
    const uiCap = Number(src.match(/const MANGLE_MAX = (\d+)/)[1])
    const engine = readEngineSource('audio/MangleDsp.h')
    const engineCap = Number(engine.match(/kMaxInstances\s*=\s*(\d+)/)[1])
    expect(uiCap).toBe(engineCap)
    // The add button hides at the cap; commitChain clamps as a backstop.
    expect(src).toContain('mangleChain.length < MANGLE_MAX')
    expect(src).toContain('chain.slice(0, MANGLE_MAX)')
  })

  it('drag-previews locally and commits once on mouseup', () => {
    // onLiveChange is local state only (previewChainField); onCommit is the
    // single IPC write (commitChainField). A knob that committed every drag
    // frame would flood the undo stack.
    const amount = src.match(/label="Amount"[\s\S]*?\/>/)?.[0] ?? ''
    const mix = src.match(/label="Mix"[\s\S]*?\/>/)?.[0] ?? ''
    for (const knob of [amount, mix]) {
      expect(knob).toMatch(/onLiveChange=\{\(v\) => previewChainField\(/)
      expect(knob).toMatch(/onCommit=\{\(v\) => commitChainField\(/)
    }
  })

  it('routes MANGLE through the per-slot commit path as an ordered array', () => {
    // The chain reads off the SLOT (so it follows the selected layer), is copied
    // instance-by-instance, and every edit commits the full array under one
    // slotIndex so the engine gets one atomic swap and one undo entry.
    expect(src).toContain('mangleChain: Array.isArray(sl.mangleChain)')
    expect(src).toContain("commit({ mangleChain: next })")
    expect(src).toContain("commitChainField(i, 'mode', v)")
  })

  it('defaults to an empty chain, matching the engine model', () => {
    expect(src).toContain('mangleChain: [],')
    const engine = readEngineSource('model/TimelineTypes.h')
    expect(engine).toMatch(/std::vector<MangleInstance>\s+mangleChain;/)
  })

  it('mirrors the engine bypass gate for the accent state', () => {
    // The card carries the accent only when an instance has a real mode, is not
    // bypassed, and mixes in — exactly makeRuntime's gate — and only if ANY
    // instance in the chain is live.
    const gate = src.match(/const mangleInstanceActive = \(mi\) =>([\s\S]*?)\n  const mangleOn/)?.[1] ?? ''
    expect(gate).toContain('MANGLE_OFF')
    expect(gate).toContain('bypass')
    expect(gate).toContain('mix')
    expect(src).toContain('const mangleOn = mangleChain.some(mangleInstanceActive)')
  })

  it('never calls tokenValue() at module scope', () => {
    const beforeComponent = src.slice(0, src.indexOf('export default function'))
    expect(beforeComponent).not.toContain('tokenValue(')
  })
})

describe('MANGLE section CSS', () => {
  const css = readFileSync(path.resolve(process.cwd(), 'src', 'styles', 'app.css'), 'utf8')

  it('uses design tokens rather than hardcoded colour literals', () => {
    for (const selector of [
      '.sampler-range-card--mangle',
      '.sampler-range-card--mangle.is-bypassed',
      '.sampler-mangle-tag',
      '.sampler-mangle-inst',
      '.sampler-mangle-inst.is-active',
      '.sampler-mangle-add',
    ]) {
      const rule = cssRule(css, selector)
      expect(rule, `${selector} should exist`).not.toBe('')
      expect(rule, `${selector} must not hardcode hex colours`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(rule, `${selector} must not hardcode rgb/hsl literals`).not.toMatch(/\b(rgba?|hsla?)\(/)
      expect(rule).toMatch(/var\(--/)
    }
  })

  it('keeps the accent for live state only', () => {
    // Bypassed is the resting state and carries the neutral surface tokens.
    const bypassed = cssRule(css, '.sampler-range-card--mangle.is-bypassed')
    expect(bypassed).toContain('var(--sampler-bd)')
    expect(bypassed).toContain('var(--sampler-s2)')
    // Active card + active instance + the "per note" tag carry the teal accent.
    expect(cssRule(css, '.sampler-range-card--mangle')).toContain('var(--theme-accent)')
    expect(cssRule(css, '.sampler-mangle-inst.is-active')).toContain('var(--theme-accent)')
    expect(cssRule(css, '.sampler-mangle-tag')).toContain('var(--theme-accent)')
  })

  it('lights the bypass toggle with the accent only when the instance is on', () => {
    expect(cssRule(css, '.sampler-mangle-bypass.is-on')).toContain('var(--theme-accent)')
  })

  it('stays flat — no rounded corners introduced', () => {
    for (const selector of ['.sampler-mangle-body', '.sampler-mangle-inst', '.sampler-mangle-add']) {
      expect(cssRule(css, selector)).not.toMatch(/border-radius:\s*[1-9]/)
    }
  })
})
