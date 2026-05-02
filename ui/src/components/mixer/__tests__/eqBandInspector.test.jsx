// Tests for SelectedBandInspector.
// Uses react-dom/server renderToStaticMarkup (works in node without jsdom).

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect, vi } from 'vitest'

import SelectedBandInspector from '../SelectedBandInspector.jsx'
import { DYN_FIELDS, SPEC_FIELDS } from '../eqInspectorConfig.js'
import { buildInspectorKnobProps } from '../EqInspectorKnob.jsx'

const noop = () => {}

function makeStaticBand(overrides = {}) {
  return { freq: 1000, gain: 0, q: 1, type: 0, enabled: 1, mode: 0, ...overrides }
}

function makeDynamicBand(overrides = {}) {
  return {
    freq: 1000, gain: -3, q: 1, type: 0, enabled: 1, mode: 1,
    dyn_thresh: -24, dyn_ratio: 4, dyn_attack: 10, dyn_release: 100,
    ...overrides,
  }
}

function makeSpectralBand(overrides = {}) {
  return {
    freq: 1000, gain: 0, q: 1, type: 0, enabled: 1, mode: 2,
    spec_sens: 0.5, spec_depth: 0, spec_sel: 5, spec_attack: 10, spec_release: 100,
    ...overrides,
  }
}

function render(jsx) {
  return renderToStaticMarkup(jsx)
}

// ── No selection ─────────────────────────────────────────────────────────────

describe('SelectedBandInspector — empty state', () => {
  it('shows "Select a band" when band is null', () => {
    const html = render(
      <SelectedBandInspector band={null} bandIndex={-1} setBandParam={noop} grValue={null} />
    )
    expect(html).toContain('Select a band')
    expect(html).toContain('eq-selected-band-empty')
  })

  it('shows "Select a band" when bandIndex is -1', () => {
    const html = render(
      <SelectedBandInspector band={undefined} bandIndex={-1} setBandParam={noop} grValue={null} />
    )
    expect(html).toContain('Select a band')
  })
})

// ── Static mode ───────────────────────────────────────────────────────────────

describe('SelectedBandInspector — static mode', () => {
  it('renders "Static" in the header', () => {
    const html = render(
      <SelectedBandInspector band={makeStaticBand()} bandIndex={0} setBandParam={noop} grValue={null} />
    )
    expect(html).toContain('Static')
    expect(html).toContain('Band 1')
  })

  it('does NOT render any dyn or spec input', () => {
    const html = render(
      <SelectedBandInspector band={makeStaticBand()} bandIndex={0} setBandParam={noop} grValue={null} />
    )
    expect(html).not.toContain('data-control="knob"')
    for (const f of [...DYN_FIELDS, ...SPEC_FIELDS]) {
      expect(html).not.toContain(`data-key="${f.key}"`)
    }
  })

  it('does NOT get a dynamic or spectral modifier class', () => {
    const html = render(
      <SelectedBandInspector band={makeStaticBand()} bandIndex={0} setBandParam={noop} grValue={null} />
    )
    expect(html).not.toContain('inspector--dynamic')
    expect(html).not.toContain('inspector--spectral')
  })
})

// ── Dynamic mode ──────────────────────────────────────────────────────────────

describe('SelectedBandInspector — dynamic mode', () => {
  it('renders "Dynamic" in the header', () => {
    const html = render(
      <SelectedBandInspector band={makeDynamicBand()} bandIndex={1} setBandParam={noop} grValue={null} />
    )
    expect(html).toContain('Dynamic')
    expect(html).toContain('Band 2')
  })

  it('renders all four dynamic param knobs with correct data-key attributes', () => {
    const html = render(
      <SelectedBandInspector band={makeDynamicBand()} bandIndex={0} setBandParam={noop} grValue={null} />
    )
    expect(html).toContain('eq-inspector-knob-grid')
    expect(html).toContain('data-control="knob"')
    expect(html).toContain('data-key="dyn_thresh"')
    expect(html).toContain('data-key="dyn_ratio"')
    expect(html).toContain('data-key="dyn_attack"')
    expect(html).toContain('data-key="dyn_release"')
  })

  it('does NOT render spectral param inputs', () => {
    const html = render(
      <SelectedBandInspector band={makeDynamicBand()} bandIndex={0} setBandParam={noop} grValue={null} />
    )
    for (const f of SPEC_FIELDS) {
      expect(html).not.toContain(`data-key="${f.key}"`)
    }
  })

  it('gets the --dynamic modifier class', () => {
    const html = render(
      <SelectedBandInspector band={makeDynamicBand()} bandIndex={0} setBandParam={noop} grValue={null} />
    )
    expect(html).toContain('inspector--dynamic')
  })

  it('renders the current dyn_thresh value in the knob readout', () => {
    const html = render(
      <SelectedBandInspector
        band={makeDynamicBand({ dyn_thresh: -30 })}
        bandIndex={0}
        setBandParam={noop}
        grValue={null}
      />
    )
    expect(html).toContain('-30 dB')
  })

  it('does NOT render old inline numeric dynamic fields', () => {
    const html = render(
      <SelectedBandInspector band={makeDynamicBand()} bandIndex={0} setBandParam={noop} grValue={null} />
    )
    expect(html).not.toContain('type="number"')
    expect(html).not.toContain('eq-band-input')
  })

  it('shows GR meter when grValue exceeds threshold', () => {
    const html = render(
      <SelectedBandInspector band={makeDynamicBand()} bandIndex={0} setBandParam={noop} grValue={-3.5} />
    )
    expect(html).toContain('eq-gr-bar')
    expect(html).toContain('-3.5 dB')
  })

  it('hides GR meter when grValue is near zero', () => {
    const html = render(
      <SelectedBandInspector band={makeDynamicBand()} bandIndex={0} setBandParam={noop} grValue={0.05} />
    )
    expect(html).not.toContain('eq-gr-bar')
  })

  it('hides GR meter when grValue is null', () => {
    const html = render(
      <SelectedBandInspector band={makeDynamicBand()} bandIndex={0} setBandParam={noop} grValue={null} />
    )
    expect(html).not.toContain('eq-gr-bar')
  })
})

// ── Spectral mode ─────────────────────────────────────────────────────────────

describe('SelectedBandInspector — spectral mode', () => {
  it('renders "Spectral" in the header', () => {
    const html = render(
      <SelectedBandInspector band={makeSpectralBand()} bandIndex={2} setBandParam={noop} grValue={null} />
    )
    expect(html).toContain('Spectral')
    expect(html).toContain('Band 3')
  })

  it('renders all five spectral param knobs with correct data-key attributes', () => {
    const html = render(
      <SelectedBandInspector band={makeSpectralBand()} bandIndex={0} setBandParam={noop} grValue={null} />
    )
    expect(html).toContain('eq-inspector-knob-grid')
    expect(html).toContain('data-control="knob"')
    expect(html).toContain('data-key="spec_sens"')
    expect(html).toContain('data-key="spec_depth"')
    expect(html).toContain('data-key="spec_sel"')
    expect(html).toContain('data-key="spec_attack"')
    expect(html).toContain('data-key="spec_release"')
  })

  it('does NOT render dynamic param inputs', () => {
    const html = render(
      <SelectedBandInspector band={makeSpectralBand()} bandIndex={0} setBandParam={noop} grValue={null} />
    )
    for (const f of DYN_FIELDS) {
      expect(html).not.toContain(`data-key="${f.key}"`)
    }
  })

  it('gets the --spectral modifier class', () => {
    const html = render(
      <SelectedBandInspector band={makeSpectralBand()} bandIndex={0} setBandParam={noop} grValue={null} />
    )
    expect(html).toContain('inspector--spectral')
  })

  it('does NOT show a GR meter even with a non-zero grValue', () => {
    const html = render(
      <SelectedBandInspector band={makeSpectralBand()} bandIndex={0} setBandParam={noop} grValue={-2} />
    )
    expect(html).not.toContain('eq-gr-bar')
  })

  it('renders spectral depth as a bipolar knob with signed readout', () => {
    const html = render(
      <SelectedBandInspector
        band={makeSpectralBand({ spec_depth: -12.5 })}
        bandIndex={0}
        setBandParam={noop}
        grValue={null}
      />
    )
    expect(html).toContain('eq-inspector-knob--bipolar')
    expect(html).toContain('-12.5 dB')
  })
})

// ── setBandParam wiring (key contract) ────────────────────────────────────────

describe('SelectedBandInspector — setBandParam key contract', () => {
  it('dynamic threshold knob calls setBandParam(bandIndex, dyn_thresh, negativeValue)', () => {
    const spy = vi.fn()
    const bandIndex = 3
    const field = DYN_FIELDS.find(f => f.key === 'dyn_thresh')
    const props = buildInspectorKnobProps(field, -20, (key, value) => spy(bandIndex, key, value))
    props.onLiveChange(-37)
    expect(spy).toHaveBeenCalledWith(3, 'dyn_thresh', -37)
  })

  it('spectral depth knob calls setBandParam(bandIndex, spec_depth, negativeValue)', () => {
    const spy = vi.fn()
    const bandIndex = 1
    const field = SPEC_FIELDS.find(f => f.key === 'spec_depth')
    const props = buildInspectorKnobProps(field, 0, (key, value) => spy(bandIndex, key, value))
    props.onLiveChange(-8.4)
    expect(spy).toHaveBeenCalledWith(1, 'spec_depth', -8.4)
  })

  it('ratio, attack, and release knobs call the correct dynamic param ids', () => {
    const spy = vi.fn()
    for (const key of ['dyn_ratio', 'dyn_attack', 'dyn_release']) {
      const field = DYN_FIELDS.find(f => f.key === key)
      const props = buildInspectorKnobProps(field, field.def, (param, value) => spy(param, value))
      props.onCommit(field.def + field.step)
    }
    expect(spy).toHaveBeenCalledWith('dyn_ratio', 4.1)
    expect(spy).toHaveBeenCalledWith('dyn_attack', 10.1)
    expect(spy).toHaveBeenCalledWith('dyn_release', 101)
  })

  it('spectral knobs call the correct non-depth param ids', () => {
    const spy = vi.fn()
    for (const key of ['spec_sens', 'spec_sel', 'spec_attack', 'spec_release']) {
      const field = SPEC_FIELDS.find(f => f.key === key)
      const props = buildInspectorKnobProps(field, field.def, (param, value) => spy(param, value))
      props.onCommit(field.def + field.step)
    }
    expect(spy).toHaveBeenCalledWith('spec_sens', 0.51)
    expect(spy).toHaveBeenCalledWith('spec_sel', 5.1)
    expect(spy).toHaveBeenCalledWith('spec_attack', 10.1)
    expect(spy).toHaveBeenCalledWith('spec_release', 101)
  })

  it('DYN_FIELDS keys match expected engine param names', () => {
    expect(DYN_FIELDS.map(f => f.key)).toEqual([
      'dyn_thresh', 'dyn_ratio', 'dyn_attack', 'dyn_release',
    ])
  })

  it('SPEC_FIELDS keys match expected engine param names', () => {
    expect(SPEC_FIELDS.map(f => f.key)).toEqual([
      'spec_sens', 'spec_depth', 'spec_sel', 'spec_attack', 'spec_release',
    ])
  })
})

// ── BandRow no longer renders dyn/spec controls ───────────────────────────────

describe('BandRow — compact row (no inline dyn/spec controls)', () => {
  // BandRow uses useEqStore hooks, so we render it via the store's initial state.
  // Zustand works with renderToStaticMarkup since it uses useSyncExternalStore.
  it('a dynamic band row does not contain dyn_thresh input', async () => {
    // Import BandRow (exported for testability in EQ-C).
    const { BandRow } = await import('../EqPanel.jsx')
    const dynamicBand = makeDynamicBand()
    const html = render(
      <BandRow
        band={dynamicBand}
        index={0}
        linPhase={false}
        oversample={0}
        isSelected={false}
        onSelect={noop}
      />
    )
    // Dynamic controls must NOT be in the row — they live in SelectedBandInspector.
    expect(html).not.toContain('data-key="dyn_thresh"')
    expect(html).not.toContain('data-key="dyn_ratio"')
    expect(html).not.toContain('data-key="dyn_attack"')
    expect(html).not.toContain('data-key="dyn_release"')
  })

  it('a spectral band row does not contain spec_sens input', async () => {
    const { BandRow } = await import('../EqPanel.jsx')
    const spectralBand = makeSpectralBand()
    const html = render(
      <BandRow
        band={spectralBand}
        index={0}
        linPhase={false}
        oversample={0}
        isSelected={false}
        onSelect={noop}
      />
    )
    expect(html).not.toContain('data-key="spec_sens"')
    expect(html).not.toContain('data-key="spec_depth"')
  })

  it('selected row gets eq-band-row--selected class', async () => {
    const { BandRow } = await import('../EqPanel.jsx')
    const band = makeStaticBand()
    const html = render(
      <BandRow band={band} index={0} linPhase={false} oversample={0} isSelected={true} onSelect={noop} />
    )
    expect(html).toContain('eq-band-row--selected')
  })

  it('unselected row does NOT get eq-band-row--selected class', async () => {
    const { BandRow } = await import('../EqPanel.jsx')
    const band = makeStaticBand()
    const html = render(
      <BandRow band={band} index={0} linPhase={false} oversample={0} isSelected={false} onSelect={noop} />
    )
    expect(html).not.toContain('eq-band-row--selected')
  })
})
