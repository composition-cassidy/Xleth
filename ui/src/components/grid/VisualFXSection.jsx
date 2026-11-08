import { useState, useCallback } from 'react'
import EffectRow from './EffectRow.jsx'
import VisualFXSectionHeader from './VisualFXSectionHeader.jsx'
import VisualFXAddDropdown from './VisualFXAddDropdown.jsx'
import NonChainableEffectParams from './NonChainableEffectParams.jsx'
import { Button } from '../../ui-kit'
import { openVideoDevicesFor } from '../devices/video/openVideoDevices.js'

const NC_ITEMS = [
  { id: 'bounce',     label: 'Bounce',         field: 'bounce',     ipc: 'setTrackBounceSettings'     },
  { id: 'zoomPanRot', label: 'Zoom/Pan/Rot',   field: 'zoomPanRot', ipc: 'setTrackZoomPanRotSettings' },
  { id: 'pingPong',   label: 'Ping-Pong Loop', field: 'pingPong',   ipc: 'setTrackPingPongSettings'   },
]

export default function VisualFXSection({ track, fetchTracks }) {
  const [shownList, setShownList] = useState(() => {
    const list = []
    if (track.bounce?.enabled)     list.push('bounce')
    if (track.zoomPanRot?.enabled) list.push('zoomPanRot')
    if (track.pingPong?.enabled)   list.push('pingPong')
    return list
  })
  const [recentlyAdded,  setRecentlyAdded]  = useState(null)
  const [dropdownOpen,   setDropdownOpen]   = useState(false)

  // The visual effect chain lives in the Devices tab (Video view) now.
  const chain      = track.visualEffectChain ?? []
  const shownCount = shownList.length

  // ── Non-chainable ──────────────────────────────────────────────────────────

  const handleAddNC = useCallback(async (id) => {
    const item = NC_ITEMS.find(i => i.id === id)
    if (!item || shownList.includes(id)) return
    await window.xleth?.timeline?.[item.ipc](track.id, { ...(track[item.field] ?? {}), enabled: true })
    setShownList(prev => [...prev, id])
    setRecentlyAdded({ kind: 'nc', id })
    fetchTracks()
  }, [track, shownList, fetchTracks])

  const handleRemoveNC = useCallback(async (id) => {
    const item = NC_ITEMS.find(i => i.id === id)
    if (!item) return
    await window.xleth?.timeline?.[item.ipc](track.id, { ...(track[item.field] ?? {}), enabled: false })
    setShownList(prev => prev.filter(x => x !== id))
    fetchTracks()
  }, [track, fetchTracks])

  const handleToggleNC = useCallback(async (id) => {
    const item = NC_ITEMS.find(i => i.id === id)
    if (!item) return
    const cur = track[item.field]?.enabled ?? false
    await window.xleth?.timeline?.[item.ipc](track.id, { ...(track[item.field] ?? {}), enabled: !cur })
    fetchTracks()
  }, [track, fetchTracks])

  // ── Reorder ────────────────────────────────────────────────────────────────

  const handleNCReorder = useCallback((fromIdx, insertBefore) => {
    setShownList(prev => {
      const next = [...prev]
      const [item] = next.splice(fromIdx, 1)
      const at = insertBefore > fromIdx ? insertBefore - 1 : insertBefore
      next.splice(at, 0, item)
      return next
    })
  }, [])

  // ── Clear all ──────────────────────────────────────────────────────────────

  const handleClearAll = useCallback(async () => {
    if (shownCount > 3 && !window.confirm('Clear all visual effects on this track?')) return
    for (const id of shownList) {
      const item = NC_ITEMS.find(nc => nc.id === id)
      if (item)
        await window.xleth?.timeline?.[item.ipc](track.id, { ...(track[item.field] ?? {}), enabled: false })
    }
    setShownList([])
    setRecentlyAdded(null)
    fetchTracks()
  }, [track, shownList, shownCount, fetchTracks])

  return (
    <div className="fx-section">
      <div className="fx-section-header-wrap">
        <VisualFXSectionHeader
          shownCount={shownCount}
          onClearAll={handleClearAll}
          dropdownOpen={dropdownOpen}
          onToggleDropdown={() => setDropdownOpen(o => !o)}
        />
        <VisualFXAddDropdown
          open={dropdownOpen}
          shownList={shownList}
          onAddNonChainable={(id) => { setDropdownOpen(false); handleAddNC(id) }}
          onClose={() => setDropdownOpen(false)}
        />
      </div>

      <div className="fx-rows">
        {shownList.map((id, ncIdx) => {
          const item = NC_ITEMS.find(i => i.id === id)
          if (!item) return null
          return (
            <EffectRow
              key={id}
              glyph="◇"
              enabled={track[item.field]?.enabled ?? false}
              label={item.label}
              hasParams={true}
              defaultExpanded={recentlyAdded?.kind === 'nc' && recentlyAdded.id === id}
              groupKind="nc"
              sourceIndex={ncIdx}
              onReorder={handleNCReorder}
              onToggle={() => handleToggleNC(id)}
              onRemove={() => handleRemoveNC(id)}
            >
              <NonChainableEffectParams kind={id} track={track} fetchTracks={fetchTracks} />
            </EffectRow>
          )
        })}

        <div className="fx-divider" />
        <Button size="sm" onClick={() => openVideoDevicesFor(track.id)}>
          {`Chain effects (${chain.length}) in Devices`}
        </Button>
      </div>
    </div>
  )
}
