import React from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import MacroAutomationLanes, {
  macroAutomationClipClassName,
  macroAutomationPointClassName,
} from './MacroAutomationLanes.jsx'
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
            { tick: PPQ, value: 0.25, curve: 'linear' },
            { tick: PPQ * 2, value: 0.5, curve: 'linear' },
          ],
        }],
      }],
    },
  }
}

function render(graphStates, props = {}) {
  const trackLayout = layoutFor(graphStates)
  return renderToStaticMarkup(
    <MacroAutomationLanes
      trackLayout={trackLayout}
      graphStates={graphStates}
      pixelsPerBeat={40}
      scrollOffset={0}
      snapGranularity="1/16"
      {...props}
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
    expect(html).toContain('macro-automation-clip-curve-main')
    // three points → three draggable point handles
    const points = html.match(/macro-automation-point/g) ?? []
    expect(points.length).toBe(3)
  })

  it('marks looped clips with the loop class + indicator and ghost repetitions', () => {
    const html = render(gs({ loopEnabled: true }))
    expect(html).toContain('is-looped')
    expect(html).toContain('macro-automation-clip-loop')
    expect(html).toContain('macro-automation-clip-curve-ghost')
    expect(html).toContain('macro-automation-loop-divider')
    expect(html).toContain('macro-automation-point--loop-boundary')
  })

  it('does not render ghost repetitions for non-loop clips', () => {
    const html = render(gs({ loopEnabled: false }))
    expect(html).not.toContain('macro-automation-clip-curve-ghost')
    expect(html).not.toContain('macro-automation-loop-divider')
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

  it('applies point hover state to the hovered point and clip', () => {
    const hoverTarget = { kind: 'point', clipId: 'c1', laneId: 'lane-m1', pointIndex: 0, cursor: 'move' }
    const html = render(gs(), { initialHoverTarget: hoverTarget })
    expect(html).toContain('is-hover-point')
    expect(html).toContain('macro-automation-point is-hovered')
  })

  it('applies segment hover state and renders the segment hover overlay', () => {
    const hoverTarget = { kind: 'segment', clipId: 'c1', laneId: 'lane-m1', segmentIndex: 0, cursor: 'crosshair' }
    const html = render(gs(), { initialHoverTarget: hoverTarget })
    expect(html).toContain('is-hover-segment')
    expect(html).toContain('macro-automation-clip-curve-segment-hover')
  })

  it('applies resize-start hover state separately from point and segment hover', () => {
    const hoverTarget = { kind: 'resize-start', clipId: 'c1', laneId: 'lane-m1', cursor: 'ew-resize' }
    const html = render(gs(), { initialHoverTarget: hoverTarget })
    expect(html).toContain('is-hover-resize-start')
    expect(html).not.toContain('is-hover-point')
    expect(html).not.toContain('is-hover-segment')
  })

  it('applies a distinct clip-body hover state', () => {
    const hoverTarget = { kind: 'clip-body', clipId: 'c1', laneId: 'lane-m1', cursor: 'grab' }
    const html = render(gs(), { initialHoverTarget: hoverTarget })
    expect(html).toContain('is-hover-body')
  })

  it('maps hover targets to stable clip and point class names', () => {
    expect(macroAutomationClipClassName({
      clipId: 'c1',
      hoverTarget: { kind: 'resize-start', clipId: 'c1' },
    })).toBe('macro-automation-clip is-hover-resize-start')
    expect(macroAutomationPointClassName({
      clipId: 'c1',
      pointIndex: 0,
      hoverTarget: { kind: 'point', clipId: 'c1', pointIndex: 0 },
    })).toBe('macro-automation-point is-hovered')
  })
})
