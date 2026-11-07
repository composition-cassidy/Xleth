/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const MEASURED = {
  enabled: true, momentary: -13.04, shortTerm: -14.2, integrated: -14.2, momentaryMax: -9, shortTermMax: -12,
  lra: 3.14, truePeakDbtp: -2.5,
}

async function load() {
  const mod = await import('../MasterLoudnessMeter.jsx')
  const { default: useMixerUiStore } = await import('../mixer/mixerUiStore.js')
  return { ...mod, Meter: mod.default, useMixerUiStore }
}

async function mount(Component) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(<Component />) })
  return { container, root }
}

const click = (el) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
const readout = (container, label) => {
  const row = Array.from(container.querySelectorAll('[data-hint]')).find(r => r.firstChild?.textContent === label)
  return row?.lastChild.textContent
}

describe('MasterLoudnessMeter dock', () => {
  beforeEach(() => {
    vi.resetModules()
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    window.xleth = {
      audio: {
        setMasterLoudnessEnabled: vi.fn(),
        resetMasterLoudness: vi.fn(async () => {}),
        getMasterLoudness: vi.fn(async () => MEASURED),
      },
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  })
  afterEach(() => {
    document.body.innerHTML = ''
    delete window.xleth
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
    vi.restoreAllMocks()
  })

  it('when off: says so, draws no bars, and every value is a dash with its unit', async () => {
    const { Meter } = await load()
    const { container, root } = await mount(Meter)

    expect(container.textContent).toContain('Metering is off')
    expect(container.querySelector('canvas')).toBeNull()
    expect(readout(container, 'Integrated')).toBe('—LUFS')
    expect(readout(container, 'Range')).toBe('—LU')
    expect(readout(container, 'True peak')).toBe('—dBTP')
    expect(container.textContent).not.toMatch(/placeholder|0 db|-6 db/i)
    await act(async () => root.unmount())
  })

  it('shows the target and ceiling as labelled values with true minus signs, not a middle-dot string', async () => {
    const { Meter } = await load()
    const { container, root } = await mount(Meter)

    expect(readout(container, 'Target')).toBe('−14.0LUFS')
    expect(readout(container, 'Ceiling')).toBe('−1.0dBTP')
    expect(container.textContent).not.toContain('·')
    await act(async () => root.unmount())
  })

  it('when on and measured: real values through formatValue, bars drawn, no Over flag under the ceiling', async () => {
    const { Meter, pollMasterLoudness } = await load()
    localStorage.setItem('xleth.meter.loudnessEnabled', '1')
    const { container, root } = await mount(Meter)
    await act(async () => { await pollMasterLoudness() })

    expect(readout(container, 'Momentary')).toBe('−13.0LUFS')
    expect(readout(container, 'Integrated')).toBe('−14.2LUFS')
    expect(readout(container, 'Range')).toBe('3.1LU')
    expect(readout(container, 'True peak')).toBe('−2.5dBTP')
    expect(container.querySelector('canvas')).not.toBeNull()
    expect(container.textContent).not.toContain('Over')
    await act(async () => root.unmount())
  })

  it('flags a true peak over the target ceiling in words, not only colour', async () => {
    const { Meter, pollMasterLoudness } = await load()
    window.xleth.audio.getMasterLoudness.mockResolvedValue({ ...MEASURED, truePeakDbtp: -0.2 })
    localStorage.setItem('xleth.meter.loudnessEnabled', '1')
    const { container, root } = await mount(Meter)
    await act(async () => { await pollMasterLoudness() })

    expect(container.textContent).toContain('Over')
    await act(async () => root.unmount())
  })

  it('an unmeasured sentinel never reads as a level', async () => {
    const { Meter, pollMasterLoudness } = await load()
    window.xleth.audio.getMasterLoudness.mockResolvedValue({
      ...MEASURED, momentary: -200, shortTerm: -200, integrated: -200, truePeakDbtp: -200,
    })
    localStorage.setItem('xleth.meter.loudnessEnabled', '1')
    const { container, root } = await mount(Meter)
    await act(async () => { await pollMasterLoudness() })

    expect(readout(container, 'Integrated')).toBe('—LUFS')
    expect(readout(container, 'True peak')).toBe('—dBTP')
    expect(container.textContent).not.toContain('Over')
    await act(async () => root.unmount())
  })

  it('turning it on persists the choice and tells the engine', async () => {
    const { Meter } = await load()
    const { container, root } = await mount(Meter)
    const toggle = Array.from(container.querySelectorAll('button[aria-pressed]')).find(b => b.textContent === 'Off')
    await click(toggle)

    expect(localStorage.getItem('xleth.meter.loudnessEnabled')).toBe('1')
    expect(window.xleth.audio.setMasterLoudnessEnabled).toHaveBeenLastCalledWith(true)
    expect(toggle.textContent).toBe('On')
    await act(async () => root.unmount())
  })

  it('offers the platform targets (not "none") and writes the key the export dialog shares', async () => {
    const { Meter } = await load()
    const { container, root } = await mount(Meter)
    await click(container.querySelector('button[aria-label="Loudness target"]'))
    const labels = Array.from(document.querySelectorAll('[role="option"]')).map(o => o.textContent)
    expect(labels).toEqual(['YouTube', 'Spotify', 'Apple Music', 'Custom'])

    await click(Array.from(document.querySelectorAll('[role="option"]')).find(o => o.textContent === 'Apple Music'))
    expect(localStorage.getItem('xleth.export.loudnessTarget')).toBe('apple_music')
    expect(readout(container, 'Target')).toBe('−16.0LUFS')
    await act(async () => root.unmount())
  })

  it('reset asks the engine to reset and clears the readouts', async () => {
    const { Meter, pollMasterLoudness } = await load()
    localStorage.setItem('xleth.meter.loudnessEnabled', '1')
    const { container, root } = await mount(Meter)
    await act(async () => { await pollMasterLoudness() })
    await click(container.querySelector('button[aria-label="Reset loudness"]'))

    expect(window.xleth.audio.resetMasterLoudness).toHaveBeenCalled()
    expect(readout(container, 'Integrated')).toBe('—LUFS')
    await act(async () => root.unmount())
  })

  it('has the strip-width setting (renderer-only UI state)', async () => {
    const { Meter, useMixerUiStore } = await load()
    const { container, root } = await mount(Meter)
    const compact = Array.from(container.querySelectorAll('[role="radio"]')).find(r => r.textContent === 'Compact')
    await click(compact)

    expect(useMixerUiStore.getState().stripWidthMode).toBe('compact')
    expect(localStorage.getItem('xleth.mixer.stripWidth')).toBe('compact')
    await act(async () => root.unmount())
  })
})

describe('loudness helpers', () => {
  it('maps LUFS to a bar fraction and keeps the sentinel empty', async () => {
    const { levelToFraction, levelText, isMeasured } = await load()
    expect(levelToFraction(-50)).toBe(0)
    expect(levelToFraction(0)).toBe(1)
    expect(levelToFraction(-25)).toBeCloseTo(0.5, 9)
    expect(levelToFraction(-200)).toBe(0)
    expect(levelToFraction(5)).toBe(1)
    expect(isMeasured(-200)).toBe(false)
    expect(levelText(-23)).toBe('−23.0')
    expect(levelText(-200)).toBe('—')
  })
})
