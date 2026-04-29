import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Music, Search, Pencil, Type, Download, ArrowLeftRight, RotateCcw, Trash2, Scissors, Sliders, List, LayoutGrid } from 'lucide-react'
import { timelineEvents } from '../timelineEvents.js'
import { DEFAULT_LABELS, loadCustomLabels, labelColor } from '../constants/labels.js'
import SampleGroup from './SampleGroup.jsx'
import ContextMenu from './ContextMenu.jsx'
import SyllableSplitterModal from './SyllableSplitter/SyllableSplitterModal.jsx'
import useSampleViewModeStore from '../stores/sampleViewModeStore.js'

/**
 * Sample Selector tab — organises all marked regions by label.
 *
 * Props:
 *   onOpenPicker – (source) => void  — opens SamplePicker in center area
 */
export default function SampleSelectorTab({ onOpenPicker, activeSampleId, setActiveSampleId }) {
  // ── View mode (list | thumbnails) ─────────────────────────────────────────
  const viewMode    = useSampleViewModeStore(s => s.viewMode)
  const setViewMode = useSampleViewModeStore(s => s.setViewMode)

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
  const [renameError,      setRenameError]      = useState(null)

  // Dedup pass runs once per mount even if regions-changed fires repeatedly.
  const dedupRanRef = useRef(false)

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

  // ── One-pass deduplication of stored duplicate names ───────────────────────
  // Projects saved before the uniqueness fix may contain two regions with the
  // same label+name. Within each label group, suffix the 2nd, 3rd, ... duplicate
  // with "(2)", "(3)", ... so every displayed name is unique. Only persists
  // renames via modifyRegion; never deletes or reorders.
  const deduplicateRegions = useCallback(async (regs) => {
    if (!Array.isArray(regs) || regs.length === 0) return 0
    const byLabel = new Map()
    for (const r of regs) {
      const key = r.label || 'Custom'
      if (!byLabel.has(key)) byLabel.set(key, [])
      byLabel.get(key).push(r)
    }
    const renames = []
    for (const [, group] of byLabel) {
      const seen = new Set()
      for (const region of group) {
        const n = region.name || ''
        if (!seen.has(n)) { seen.add(n); continue }
        let suffix = 2
        let candidate = `${n} (${suffix})`
        while (seen.has(candidate) && suffix < 100000) {
          suffix++
          candidate = `${n} (${suffix})`
        }
        seen.add(candidate)
        renames.push({ region, oldName: n, newName: candidate })
      }
    }
    if (renames.length === 0) return 0
    for (const r of renames) {
      try {
        await window.xleth?.timeline?.modifyRegion(r.region.id, { ...r.region, name: r.newName })
        console.warn(`[SampleDedup] Renamed "${r.oldName}" → "${r.newName}" (id=${r.region.id}, label=${r.region.label})`)
      } catch (e) {
        console.error(`[SampleDedup] modifyRegion failed for id=${r.region.id}:`, e.message)
      }
    }
    console.warn(`[SampleDedup] Renamed ${renames.length} duplicate sample name(s).`)
    return renames.length
  }, [])

  // ── Initial load + event-driven refresh ──────────────────────────────────
  useEffect(() => {
    const init = async () => {
      await fetchSources()
      try {
        const regs = await window.xleth?.timeline?.getRegions()
        if (!Array.isArray(regs)) return
        if (!dedupRanRef.current) {
          dedupRanRef.current = true
          const renamedCount = await deduplicateRegions(regs)
          if (renamedCount > 0) {
            const updated = await window.xleth?.timeline?.getRegions()
            setRegions(Array.isArray(updated) ? updated : regs)
            return
          }
        }
        setRegions(regs)
      } catch (e) {
        console.error('[SampleSelector] Initial load error:', e)
      }
    }
    init()
    console.log('[SampleSelector] Loaded')

    const onRegionsChanged = () => fetchRegions()
    const onSourcesChanged = () => fetchSources()

    timelineEvents.addEventListener('timeline-regions-changed', onRegionsChanged)
    timelineEvents.addEventListener('timeline-sources-changed', onSourcesChanged)
    return () => {
      timelineEvents.removeEventListener('timeline-regions-changed', onRegionsChanged)
      timelineEvents.removeEventListener('timeline-sources-changed', onSourcesChanged)
    }
  }, [fetchRegions, fetchSources, deduplicateRegions])

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
    if (!region) { setEditingNameId(null); setRenameError(null); return }

    const newName = editingNameValue.trim() || region.name
    if (newName === region.name) {
      setEditingNameId(null)
      setRenameError(null)
      return
    }

    // Fresh project-wide fetch: the `regions` state may lag the event bus.
    let allRegions = regions
    try {
      const regs = await window.xleth?.timeline?.getRegions()
      if (Array.isArray(regs)) allRegions = regs
    } catch { /* fall back to component state */ }

    const collision = allRegions.some(r =>
      r.id !== editingNameId && r.label === region.label && r.name === newName
    )
    if (collision) {
      setRenameError(`A ${region.label} sample named "${newName}" already exists.`)
      return  // keep edit mode open so the user can correct and retry
    }

    console.log(`[SampleSelector] Renamed: "${region.name}" → "${newName}"`)
    try {
      await window.xleth?.timeline?.modifyRegion(editingNameId, { ...region, name: newName })
    } catch (e) {
      console.warn('[SampleSelector] modifyRegion failed:', e.message)
    }
    // Optimistic update
    setRegions(prev => prev.map(r => r.id === editingNameId ? { ...r, name: newName } : r))
    setEditingNameId(null)
    setRenameError(null)
  }, [editingNameId, editingNameValue, regions])

  const cancelRename = useCallback(() => {
    setEditingNameId(null)
    setEditingNameValue('')
    setRenameError(null)
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
      <div className="tab-search-bar tab-search-bar--with-actions">
        <Search size={14} className="tab-search-icon" />
        <input
          type="text"
          className="tab-search-input tab-search-input--with-actions"
          placeholder="Search samples..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          onKeyDown={e => e.stopPropagation()}
        />
        <div className="tab-search-bar-actions" role="group" aria-label="View mode">
          <button
            type="button"
            className={`tab-view-toggle-btn ${viewMode === 'list' ? 'active' : ''}`}
            onClick={() => setViewMode('list')}
            title="List view"
            aria-pressed={viewMode === 'list'}
          >
            <List size={13} />
          </button>
          <button
            type="button"
            className={`tab-view-toggle-btn ${viewMode === 'thumbnails' ? 'active' : ''}`}
            onClick={() => setViewMode('thumbnails')}
            title="Thumbnail view"
            aria-pressed={viewMode === 'thumbnails'}
          >
            <LayoutGrid size={13} />
          </button>
        </div>
      </div>

      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="tab-placeholder-header">
        <span className="tab-section-label">Samples</span>
        <span className="tab-item-count">{regions.length}</span>
      </div>

      {/* ── Rename collision error banner ──────────────────────────── */}
      {renameError && (
        <div
          className="sample-selector-error-banner"
          role="alert"
          style={{
            background: '#3a1e1e',
            color: 'var(--theme-semantic-danger-text)',
            padding: '6px 10px',
            fontSize: '12px',
            margin: '4px 8px',
            borderRadius: '4px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <span>{renameError}</span>
          <button
            onClick={() => setRenameError(null)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--theme-semantic-danger-text)',
              cursor: 'pointer',
              fontSize: '14px',
              padding: '0 4px',
              lineHeight: 1,
            }}
            title="Dismiss"
          >
            ×
          </button>
        </div>
      )}

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
                viewMode={viewMode}
                onOpenPicker={onOpenPicker}
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
