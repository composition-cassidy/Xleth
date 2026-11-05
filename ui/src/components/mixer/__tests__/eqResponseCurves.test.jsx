/**
 * @vitest-environment jsdom
 *
 * The engine reports one dB trace per routing group (Stereo, Left, Right, Mid,
 * Side) back to back. These cover the renderer half of that contract: the
 * store splits the flat buffer, and EqCanvas draws one line per group in that
 * group's own channel colour instead of a single averaged curve.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { splitResponseCurves, CHANNEL_MODES } from '../../../stores/eqStore.js'
import { RESPONSE_SIZE } from '../eqGeometry.js'
import EqCanvas from '../EqCanvas.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('splitResponseCurves', () => {
  it('splits the flat buffer into one trace per channel, in CHANNEL_MODES order', () => {
    const raw = new Float32Array(CHANNEL_MODES.length * RESPONSE_SIZE)
    CHANNEL_MODES.forEach((_, k) => raw.fill(k, k * RESPONSE_SIZE, (k + 1) * RESPONSE_SIZE))

    const curves = splitResponseCurves(raw)

    expect(Object.keys(curves)).toEqual(CHANNEL_MODES)
    CHANNEL_MODES.forEach((ch, k) => {
      expect(curves[ch]).toHaveLength(RESPONSE_SIZE)
      expect(curves[ch][0]).toBe(k)
      expect(curves[ch][RESPONSE_SIZE - 1]).toBe(k)
    })
  })

  it('tolerates an older engine that only sends the Stereo trace', () => {
    const curves = splitResponseCurves(new Float32Array(RESPONSE_SIZE))
    expect(Object.keys(curves)).toEqual(['stereo'])
  })

  it('returns null for a missing or short buffer', () => {
    expect(splitResponseCurves(undefined)).toBeNull()
    expect(splitResponseCurves(new Float32Array(RESPONSE_SIZE - 1))).toBeNull()
  })

  it('also works on a plain array (structured-clone fallbacks)', () => {
    const curves = splitResponseCurves(new Array(2 * RESPONSE_SIZE).fill(0))
    expect(Object.keys(curves)).toEqual(['stereo', 'left'])
  })
})

describe('EqCanvas response lines', () => {
  let container, root

  beforeAll(() => {
    // jsdom has no ResizeObserver; EqCanvas uses one to keep nodes circular.
    globalThis.ResizeObserver = class { observe() {} disconnect() {} }
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
  })

  function render(responsePaths) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root.render(
        <EqCanvas
          svgRef={{ current: null }} bands={[]} selectedBandIndex={-1}
          dbZoom={24} rangeDb={80} responsePaths={responsePaths}
          spectrumPaths={{ fill: '', maxHold: '' }} preSpectrumPaths={{ fill: '', maxHold: '' }}
          hoverReadout={null} hoveredIndex={null} onHoverBand={() => {}}
          onWheel={() => {}} onMouseDown={() => {}} onMouseMove={() => {}}
          onMouseLeave={() => {}} onBandDragStart={() => {}}
        />,
      )
    })
    return [...container.querySelectorAll('path.eqc-response-line')]
  }

  it('draws only the standard line when nothing is routed', () => {
    const lines = render({ stereo: 'M 0 0 L 1 1' })
    expect(lines).toHaveLength(1)
    expect(lines[0].getAttribute('style') ?? '').not.toContain('--xleth-eq-ch-')
  })

  it('draws a separate line per routed group, tinted with its channel colour', () => {
    const lines = render({
      stereo: 'M 0 0 L 1 1', left: 'M 0 1 L 1 2', mid: 'M 0 2 L 1 3', side: 'M 0 3 L 1 4',
    })
    expect(lines).toHaveLength(4)

    for (const ch of ['left', 'mid', 'side']) {
      const line = container.querySelector(`.eqc-response-line-${ch}`)
      expect(line, `${ch} line`).not.toBeNull()
      expect(line.getAttribute('style')).toContain(`--xleth-eq-ch-${ch}`)
    }
    // Groups with no bands get no line.
    expect(container.querySelector('.eqc-response-line-right')).toBeNull()
  })

  it('paints the standard line last so it stays on top of routed ones', () => {
    const lines = render({ stereo: 'M 0 0', side: 'M 0 1' })
    expect(lines[lines.length - 1].getAttribute('d')).toBe('M 0 0')
  })
})
