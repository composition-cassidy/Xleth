import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Type, Download, ArrowLeftRight, RotateCcw, Trash2, List, LayoutGrid, Volume2, X } from 'lucide-react'
import { timelineEvents } from '../timelineEvents.js'
import { DEFAULT_LABELS, loadCustomLabels, labelColor } from '../constants/labels.js'
import SampleGroup from './SampleGroup.jsx'
import ContextMenu from './ContextMenu.jsx'
import useSampleViewModeStore from '../stores/sampleViewModeStore.js'
import useSandboxPanelStore from '../stores/sandboxPanelStore.js'
import useBrowserStore from '../stores/browserStore.js'
import { usePanelRegistry } from '../windowing/registry/PanelRegistry.ts'
import { getPickerPath, openFilePicker } from './filePicker/filePickerService.js'
import { DrawToolIcon, EmptyState, SamplerIcon, SandboxIcon, SegmentedControl, SplitSyllablesIcon, Toggle } from '../ui-kit'
import { moveRowFocus } from './browser/browserFormat.js'
import { getMediaPort, startPreview } from './samplePreview.js'
import styles from './browser/Browser.module.css'

/**
 * Sample Selector tab — organises all marked regions by label.
 *
 * Props:
 *   onOpenPicker – (source) => void  — opens SamplePicker in center area
 *   query        – the Browser's search text for this tab
 */
export default function SampleSelectorTab({ onOpenPicker, activeSampleId, setActiveSampleId, query = '' }) {
  // ── View mode (list | thumbnails) ─────────────────────────────────────────
  const viewMode    = useSampleViewModeStore(s => s.viewMode)
  const setViewMode = useSampleViewModeStore(s => s.setViewMode)

  // ── Data state (polled from engine) ────────────────────────────────────────
  const [regions, setRegions]   = useState([])
  const [sources, setSources]   = useState({})  // { [id]: sourceObject }
  const [contextMenu,      setContextMenu]      = useState(null)  // { x, y, region }
  // Split Syllables now opens the floating windowing panel (see openSplitter).
  const [collapsedGroups,  setCollapsedGroups]  = useState(new Set())
  const [editingNameId,    setEditingNameId]    = useState(null)
  const [editingNameValue, setEditingNameValue] = useState('')
  const searchQuery = query
  const autoPreview    = useBrowserStore(s => s.autoPreview)
  const setAutoPreview = useBrowserStore(s => s.setAutoPreview)
  const setBrowserTab  = useBrowserStore(s => s.setTab)
  const [rootNotes,       setRootNotes]        = useState({})  // { [sourceId]: midiNote }
  const [renameError,      setRenameError]      = useState(null)

  // Dedup pass runs once per mount even if regions-changed fires repeatedly.
  const dedupRanRef = useRef(false)

  // ── Fetch helpers ─────────────────────────────────────────────────────────
  const fetchRegions = useCallback(async () => {
    try {
      const regs = await window.xleth?.timeline?.getRegions()
      if (Array.isArray(regs)) setRegions(regs)
    } catch (e) {
      console.error('[Browser] getRegions error:', e)
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
      console.error('[Browser] getSources error:', e)
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
        console.warn(`[Browser] Renamed "${r.oldName}" → "${r.newName}" (id=${r.region.id}, label=${r.region.label})`)
      } catch (e) {
        console.error(`[Browser] modifyRegion failed for id=${r.region.id}:`, e.message)
      }
    }
    console.warn(`[Browser] Renamed ${renames.length} duplicate sample name(s).`)
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
        console.error('[Browser] Initial load error:', e)
      }
    }
    init()
    console.log('[Browser] Loaded')

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
    console.log(`[Browser] Rename started: "${region.name}"`)
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

    console.log(`[Browser] Renamed: "${region.name}" → "${newName}"`)
    try {
      await window.xleth?.timeline?.modifyRegion(editingNameId, { ...region, name: newName })
    } catch (e) {
      console.warn('[Browser] modifyRegion failed:', e.message)
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
    console.log(`[Browser] Label changed: "${region.name}" → ${newLabel}`)
    try {
      await window.xleth?.timeline?.modifyRegion(region.id, { ...region, label: newLabel })
    } catch (e) {
      console.warn('[Browser] modifyRegion failed:', e.message)
    }
    setRegions(prev => prev.map(r => r.id === region.id ? { ...r, label: newLabel } : r))
  }, [])

  // ── Delete ─────────────────────────────────────────────────────────────────
  const handleDelete = useCallback(async (region) => {
    console.log(`[Browser] Deleted: "${region.name}" (id=${region.id})`)
    try {
      await window.xleth?.timeline?.removeRegion(region.id)
    } catch (e) {
      console.warn('[Browser] removeRegion failed:', e.message)
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
            console.log(`[Browser] Root note detected: ${src.name} → MIDI ${result.note}`)
          }
        }
      } catch (e) {
        console.warn('[Browser] detectRootNote error:', e.message)
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
        icon: DrawToolIcon,
        onClick: () => {
          if (src && onOpenPicker) {
            console.log(`[Browser] Edit in Picker: "${region.name}"`)
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
        icon: SamplerIcon,
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
          icon: <span className={styles.swatch} style={{ background: labelColor(l) }} />,
          onClick: () => changeLabel(region, l),
        })),
      { type: 'separator' },
      // Split Syllables (only for Quote regions)
      ...(region.label === 'Quote' ? [{
        label: 'Split Syllables',
        icon: SplitSyllablesIcon,
        onClick: () => {
          usePanelRegistry.getState().openPanel('splitSyllables', { region })
        },
      }] : []),
      // Open in Sample Sandbox (any region — loads it as a fresh sandbox layer)
      {
        label: 'Open in Sample Sandbox',
        icon: SandboxIcon,
        onClick: () => {
          useSandboxPanelStore.getState().setOpenTarget(region)
          usePanelRegistry.getState().openPanel('sampleSandbox')
        },
      },
      { type: 'separator' },
      // Export Audio
      {
        label: 'Export Audio',
        icon: Download,
        onClick: async () => {
          try {
            await window.xleth?.audio?.exportRegion(region.id)
          } catch (e) {
            console.error('[Browser] Export audio failed:', e)
          }
        },
      },
      // Swap Audio
      {
        label: 'Swap Audio',
        icon: ArrowLeftRight,
        onClick: async () => {
          try {
            let exportsDir = ''
            try {
              const info = await window.xleth?.project?.getInfo?.()
              exportsDir = typeof info?.exportsDir === 'string' ? info.exportsDir : ''
            } catch {}
            const picked = await openFilePicker({
              mode: 'openFile',
              title: 'Select Processed Audio',
              subtitle: 'Choose the replacement WAV for this sample.',
              actionLabel: 'Select Sample',
              initialDirectory: exportsDir || undefined,
              filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
              legacyPicker: () => window.xleth?.audio?.openSwapAudioDialog(),
            })
            const filePath = getPickerPath(picked)
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
              console.error('[Browser] Swap audio failed:', result.error)
            }
          } catch (e) {
            console.error('[Browser] Swap audio error:', e)
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
              console.error('[Browser] Revert audio failed:', result.error)
            }
          } catch (e) {
            console.error('[Browser] Revert audio error:', e)
          }
        },
      }] : []),
      // ── Video (only for regions whose source actually has a video stream) ──
      ...(src?.hasVideo ? [
        { type: 'separator' },
        // Export Video
        {
          label: 'Export Video',
          icon: Download,
          onClick: async () => {
            try {
              const result = await window.xleth?.video?.exportRegion(region.id)
              if (result?.error) console.error('[Browser] Export video failed:', result.error)
            } catch (e) {
              console.error('[Browser] Export video failed:', e)
            }
          },
        },
        // Swap Video
        {
          label: 'Swap Video',
          icon: ArrowLeftRight,
          onClick: async () => {
            try {
              const picked = await openFilePicker({
                mode: 'openFile',
                title: 'Select Replacement Video',
                subtitle: 'Choose the replacement video for this sample. Audio is unaffected.',
                actionLabel: 'Select Video',
                filters: [{ name: 'Video Files', extensions: ['mp4', 'avi', 'mov', 'mkv'] }],
                legacyPicker: () => window.xleth?.video?.openSwapVideoDialog(),
              })
              const filePath = getPickerPath(picked)
              if (!filePath) return
              const result = await window.xleth?.video?.swapRegionVideo(region.id, filePath)
              if (result?.success) {
                setRegions(prev => prev.map(r => r.id === region.id
                  ? {
                      ...r,
                      hasSwappedVideo: true,
                      swappedVideoPath: result.swappedPath,
                      swappedVideoDurationMismatch: !!result.durationMismatch,
                    }
                  : r))
                // The proxy is being regenerated in the background — clear any
                // cached preview frames for this region's source so playback
                // doesn't show stale frames from the previous video.
                timelineEvents.dispatchEvent(new CustomEvent('timeline-video-invalidate',
                  { detail: { regionId: region.id, sourceId: region.sourceId } }))
                if (result.durationMismatch) {
                  window.alert(
                    `The replacement video is ${result.replacementDurationSec?.toFixed(2)}s long, `
                    + `but this sample is ${result.originalDurationSec?.toFixed(2)}s. `
                    + `Playback has been clamped to the original duration — the video is not stretched.`)
                }
              } else if (result?.error) {
                console.error('[Browser] Swap video failed:', result.error)
              }
            } catch (e) {
              console.error('[Browser] Swap video error:', e)
            }
          },
        },
        // Revert Video (only shown when region has swapped video)
        ...(region.hasSwappedVideo ? [{
          label: 'Revert Video',
          icon: RotateCcw,
          onClick: async () => {
            try {
              const result = await window.xleth?.video?.revertRegionVideo(region.id)
              if (result?.success) {
                setRegions(prev => prev.map(r => r.id === region.id
                  ? { ...r, hasSwappedVideo: false, swappedVideoPath: '' }
                  : r))
                timelineEvents.dispatchEvent(new CustomEvent('timeline-video-invalidate',
                  { detail: { regionId: region.id, sourceId: region.sourceId } }))
              } else if (result?.error) {
                console.error('[Browser] Revert video failed:', result.error)
              }
            } catch (e) {
              console.error('[Browser] Revert video error:', e)
            }
          },
        }] : []),
      ] : []),
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

  // ── Select (+ preview) ─────────────────────────────────────────────────────
  // Selecting a sample makes it the active draw sample and, with Auto-preview on,
  // plays it through the same preview path the row's play button uses.
  const handleSelect = useCallback(async (id) => {
    setActiveSampleId(id)
    console.log(`[Browser] Selected: id=${id}`)
    if (!autoPreview) return
    const region = regions.find(r => r.id === id)
    const src = region ? sources[region.sourceId] : null
    if (!region || !src?.filePath) return
    startPreview({ region, sourceFilePath: src.filePath, mediaPort: await getMediaPort() })
  }, [autoPreview, regions, sources, setActiveSampleId])

  // ── Render ─────────────────────────────────────────────────────────────────
  const noneMatch = !!searchQuery && [...grouped.values()].every(arr => arr.length === 0)
  return (
    <div className={styles.tab}>
      {/* ── List header ────────────────────────────────────────────── */}
      <div className={styles.listHeader}>
        <span className={styles.listTitle}>Samples</span>
        <span className={styles.count}>{regions.length}</span>
        <span className={styles.spacer} />
        <Toggle
          size="sm"
          on={autoPreview}
          onChange={setAutoPreview}
          glyph={<Volume2 size={12} />}
          hint="Auto-preview: selecting a sample plays it"
        >
          Auto-preview
        </Toggle>
        <SegmentedControl
          label="View mode"
          size="sm"
          value={viewMode}
          onChange={setViewMode}
          options={[
            { value: 'list', label: <List size={13} aria-hidden="true" />, ariaLabel: 'List view', hint: 'List view' },
            { value: 'thumbnails', label: <LayoutGrid size={13} aria-hidden="true" />, ariaLabel: 'Thumbnail view', hint: 'Thumbnail view' },
          ]}
        />
      </div>

      {/* ── Rename collision error banner ──────────────────────────── */}
      {renameError && (
        <div className={styles.error} role="alert">
          <span>{renameError}</span>
          <button
            type="button"
            className={styles.errorDismiss}
            onClick={() => setRenameError(null)}
            aria-label="Dismiss"
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      )}

      {/* ── Groups or empty state ──────────────────────────────────── */}
      <div
        className={styles.list}
        role="listbox"
        aria-label="Samples"
        onKeyDown={moveRowFocus}
      >
        {regions.length === 0 && !searchQuery ? (
          <EmptyState
            message="No samples marked. Double-click a source in Media to open the picker."
            actionLabel="Open Media"
            onAction={() => setBrowserTab('media')}
          />
        ) : (
          <>
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
                  onSelect={handleSelect}
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
            {noneMatch && <EmptyState message={`No samples match "${searchQuery.trim()}".`} />}
          </>
        )}
      </div>

      {/* ── Context menu ───────────────────────────────────────────── */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={closeContextMenu}
        />
      )}

      {/* Split Syllables opens as a floating windowing panel — see the
          'Split Syllables' context-menu entry which sets the panel store
          and calls openPanel('splitSyllables'). */}
    </div>
  )
}
