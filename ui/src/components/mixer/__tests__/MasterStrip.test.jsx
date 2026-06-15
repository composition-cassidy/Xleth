/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function loadMasterStripFixture() {
  vi.doMock('../EffectChainPanel.jsx', () => ({
    default: (props) => (
      <div
        data-testid="effect-chain-panel"
        data-mode={props.mode}
        data-master={props.master ? 'true' : 'false'}
      />
    ),
  }))
  vi.doMock('../PeakMeter.jsx', () => ({
    default: () => <div data-testid="peak-meter" />,
  }))
  vi.doMock('../VolumeFader.jsx', () => ({
    default: ({ value, onChange }) => (
      <input data-testid="volume-fader" value={value} onChange={(e) => onChange(Number(e.target.value))} />
    ),
    FaderReadout: ({ value }) => <div data-testid="fader-readout">{value}</div>,
  }))

  const masterModule = await import('../MasterStrip.jsx')
  const { default: useMixerStore } = await import('../../../stores/mixerStore.js')
  return { MasterStrip: masterModule.default, useMixerStore }
}

async function renderMasterStrip(Component) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<Component />)
  })
  return { container, root }
}

describe('MasterStrip selection', () => {
  beforeEach(() => {
    vi.resetModules()
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    document.body.innerHTML = ''
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
    vi.doUnmock('../EffectChainPanel.jsx')
    vi.doUnmock('../PeakMeter.jsx')
    vi.doUnmock('../VolumeFader.jsx')
  })

  it('renders master effects as a preview and selects master on click', async () => {
    const { MasterStrip, useMixerStore } = await loadMasterStripFixture()
    useMixerStore.setState({
      master: { volume: 1 },
      selectedChainKey: null,
    })

    const { container, root } = await renderMasterStrip(MasterStrip)
    const strip = container.querySelector('.mixer-strip--master')

    expect(container.querySelector('[data-testid="effect-chain-panel"]').dataset.mode).toBe('preview')
    expect(container.querySelector('[data-testid="effect-chain-panel"]').dataset.master).toBe('true')

    await act(async () => {
      strip.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(useMixerStore.getState().selectedChainKey).toBe('master')
    expect(strip.className).toContain('mixer-strip--selected')
    await act(async () => {
      root.unmount()
    })
  })

  it('does not render track M/S/V controls on the master strip', async () => {
    const { MasterStrip, useMixerStore } = await loadMasterStripFixture()
    useMixerStore.setState({
      master: { volume: 1 },
      selectedChainKey: null,
    })

    const { container, root } = await renderMasterStrip(MasterStrip)

    expect(container.querySelector('.mixer-strip-controls')).toBeNull()
    expect(container.querySelectorAll('.mixer-ms-btn')).toHaveLength(0)
    await act(async () => {
      root.unmount()
    })
  })
})
