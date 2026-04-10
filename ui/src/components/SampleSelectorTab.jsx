import { useState, useEffect, useCallback, useMemo } from 'react'
import { Music, Search, Pencil, Type, Download, ArrowLeftRight, RotateCcw, Trash2, Scissors, Sliders } from 'lucide-react'
import { timelineEvents } from '../timelineEvents.js'
import { DEFAULT_LABELS, loadCustomLabels, labelColor } from '../constants/labels.js'
import SampleGroup from './SampleGroup.jsx'
import ContextMenu from './ContextMenu.jsx'
import SyllableSplitterModal from './SyllableSplitter/SyllableSplitterModal.jsx'

/**
 * Sample Selector tab — organises all marked regions by label.
 *
 * Props:
 *   onOpenPicker – (source) => void  — opens SamplePicker in center area
 */
export default function SampleSelectorTab({ onOpenPicker, activeSampleId, setActiveSampleId }) {
  // ── Data state (polled from engine) ────────────────────────────────────────
  const [regions, setRegions]   = useState([])
  const [sources, setSources]   = useState({})  // { [id]: sourceObject }
  const [contextMenu,      setContextMenu]      = useState(null)  // { x, y, region }
  const [splitterRegion,   setSplitterRegion]   = useState(null)  // Quote region being split in modal
  const [collapsedGroups,  setCollapsedGroups]  = useState(new Set())
  const [editingNameId,    setEditingNameId]    = useState(null)
  const [editingNameValue, setEditingNameValue] = useState('')
  const [searchQuery,      setSearchQuery]      = useState('')
  const [rootNotes,        setRootNotes]        = useState({})  // { [sourceId]: midiNote }

  // ── Fetch helpers ─────────────────────────────────────────────────────────
  const fetchRegions = useCallback(async () => {
    try {
      const regs = await window.xleth?.timeline?.getRegions()
      if (Array.isArray(regs)) setRegions(regs)
    } catch (e) {
      console.error('[SampleSelector] getRegions error:', e)
    }
  }, [])

  const fetchSources = useCallback(async () => {
    try {
      const srcs = await window.xleth?.timeline?.getSources()
      if (Array.isArray(srcs)) {
        const map = {}
        srcs.forEach(s => { map[s.id] = { ...s, name: s.name ?? s.fileName } })
        setSources(map)
      }
    } catch (e) {
      console.error('[SampleSelector] getSources error:', e)
    }
  }, [])

  // ── Initial load + event-driven refresh ──────────────────────────────────
  useEffect(() => {
    fetchRegions()
    fetchSources()
    console.log('[SampleSelector] Loaded')

    const onRegionsChanged = () => fetchRegions()
    const onSourcesChanged = () => fetchSources()

    timelineEvents.addEventListener('timeline-regions-changed', onRegionsChanged)
    timelineEvents.addEventListener('timeline-sources-changed', onSourcesChanged)
    return () => {
      timelineEvents.removeEventListener('timeline-regions-changed', onRegionsChanged)
      timelineEvents.removeEventListener('timeline-sources-changed', onSourcesChanged)
    }
  }, [fetchRegions, fetchSources])

  // ── Grouping by label ──────────────────────────────────────────────────────
  const customLabels = useMemo(() => loadCustomLabels(), [regions]) // re-check when regions change
  const allLabels = useMemo(() => [...DEFAULT_LABELS, ...customLabels], [customLabels])

  const grouped = useMemo(() => {
    // Filter by search
    const filtered = searchQuery
      ? regions.filter(r => {
          const q = searchQuery.toLowerCase()
          return r.name?.toLowerCase().includes(q) || r.label?.toLowerCase().includes(q)
        })
      : regions

    const map = new Map()
    // Always show default labels; custom labels only if they have samples
    DEFAULT_LABELS.forEach(l => map.set(l, []))
    filtered.forEach(r => {
      const key = r.label || 'Custom'
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(r)
    })
    return map
  }, [regions, searchQuery])

  // ── Collapse toggle ────────────────────────────────────────────────────────
  const toggleCollapse = useCallback((label) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }, [])

  // ── Context menu ───────────────────────────────────────────────────────────
  const handleContextMenu = useCallback((e, region) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, region })
  }, [])

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  // ── Rename ─────────────────────────────────────────────────────────────────
  const startRename = useCallback((region) => {
    setEditingNameId(region.id)
    setEditingNameValue(region.name || '')
    console.log(`[SampleSelector] Rename started: "${region.name}"`)
  }, [])

  const commitRename = useCallback(async () => {
    if (!editingNameId) return
    const region = regions.find(r => r.id === editingNameId)
    if (!region) { setEditingNameId(null); return }

    const newName = editingNameValue.trim() || region.name
    if (newName !== region.name) {
      console.log(`[SampleSelector] Renamed: "${region.name}" → "${newName}"`)
      try {
        await window.xleth?.timeline?.modifyRegion(editingNameId, { ...region, name: newName })
      } catch (e) {
        console.warn('[SampleSelector] modifyRegion failed:', e.message)
      }
      // Optimistic update
      setRegions(prev => prev.map(r => r.id === editingNameId ? { ...r, name: newName } : r))
    }
    setEditingNameId(null)
  }, [editingNameId, editingNameValue, regions])

  const cancelRename = useCallback(() => {
    setEditingNameId(null)
    setEditingNameValue('')
  }, [])

  // ── Change label ───────────────────────────────────────────────────────────
  const changeLabel = useCallback(async (region, newLabel) => {
    console.log(`[SampleSelector] Label changed: "${region.name}" → ${newLabel}`)
    try {
      await window.xleth?.timeline?.modifyRegion(region.id, { ...region, label: newLabel })
    } catch (e) {
      console.warn('[SampleSelector] modifyRegion failed:', e.message)
    }
    setRegions(prev => prev.map(r => r.id === region.id ? { ...r, label: newLabel } : r))
  }, [])

  // ── Delete ─────────────────────────────────────────────────────────────────
  const handleDelete = useCallback(async (region) => {
    console.log(`[SampleSelector] Deleted: "${region.name}" (id=${region.id})`)
    try {
      await window.xleth?.timeline?.removeRegion(region.id)
    } catch (e) {
      console.warn('[SampleSelector] removeRegion failed:', e.message)
    }
    setRegions(prev => prev.filter(r => r.id !== region.id))
    if (activeSampleId === region.id) setActiveSampleId(null)
  }, [activeSampleId])

  // ── Root note detection (lazy, for Pitch group) ────────────────────────────
  const fetchRootNotesForGroup = useCallback(async (samples) => {
    const uniqueSourceIds = [...new Set(samples.map(s => s.sourceId))]
    for (const sid of uniqueSourceIds) {
      if (rootNotes[sid] !== undefined) continue  // already cached
      const src = sources[sid]
      if (!src?.filePath) continue
      try {
        const result = await window.xleth?.audio?.detectRootNote(src.filePath)
        if (result) {
          setRootNotes(prev => ({ ...prev, [sid]: result.note }))
          if (result.note >= 0) {
            console.log(`[SampleSelector] Root note detected: ${src.name} → MIDI ${result.note}`)
          }
        }
      } catch (e) {
        console.warn('[SampleSelector] detectRootNote error:', e.message)
        setRootNotes(prev => ({ ...prev, [sid]: -1 }))
      }
    }
  }, [rootNotes, sources])

  // ── Build context menu items ───────────────────────────────────────────────
  const contextMenuItems = useMemo(() => {
    if (!contextMenu) return []
    const region = contextMenu.region
    const src = sources[region.sourceId]

    return [
      // Edit in Sample Picker
      {
        label: 'Edit in Sample Picker',
        icon: Pencil,
        onClick: () => {
          if (src && onOpenPicker) {
            console.log(`[SampleSelector] Edit in Picker: "${region.name}"`)
            onOpenPicker(src)
          }
        },
      },
      // Rename
      {
        label: 'Rename',
        icon: Type,
        onClick: () => startRename(region),
      },
      // Sampler Settings (Pitch regions only — they're the ones played via the sampler engine)
      ...(region.label === 'Pitch' ? [{
        label: 'Sampler Settings',
        icon: Sliders,
        onClick: () => {
          timelineEvents.dispatchEvent(new CustomEvent('open-sampler-settings', {
            detail: { regionId: region.id }
          }))
        },
      }] : []),
      { type: 'separator' },
      // Move to {Label} — flat items with color dots
      ...allLabels
        .filter(l => l !== region.label)
        .map(l => ({
          label: `Move to ${l}`,
          icon: <span className="tab-label-dot" style={{ background: labelColor(l) }} />,
          onClick: () => changeLabel(region, l),
        })),
      { type: 'separator' },
      // Split Syllables (only for Quote regions)
      ...(region.label === 'Quote' ? [{
        label: 'Split Syllables',
        icon: Scissors,
        onClick: () => setSplitterRegion(region),
      }, { type: 'separator' }] : []),
      // Export Audio
      {
        label: 'Export Audio',
        icon: Download,
        onClick: async () => {
          try {
            await window.xleth?.audio?.exportRegion(region.id)
          } catch (e) {
            console.error('[SampleSelector] Export audio failed:', e)
          }
        },
      },
      // Swap Audio
      {
        label: 'Swap Audio',
        icon: ArrowLeftRight,
        onClick: async () => {
          try {
            const filePath = await window.xleth?.audio?.openSwapAudioDialog()
            if (!filePath) return
            const result = await window.xleth?.audio?.swapRegionAudio(region.id, filePath)
            if (result?.success) {
              setRegions(prev => prev.map(r => r.id === region.id
                ? { ...r, hasSwappedAudio: true, swappedAudioPath: result.swappedPath }
                : r))
              // Invalidate the cached waveform + audio mapping for this region
              // so TimelineView re-fetches peaks and re-maps against the swapped file.
              timelineEvents.dispatchEvent(new CustomEvent('timeline-waveform-invalidate',
                { detail: { regionId: region.id } }))
            } else if (result?.error) {
              console.error('[SampleSelector] Swap audio failed:', result.error)
            }
          } catch (e) {
            console.error('[SampleSelector] Swap audio error:', e)
          }
        },
      },
      // Revert Audio (only shown when region has swapped audio)
      ...(region.hasSwappedAudio ? [{
        label: 'Revert Audio',
        icon: RotateCcw,
        onClick: async () => {
          try {
            const result = await window.xleth?.audio?.revertRegionAudio(region.id)
            if (result?.success) {
              setRegions(prev => prev.map(r => r.id === region.id
                ? { ...r, hasSwappedAudio: false, swappedAudioPath: '' }
                : r))
              timelineEvents.dispatchEvent(new CustomEvent('timeline-waveform-invalidate',
                { detail: { regionId: region.id } }))
            } else if (result?.error) {
              console.error('[SampleSelector] Revert audio failed:', result.error)
            }
          } catch (e) {
            console.error('[SampleSelector] Revert audio error:', e)
          }
        },
      }] : []),
      { type: 'separator' },
      // Delete
      {
        label: 'Delete',
        icon: Trash2,
        danger: true,
        onClick: () => handleDelete(region),
      },
    ]
  }, [contextMenu, sources, allLabels, onOpenPicker, startRename, changeLabel, handleDelete])

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="sample-selector-tab">
      {/* ── Search bar ─────────────────────────────────────────────── */}
      <div className="tab-search-bar">
        <Search size={14} className="tab-search-icon" />
        <input
          type="text"
          className="tab-search-input"
          placeholder="Search samples..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          onKeyDown={e => e.stopPropagation()}
        />
      </div>

      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="tab-placeholder-header">
        <span className="tab-section-label">Samples</span>
        <span className="tab-item-count">{regions.length}</span>
      </div>

      {/* ── Groups or empty state ──────────────────────────────────── */}
      {regions.length === 0 && !searchQuery ? (
        <div className="tab-placeholder-empty">
          <Music size={28} strokeWidth={1} className="tab-placeholder-icon" />
          <p>No samples marked yet</p>
          <p className="tab-placeholder-hint">
            Double-click a source in Project Media to open the Sample Picker
          </p>
        </div>
      ) : (
        <div className="sample-groups">
          {[...grouped.entries()]
            .filter(([, items]) => items.length > 0)
            .map(([label, items]) => (
              <SampleGroup
                key={label}
                label={label}
                samples={items}
                collapsed={collapsedGroups.has(label)}
                onToggle={() => toggleCollapse(label)}
                activeSampleId={activeSampleId}
                onSelect={(id) => {
                  setActiveSampleId(id)
                  console.log(`[SampleSelector] Selected: id=${id}`)
                }}
                onContextMenu={handleContextMenu}
                editingNameId={editingNameId}
                editingNameValue={editingNameValue}
                onRenameChange={setEditingNameValue}
                onRenameCommit={commitRename}
                onRenameCancel={cancelRename}
                sources={sources}
                rootNotes={rootNotes}
                onFetchRootNotes={fetchRootNotesForGroup}
              />
            ))}
          {/* Show message when search yields nothing */}
          {searchQuery && [...grouped.values()].every(arr => arr.length === 0) && (
            <div className="tab-placeholder-empty" style={{ paddingTop: 12 }}>
              <p className="tab-placeholder-hint">No samples match "{searchQuery}"</p>
            </div>
          )}
        </div>
      )}

      {/* ── Context menu ───────────────────────────────────────────── */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={closeContextMenu}
        />
      )}

      {/* ── Syllable splitter modal (for Quote regions) ────────────── */}
      <SyllableSplitterModal
        isOpen={!!splitterRegion}
        region={splitterRegion}
        onClose={() => setSplitterRegion(null)}
      />
    </div>
  )
}
