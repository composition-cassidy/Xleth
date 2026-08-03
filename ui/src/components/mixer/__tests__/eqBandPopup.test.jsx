/**
 * @vitest-environment jsdom
 *
 * EqBandPopup is prop-driven (band/setBandParam/removeBand/duplicateBand/
 * onClose all come in as props, not store hooks), so these tests exercise it
 * directly with spies rather than through useEqStore. It portals into
 * document.body and measures its own size via getBoundingClientRect, so it
 * needs a real DOM — unlike SelectedBandInspector's SSR tests, this can't run
 * under renderToStaticMarkup (effects never fire there).
 *
 * Knob.jsx draws to a <canvas> 2D context that jsdom doesn't implement
 * (no `canvas` package in this repo), so it's mocked out here — the same
 * convention MixerStrip.routing.test.jsx and MasterStrip.test.jsx use for any
 * jsdom test that transitively renders a Knob.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function loadEqBandPopupFixture() {
  vi.doMock('../../sampler/Knob.jsx', () => ({
    default: () => <div data-testid="knob-stub" />,
  }))
  const { default: EqBandPopup } = await import('../EqBandPopup.jsx')
  return EqBandPopup
}

function makeStaticBand(overrides = {}) {
  return { freq: 1000, gain: 0, q: 0.707, type: 0, enabled: 1, mode: 0, ...overrides }
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

async function renderPopup(EqBandPopup, props) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<EqBandPopup anchor={{ x: 100, y: 100 }} {...props} />)
  })
  return { container, root }
}

async function unmountRoot(root) {
  await act(async () => { root.unmount() })
}

describe('EqBandPopup', () => {
  beforeEach(() => {
    vi.resetModules()
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    document.body.innerHTML = ''
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
    vi.doUnmock('../../sampler/Knob.jsx')
  })

  it('portals into document.body, not into the mount container', async () => {
    const EqBandPopup = await loadEqBandPopupFixture()
    const { container, root } = await renderPopup(EqBandPopup, {
      band: makeStaticBand(), bandIndex: 0, setBandParam: vi.fn(),
      removeBand: vi.fn(), duplicateBand: vi.fn(), onClose: vi.fn(),
    })

    expect(container.querySelector('.eq-band-popup')).toBeNull()
    expect(document.body.querySelector('.eq-band-popup')).not.toBeNull()
    await unmountRoot(root)
  })

  it('shows the band number and color swatch in the header', async () => {
    const EqBandPopup = await loadEqBandPopupFixture()
    const { root } = await renderPopup(EqBandPopup, {
      band: makeStaticBand(), bandIndex: 2, setBandParam: vi.fn(),
      removeBand: vi.fn(), duplicateBand: vi.fn(), onClose: vi.fn(),
    })

    expect(document.body.querySelector('.eq-band-popup-title').textContent).toBe('Band 3')
    expect(document.body.querySelector('.eq-band-popup-color')).not.toBeNull()
    await unmountRoot(root)
  })

  it('static band: does not extend with dyn/spec fields', async () => {
    const EqBandPopup = await loadEqBandPopupFixture()
    const { root } = await renderPopup(EqBandPopup, {
      band: makeStaticBand(), bandIndex: 0, setBandParam: vi.fn(),
      removeBand: vi.fn(), duplicateBand: vi.fn(), onClose: vi.fn(),
    })

    expect(document.body.querySelector('.eq-band-popup-extend')).toBeNull()
    expect(document.body.querySelector('[data-key="dyn_thresh"]')).toBeNull()
    await unmountRoot(root)
  })

  it('dynamic band: extends with the four dyn_* knobs (reusing SelectedBandInspector)', async () => {
    const EqBandPopup = await loadEqBandPopupFixture()
    const { root } = await renderPopup(EqBandPopup, {
      band: makeDynamicBand(), bandIndex: 0, setBandParam: vi.fn(),
      removeBand: vi.fn(), duplicateBand: vi.fn(), onClose: vi.fn(),
    })

    const extend = document.body.querySelector('.eq-band-popup-extend')
    expect(extend).not.toBeNull()
    for (const key of ['dyn_thresh', 'dyn_ratio', 'dyn_attack', 'dyn_release']) {
      expect(extend.querySelector(`[data-key="${key}"]`)).not.toBeNull()
    }
    expect(extend.querySelector('[data-key="spec_sens"]')).toBeNull()
    await unmountRoot(root)
  })

  it('spectral band: extends with the spec_* knobs, not dyn_*', async () => {
    const EqBandPopup = await loadEqBandPopupFixture()
    const { root } = await renderPopup(EqBandPopup, {
      band: makeSpectralBand(), bandIndex: 0, setBandParam: vi.fn(),
      removeBand: vi.fn(), duplicateBand: vi.fn(), onClose: vi.fn(),
    })

    const extend = document.body.querySelector('.eq-band-popup-extend')
    expect(extend.querySelector('[data-key="spec_sens"]')).not.toBeNull()
    expect(extend.querySelector('[data-key="dyn_thresh"]')).toBeNull()
    await unmountRoot(root)
  })

  it('the Q knob is always present regardless of mode', async () => {
    const EqBandPopup = await loadEqBandPopupFixture()
    const { root } = await renderPopup(EqBandPopup, {
      band: makeStaticBand(), bandIndex: 0, setBandParam: vi.fn(),
      removeBand: vi.fn(), duplicateBand: vi.fn(), onClose: vi.fn(),
    })
    expect(document.body.querySelector('[data-key="q"]')).not.toBeNull()
    await unmountRoot(root)
  })

  it('disables the Dynamic mode option when linPhase is on', async () => {
    const EqBandPopup = await loadEqBandPopupFixture()
    const { root } = await renderPopup(EqBandPopup, {
      band: makeStaticBand(), bandIndex: 0, linPhase: true, oversample: 0,
      setBandParam: vi.fn(), removeBand: vi.fn(), duplicateBand: vi.fn(), onClose: vi.fn(),
    })
    const modeTrigger = document.body.querySelectorAll('.eq-band-popup-select')[1]
    await act(async () => {
      modeTrigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    const options = Array.from(document.body.querySelectorAll('.xleth-select-popup .xleth-select-option'))
    expect(options[1].disabled).toBe(true)  // Dynamic
    expect(options[2].disabled).toBe(true)  // Spectral (linPhase also blocks it)
    expect(options[0].disabled).toBe(false) // Static always enabled
    await unmountRoot(root)
  })

  it('disables only Spectral (not Dynamic) when oversampling is active', async () => {
    const EqBandPopup = await loadEqBandPopupFixture()
    const { root } = await renderPopup(EqBandPopup, {
      band: makeStaticBand(), bandIndex: 0, linPhase: false, oversample: 1,
      setBandParam: vi.fn(), removeBand: vi.fn(), duplicateBand: vi.fn(), onClose: vi.fn(),
    })
    const modeTrigger = document.body.querySelectorAll('.eq-band-popup-select')[1]
    await act(async () => {
      modeTrigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    const options = Array.from(document.body.querySelectorAll('.xleth-select-popup .xleth-select-option'))
    expect(options[1].disabled).toBe(false) // Dynamic unaffected by oversample
    expect(options[2].disabled).toBe(true)  // Spectral blocked by oversample
    await unmountRoot(root)
  })

  it('the power toggle flips enabled through setBandParam', async () => {
    const EqBandPopup = await loadEqBandPopupFixture()
    const setBandParam = vi.fn()
    const { root } = await renderPopup(EqBandPopup, {
      band: makeStaticBand({ enabled: 1 }), bandIndex: 4, setBandParam,
      removeBand: vi.fn(), duplicateBand: vi.fn(), onClose: vi.fn(),
    })

    await act(async () => {
      document.body.querySelector('.eq-band-popup-power').dispatchEvent(
        new window.MouseEvent('click', { bubbles: true })
      )
    })
    expect(setBandParam).toHaveBeenCalledWith(4, 'enabled', 0)
    await unmountRoot(root)
  })

  it('the type select round-trips through setBandParam', async () => {
    const EqBandPopup = await loadEqBandPopupFixture()
    const setBandParam = vi.fn()
    const { root } = await renderPopup(EqBandPopup, {
      band: makeStaticBand(), bandIndex: 1, setBandParam,
      removeBand: vi.fn(), duplicateBand: vi.fn(), onClose: vi.fn(),
    })

    const typeTrigger = document.body.querySelectorAll('.eq-band-popup-select')[0]
    await act(async () => {
      typeTrigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    const option = document.body.querySelector('.xleth-select-popup [data-value="4"]') // High Pass
    await act(async () => {
      option.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    expect(setBandParam).toHaveBeenCalledWith(1, 'type', 4)
    await unmountRoot(root)
  })

  it('delete requires confirmation, then calls removeBand and onClose', async () => {
    const EqBandPopup = await loadEqBandPopupFixture()
    const removeBand = vi.fn()
    const onClose = vi.fn()
    const { root } = await renderPopup(EqBandPopup, {
      band: makeStaticBand(), bandIndex: 3, setBandParam: vi.fn(),
      removeBand, duplicateBand: vi.fn(), onClose,
    })

    const findByText = (text) =>
      Array.from(document.body.querySelectorAll('button')).find(b => b.textContent === text)

    await act(async () => {
      findByText('Delete').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    expect(document.body.querySelector('.eq-band-popup-confirm')).not.toBeNull()
    expect(removeBand).not.toHaveBeenCalled()

    await act(async () => {
      findByText('Y').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    expect(removeBand).toHaveBeenCalledWith(3)
    expect(onClose).toHaveBeenCalled()
    await unmountRoot(root)
  })

  it('duplicate calls duplicateBand with the band index', async () => {
    const EqBandPopup = await loadEqBandPopupFixture()
    const duplicateBand = vi.fn()
    const { root } = await renderPopup(EqBandPopup, {
      band: makeStaticBand(), bandIndex: 5, setBandParam: vi.fn(),
      removeBand: vi.fn(), duplicateBand, onClose: vi.fn(),
    })

    const findByText = (text) =>
      Array.from(document.body.querySelectorAll('button')).find(b => b.textContent === text)
    await act(async () => {
      findByText('Duplicate').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    expect(duplicateBand).toHaveBeenCalledWith(5)
    await unmountRoot(root)
  })

  it('clicking outside the popup calls onClose', async () => {
    const EqBandPopup = await loadEqBandPopupFixture()
    const onClose = vi.fn()
    const { root } = await renderPopup(EqBandPopup, {
      band: makeStaticBand(), bandIndex: 0, setBandParam: vi.fn(),
      removeBand: vi.fn(), duplicateBand: vi.fn(), onClose,
    })

    await act(async () => {
      document.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }))
    })
    expect(onClose).toHaveBeenCalled()
    await unmountRoot(root)
  })

  it('the close (x) button calls onClose', async () => {
    const EqBandPopup = await loadEqBandPopupFixture()
    const onClose = vi.fn()
    const { root } = await renderPopup(EqBandPopup, {
      band: makeStaticBand(), bandIndex: 0, setBandParam: vi.fn(),
      removeBand: vi.fn(), duplicateBand: vi.fn(), onClose,
    })

    await act(async () => {
      document.body.querySelector('.eq-band-popup-close').dispatchEvent(
        new window.MouseEvent('click', { bubbles: true })
      )
    })
    expect(onClose).toHaveBeenCalled()
    await unmountRoot(root)
  })
})
