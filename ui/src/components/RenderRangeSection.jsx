import React, { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import TailRenderControls from './TailRenderControls.jsx'
import useLoopRegionStore from '../stores/loopRegionStore.js'

// Shared collapsible wrapper around TailRenderControls (End Behavior, tail
// fade limits, Start Processing From). Used identically by the audio export
// dialog and by all three video export preset tabs, so the render-range /
// tail-policy fields only ever exist in one place in the DOM at a time.
// Collapsed by default — the header shows a one-line summary of the
// currently committed LoopRegion values so the block doesn't have to be
// opened just to see what it's set to.

const TAIL_MODE_LABEL = {
  tailClamp: 'Fade out',
  hardCut:   'Cut at end',
  wrap:      'Loop-safe wrap',
}

function summarizeLoopRegion(loopRegion) {
  const tailMode = loopRegion.tailMode || 'tailClamp'
  const parts = [TAIL_MODE_LABEL[tailMode] || 'Fade out']
  if (tailMode === 'tailClamp') {
    const threshold = Number.isFinite(loopRegion.tailThresholdDb) ? loopRegion.tailThresholdDb : -60
    const maxSeconds = Number.isFinite(loopRegion.tailMaxSeconds) ? loopRegion.tailMaxSeconds : 10
    parts.push(`${threshold} dBFS / ${maxSeconds}s tail`)
  }
  parts.push((loopRegion.renderOrigin || 'absolute') === 'absolute' ? 'from project start' : 'from region start')
  return parts.join(' · ')
}

export default function RenderRangeSection({ disabled = false, children }) {
  const [collapsed, setCollapsed] = useState(true)
  const loopRegion = useLoopRegionStore((s) => s.loopRegion)
  const fetchLoopRegion = useLoopRegionStore((s) => s.fetchLoopRegion)

  // Keep the collapsed-state summary accurate even before the section is
  // ever expanded (TailRenderControls only fetches once it mounts).
  useEffect(() => { fetchLoopRegion() }, [fetchLoopRegion])

  return (
    <div className="render-range-section">
      <button
        type="button"
        className="render-range-header"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        <ChevronRight size={12} className={`render-range-chevron ${!collapsed ? 'expanded' : ''}`} />
        <span className="render-range-title">Render range &amp; tails</span>
        {collapsed && <span className="render-range-summary">{summarizeLoopRegion(loopRegion)}</span>}
      </button>

      {!collapsed && (
        <div className="render-range-body">
          <TailRenderControls disabled={disabled} />
          {children}
        </div>
      )}
    </div>
  )
}
