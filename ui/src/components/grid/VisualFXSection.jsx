import { useState, useCallback } from 'react'
import EffectRow from './EffectRow.jsx'
import VisualFXSectionHeader from './VisualFXSectionHeader.jsx'
import VisualFXAddDropdown from './VisualFXAddDropdown.jsx'
import NonChainableEffectParams from './NonChainableEffectParams.jsx'
import ChainableEffectParams from './ChainableEffectParams.jsx'

const NC_ITEMS = [
  { id: 'bounce',     label: 'Bounce',         field: 'bounce',     ipc: 'setTrackBounceSettings'     },
  { id: 'zoomPanRot', label: 'Zoom/Pan/Rot',   field: 'zoomPanRot', ipc: 'setTrackZoomPanRotSettings' },
  { id: 'pingPong',   label: 'Ping-Pong Loop', field: 'pingPong',   ipc: 'setTrackPingPongSettings'   },
]

const CHAIN_NAMES = {
  0: 'Desaturation', 1: 'Tint', 2: 'Brightness & Contrast',
  3: 'TV Simulator', 4: 'Zoom/Pan/Rot (per-cell)',
}

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

  const chain      = track.visualEffectChain ?? []
  const shownCount = shownList.length + chain.length

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

  // ── Chainable ──────────────────────────────────────────────────────────────

  const handleAddChain = useCallback(async (typeId) => {
    if (chain.some(fx => fx.type === typeId)) {
      const name = CHAIN_NAMES[typeId] ?? 'effect'
      if (!window.confirm(`This track already has a ${name}. Add another?`)) return false
    }
    const newIdx = chain.length
    await window.xleth?.timeline?.addVisualEffect(track.id, typeId)
    setRecentlyAdded({ kind: 'chain', idx: newIdx })
    fetchTracks()
    return true
  }, [track.id, chain, fetchTracks])

  const handleRemoveChain = useCallback(async (fxIdx) => {
    await window.xleth?.timeline?.removeVisualEffect(track.id, fxIdx)
    fetchTracks()
  }, [track.id, fetchTracks])

  const handleToggleChain = useCallback(async (fxIdx) => {
    const fx = chain[fxIdx]
    if (!fx) return
    await window.xleth?.timeline?.setVisualEffectBypassed(track.id, fxIdx, !fx.bypassed)
    fetchTracks()
  }, [track.id, chain, fetchTracks])

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

  const handleChainReorder = useCallback(async (fromIdx, insertBefore) => {
    const n = chain.length
    // Build identity index array, then splice to get the permutation
    const indices = Array.from({ length: n }, (_, i) => i)
    const [moved] = indices.splice(fromIdx, 1)
    const at = insertBefore > fromIdx ? insertBefore - 1 : insertBefore
    indices.splice(at, 0, moved)
    // indices[i] is the original chain index that should now be at position i
    await window.xleth?.timeline?.setTrackVisualEffectChainOrder(track.id, indices)
    fetchTracks()
  }, [track.id, chain, fetchTracks])

  // ── Clear all ──────────────────────────────────────────────────────────────

  const handleClearAll = useCallback(async () => {
    if (shownCount > 3 && !window.confirm('Clear all visual effects on this track?')) return
    for (let i = chain.length - 1; i >= 0; --i)
      await window.xleth?.timeline?.removeVisualEffect(track.id, i)
    for (const id of shownList) {
      const item = NC_ITEMS.find(nc => nc.id === id)
      if (item)
        await window.xleth?.timeline?.[item.ipc](track.id, { ...(track[item.field] ?? {}), enabled: false })
    }
    setShownList([])
    setRecentlyAdded(null)
    fetchTracks()
  }, [track, chain, shownList, shownCount, fetchTracks])

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
          onAddChainable={handleAddChain}
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

        {(shownList.length > 0 || chain.length > 0) && <div className="fx-divider" />}

        {chain.map((fx, fxIdx) => (
          <EffectRow
            key={fxIdx}
            glyph="●"
            enabled={!fx.bypassed}
            label={CHAIN_NAMES[fx.type] ?? `Effect ${fx.type}`}
            hasParams={true}
            defaultExpanded={recentlyAdded?.kind === 'chain' && recentlyAdded.idx === fxIdx}
            groupKind="chain"
            sourceIndex={fxIdx}
            onReorder={handleChainReorder}
            onToggle={() => handleToggleChain(fxIdx)}
            onRemove={() => handleRemoveChain(fxIdx)}
          >
            <ChainableEffectParams fx={fx} trackId={track.id} fxIdx={fxIdx} fetchTracks={fetchTracks} />
          </EffectRow>
        ))}
      </div>
    </div>
  )
}
