import React from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import MacroAutomationLanes from './MacroAutomationLanes.jsx'
import { buildTrackLayout } from './timelineRowLayout.js'
import { PPQ } from '../../constants/timeline.js'

function layoutFor(graphStates) {
  return buildTrackLayout({ tracks: [{ id: 't1', name: 'Track 1' }], graphStates })
}

function gs({ visible = true, targetUnavailable = false, loopEnabled = false, clipId = 'c1' } = {}) {
  return {
    t1: {
      trackId: 't1',
      nodes: [{ id: 'm1', type: 'macro', label: 'Macro 1' }],
      macroAutomationLanes: [{
        laneId: 'lane-m1',
        macroNodeId: 'm1',
        target: 'normalizedValue',
        visible,
        targetUnavailable,
        clips: [{
          clipId,
          startTick: PPQ * 2,
          lengthTicks: PPQ * 4,
          loopEnabled,
          points: [
            { tick: 0, value: 1, curve: 'linear' },
            { tick: PPQ * 2, value: 0.25, curve: 'linear' },
            { tick: PPQ * 4, value: 0.5, curve: 'linear' },
          ],
        }],
      }],
    },
  }
}

function render(graphStates) {
  const trackLayout = layoutFor(graphStates)
  return renderToStaticMarkup(
    <MacroAutomationLanes
      trackLayout={trackLayout}
      graphStates={graphStates}
      pixelsPerBeat={40}
      scrollOffset={0}
      snapGranularity="1/16"
    />,
  )
}

describe('MacroAutomationLanes', () => {
  it('renders a child lane row containing the automation clip (not an overlay pill)', () => {
    const html = render(gs())
    expect(html).toContain('macro-automation-lane')
    expect(html).toContain('data-lane-id="lane-m1"')
    expect(html).toContain('macro-automation-clip')
    expect(html).toContain('data-clip-id="c1"')
    // The retired FXG.4-h-fix overlay strip class must NOT appear.
    expect(html).not.toContain('macro-automation-clip-pill')
  })

  it('renders the curve polyline and one handle per automation point inside the clip', () => {
    const html = render(gs())
    expect(html).toContain('<polyline')
    // three points → three draggable point handles
    const points = html.match(/macro-automation-point/g) ?? []
    expect(points.length).toBe(3)
  })

  it('marks looped clips with the loop class + indicator', () => {
    const html = render(gs({ loopEnabled: true }))
    expect(html).toContain('is-looped')
    expect(html).toContain('macro-automation-clip-loop')
  })

  it('renders nothing when the only lane is hidden', () => {
    const html = render(gs({ visible: false }))
    expect(html).toBe('')
  })

  it('renders an orphaned lane safely with no editable point handles', () => {
    const html = render(gs({ targetUnavailable: true }))
    expect(html).toContain('macro-automation-lane--orphan')
    expect(html).toContain('macro unavailable')
    // orphan lanes are not editable → no point handles rendered
    expect(html).not.toContain('macro-automation-point')
  })
})
