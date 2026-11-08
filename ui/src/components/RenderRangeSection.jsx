import React, { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '../ui-kit'
import { exportStyles as styles } from './exportPresets/exportKit.jsx'
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
    <div className={styles.range}>
      <div className={styles.rangeHeader}>
        <Button
          variant="ghost"
          aria-expanded={!collapsed}
          glyph={collapsed ? <ChevronRight /> : <ChevronDown />}
          onClick={() => setCollapsed((c) => !c)}
          data-render-range-header=""
        >
          Render range and tails
        </Button>
        {collapsed && <span className={styles.rangeSummary}>{summarizeLoopRegion(loopRegion)}</span>}
      </div>

      {!collapsed && (
        <div className={styles.rangeBody}>
          <TailRenderControls disabled={disabled} />
          {children}
        </div>
      )}
    </div>
  )
}
