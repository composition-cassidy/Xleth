import { useState, useEffect, useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import { Plus, Trash2, RefreshCw, FolderSearch, Play, Square } from 'lucide-react'
import { timelineEvents } from '../timelineEvents.js'
import ImportDropZone from './ImportDropZone.jsx'
import { useXlethRootContext } from '../windowing/contexts/XlethRootContext.jsx'
import SourceCard from './SourceCard.jsx'
import ContextMenu from './ContextMenu.jsx'
import { useToast } from './Toast.jsx'
import { DEFAULT_LABELS, loadCustomLabels, labelColor } from '../constants/labels.js'
import { getPickerPaths, openFilePicker } from './filePicker/filePickerService.js'
import { EmptyState, IconButton, PianoRollIcon, SamplerIcon } from '../ui-kit'
import useBrowserStore from '../stores/browserStore.js'
import { formatClock, moveRowFocus } from './browser/browserFormat.js'
import {
  getActivePreviewId,
  getMediaPort,
  startPreview,
  subscribePreview,
  togglePreview,
} from './samplePreview.js'
import styles from './browser/Browser.module.css'

const SOURCE_IMPORT_FILTERS = [
  { name: 'All Supported', extensions: ['mp4', 'avi', 'mov', 'mkv', 'wav', 'mp3', 'flac', 'ogg', 'aac', 'm4a'] },
  { name: 'Video Files', extensions: ['mp4', 'avi', 'mov', 'mkv'] },
  { name: 'Audio Files', extensions: ['wav', 'mp3', 'flac', 'ogg', 'aac', 'm4a'] },
  { name: 'All Files', extensions: ['*'] },
]

function previewRegionFor(source) {
  return {
    id: `source-${source.id}`,
    name: source.name,
    startTime: 0,
    endTime: source.duration || 0,
  }
}

export default function ProjectMediaTab({ onOpenPicker, query = '' }) {
  const { onOpenMidiImport } = useXlethRootContext()
  const { showToast } = useToast()
  const [sources, setSources] = useState([])
  const [thumbnails, setThumbnails] = useState({})   // { [sourceId]: dataURL }
  const [importing, setImporting] = useState(false)
  const [contextMenu, setContextMenu] = useState(null) // { x, y, source }
  const [labelPickerMenu, setLabelPickerMenu] = useState(null) // { x, y, source }
  const [selectedId, setSelectedId] = useState(null)
  const autoPreview = useBrowserStore((s) => s.autoPreview)
  const prevSourceIds = useRef(new Set())
  const sourceRequestId = useRef(0)
  const projectGeneration = useRef(0)

  // ── Fetch sources from engine ─────────────────────────────────────────────
  const fetchSources = useCallback(async () => {
    try {
      const srcs = await window.xleth?.timeline?.getSources()
      if (Array.isArray(srcs)) {
        // Normalize fileName → name so all UI components can use source.name
        return srcs.map(s => ({ ...s, name: s.name ?? s.fileName }))
      }
    } catch (e) {
      console.error('[Browser] Error fetching sources:', e)
    }
    return null
  }, [])

  // ── Fetch thumbnail for a source ──────────────────────────────────────────
  const fetchThumbnail = useCallback(async (source, generation = projectGeneration.current) => {
    if (!source.filePath) return
    try {
      const dataUrl = await window.xleth?.project?.getSourceThumbnail(source.filePath, source.duration)
      if (dataUrl && generation === projectGeneration.current) {
        console.log(`[Browser] Thumbnail generated: id=${source.id}`)
        setThumbnails(prev => ({ ...prev, [source.id]: dataUrl }))
      }
    } catch (e) {
      console.error(`[Browser] Thumbnail error for id=${source.id}:`, e)
    }
  }, [])

  // ── Initial load ──────────────────────────────────────────────────────────
  const refreshSources = useCallback(async ({ resetProject = false } = {}) => {
    if (resetProject) {
      projectGeneration.current += 1
      prevSourceIds.current.clear()
      setThumbnails({})
    }

    const requestId = ++sourceRequestId.current
    const generation = projectGeneration.current
    const srcs = await fetchSources()
    if (!srcs || requestId !== sourceRequestId.current) return null

    setSources(srcs)
    const currentIds = new Set(srcs.map(s => String(s.id)))
    setThumbnails(prev => Object.fromEntries(
      Object.entries(prev).filter(([id]) => currentIds.has(id))
    ))

    for (const source of srcs) {
      if (!prevSourceIds.current.has(source.id)) {
        prevSourceIds.current.add(source.id)
        if (source.hasVideo !== false) fetchThumbnail(source, generation)
      }
    }
    return srcs
  }, [fetchSources, fetchThumbnail])

  // Refresh while this tab remains mounted; switching tabs must not be required.
  useEffect(() => {
    refreshSources()
    const onSourcesChanged = () => refreshSources()
    const offProjectLoaded = window.xleth?.onProjectLoaded?.(
      () => refreshSources({ resetProject: true })
    )
    timelineEvents.addEventListener('timeline-sources-changed', onSourcesChanged)
    return () => {
      sourceRequestId.current += 1
      offProjectLoaded?.()
      timelineEvents.removeEventListener('timeline-sources-changed', onSourcesChanged)
    }
  }, [refreshSources])

  // ── Import via dialog ─────────────────────────────────────────────────────
  const handleImportDialog = useCallback(async () => {
    if (importing) return
    console.log('[Browser] Import requested (dialog)')
    setImporting(true)

    try {
      const picked = await openFilePicker({
        mode: 'openFiles',
        title: 'Import Sources',
        subtitle: 'Choose audio or video files to add to the current project.',
        actionLabel: 'Import',
        filters: SOURCE_IMPORT_FILTERS,
        legacyPicker: () => window.xleth?.project?.openImportDialog(),
      })
      const filePaths = getPickerPaths(picked)
      if (filePaths.length === 0) {
        console.log('[Browser] Import cancelled')
        return
      }
      await importFiles(filePaths)
    } catch (e) {
      console.error('[Browser] Import error:', e)
    } finally {
      setImporting(false)
    }
  }, [importing])

  // ── Import via drop ───────────────────────────────────────────────────────
  const handleFilesDropped = useCallback(async (filePaths) => {
    if (importing) return
    setImporting(true)
    try {
      await importFiles(filePaths)
    } catch (e) {
      console.error('[Browser] Drop import error:', e)
    } finally {
      setImporting(false)
    }
  }, [importing])

  // ── Shared import logic ───────────────────────────────────────────────────
  async function importFiles(filePaths) {
    let didImport = false

    for (const fp of filePaths) {
      const name = fp.replace(/^.*[\\/]/, '')
      console.log(`[Browser] Importing ${name}`)

      try {
        const sourceId = await window.xleth?.project?.importSource(fp)
        if (!Number.isFinite(sourceId) || sourceId < 0) {
          throw new Error('Engine rejected the media file.')
        }
        didImport = true
        console.log(`[Browser] Import complete: id=${sourceId} ${name}`)
      } catch (e) {
        console.error(`[Browser] Error importing ${name}:`, e)
        showToast(`Import failed: ${name} (${e?.message || 'unknown error'})`, 'error')
      }
    }

    if (!didImport) return

    // Refresh sources list after all imports
    const srcs = await refreshSources()
    if (srcs) {
      timelineEvents.dispatchEvent(new Event('timeline-sources-changed'))
    }
  }

  // ── Poll while any source is still transcoding ─────────────────────────────
  useEffect(() => {
    const anyTranscoding = sources.some(s => !s.proxyReady)
    if (!anyTranscoding) return

    const interval = setInterval(async () => {
      const updated = await window.xleth?.timeline?.getSources()
      if (Array.isArray(updated)) {
        const normalized = updated.map(s => ({ ...s, name: s.name ?? s.fileName }))
        setSources(normalized)
        if (normalized.every(s => s.proxyReady)) clearInterval(interval)
      }
    }, 2000)

    return () => clearInterval(interval)
  }, [sources])

  // ── Context menu ──────────────────────────────────────────────────────────
  const handleContextMenu = useCallback((e, source) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, source })
  }, [])

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  const closeLabelPicker = useCallback(() => {
    setLabelPickerMenu(null)
  }, [])

  const contextMenuItems = contextMenu ? [
    {
      label: 'Reveal in Explorer',
      icon: FolderSearch,
      onClick: () => {
        console.log(`[Browser] Reveal: ${contextMenu.source.filePath}`)
        window.xleth?.shell?.showItemInFolder(contextMenu.source.filePath)
      },
    },
    {
      label: 'Import as Sample',
      icon: SamplerIcon,
      onClick: () => {
        // Open label picker as a second context menu at the same position
        setLabelPickerMenu({ x: contextMenu.x, y: contextMenu.y, source: contextMenu.source })
      },
    },
    {
      label: 'Re-transcode Proxy',
      icon: RefreshCw,
      onClick: () => {
        console.log(`[Browser] Re-transcode requested: id=${contextMenu.source.id}`)
        // Future: dedicated re-transcode endpoint
      },
    },
    { type: 'separator' },
    {
      label: 'Remove',
      icon: Trash2,
      danger: true,
      onClick: async () => {
        const id = contextMenu.source.id
        console.log(`[Browser] Source removed: id=${id}`)
        try {
          await window.xleth?.project?.removeSource(id)
        } catch (e) {
          console.error(`[Browser] Engine removeSource failed: id=${id}`, e)
        }
        setSources(prev => prev.filter(s => s.id !== id))
        setThumbnails(prev => {
          const next = { ...prev }
          delete next[id]
          return next
        })
        prevSourceIds.current.delete(id)
        setSelectedId(cur => (cur === id ? null : cur))
        timelineEvents.dispatchEvent(new Event('timeline-sources-changed'))
      },
    },
  ] : []

  // Label picker items for "Import as Sample"
  const labelPickerItems = labelPickerMenu ? [
    ...[...DEFAULT_LABELS, ...loadCustomLabels()].map(label => ({
      label,
      icon: <span className={styles.swatch} style={{ background: labelColor(label) }} />,
      onClick: async () => {
        const src = labelPickerMenu.source
        const region = {
          sourceId:  src.id,
          startTime: 0,
          endTime:   src.duration || 0,
          label,
          name:      `${label} 1`,
        }
        try {
          await window.xleth?.timeline?.addRegion(region)
          timelineEvents.dispatchEvent(new Event('timeline-regions-changed'))
          console.log(`[Browser] Imported source "${src.name}" as ${label} sample`)
        } catch (e) {
          console.warn('[Browser] addRegion failed:', e.message)
        }
      },
    })),
  ] : []

  // ── Selection + preview ───────────────────────────────────────────────────
  // Selecting an audio-only source plays it through the shared preview path when
  // Auto-preview is on. A video source shows its still in the strip below and
  // previews its sound from the strip's play button.
  const handleSelect = useCallback(async (source) => {
    setSelectedId(source.id)
    if (!autoPreview || source.hasVideo !== false) return
    startPreview({
      region: previewRegionFor(source),
      sourceFilePath: source.filePath,
      mediaPort: await getMediaPort(),
    })
  }, [autoPreview])

  const visibleSources = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? sources.filter(s => String(s.name || '').toLowerCase().includes(q)) : sources
  }, [sources, query])

  const selected = sources.find(s => s.id === selectedId) || null

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <ImportDropZone
      onFilesDropped={handleFilesDropped}
      onMidiFileDropped={(fp) => onOpenMidiImport?.(fp)}
      disabled={importing}
    >
      <div className={styles.tab}>
        {/* ── List header ─────────────────────────────────────────────── */}
        <div className={styles.listHeader}>
          <span className={styles.listTitle}>Sources</span>
          <span className={styles.count}>{sources.length}</span>
          <span className={styles.spacer} />
          <IconButton
            size="sm"
            label="Import MIDI"
            hint="Import a MIDI file into a pattern"
            onClick={() => onOpenMidiImport?.()}
          >
            <PianoRollIcon size={14} aria-hidden="true" />
          </IconButton>
          <IconButton
            size="sm"
            label="Import media"
            hint="Import audio or video files into this project"
            hintMods="Ctrl+I · or drop files on the list"
            onClick={handleImportDialog}
            disabled={importing}
          >
            <Plus size={14} aria-hidden="true" />
          </IconButton>
        </div>

        {/* ── Source list or empty state ──────────────────────────────── */}
        <div
          className={styles.list}
          role="listbox"
          aria-label="Project media"
          onKeyDown={moveRowFocus}
        >
          {sources.length === 0 ? (
            <EmptyState
              message="No media. Import audio or video, or drop files on this list."
              actionLabel="Import media"
              onAction={handleImportDialog}
            />
          ) : visibleSources.length === 0 ? (
            <EmptyState message={`No media matches "${query.trim()}".`} />
          ) : (
            visibleSources.map(source => (
              <SourceCard
                key={source.id}
                source={source}
                selected={source.id === selectedId}
                onSelect={handleSelect}
                onContextMenu={(e) => handleContextMenu(e, source)}
                onDoubleClick={onOpenPicker || null}
              />
            ))
          )}
        </div>

        {/* ── Selection strip ─────────────────────────────────────────── */}
        {selected && (
          <SelectionStrip source={selected} thumbnail={thumbnails[selected.id] || null} />
        )}

        {/* ── Context menu ────────────────────────────────────────────── */}
        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            items={contextMenuItems}
            onClose={closeContextMenu}
          />
        )}

        {/* ── Label picker (for "Import as Sample") ──────────────────── */}
        {labelPickerMenu && (
          <ContextMenu
            x={labelPickerMenu.x}
            y={labelPickerMenu.y}
            items={labelPickerItems}
            onClose={closeLabelPicker}
          />
        )}
      </div>
    </ImportDropZone>
  )
}

/**
 * What the selected source is, under the list: its still (when it has picture),
 * resolution, frame rate, length, proxy state and a play/stop for its sound. A
 * ruled strip in the panel's own flow, not a card.
 */
function SelectionStrip({ source, thumbnail }) {
  const isVideo = source.hasVideo !== false
  const playing = useSyncExternalStore(subscribePreview, getActivePreviewId) === `source-${source.id}`
  const facts = [
    isVideo && source.width ? `${source.width}×${source.height}` : null,
    isVideo && source.fps ? `${Math.round(source.fps)} fps` : null,
    formatClock(source.duration || 0),
  ].filter(Boolean).join(' · ')

  const toggle = async () => {
    togglePreview({
      region: previewRegionFor(source),
      sourceFilePath: source.filePath,
      mediaPort: await getMediaPort(),
    })
  }

  return (
    <div className={styles.strip}>
      {isVideo && (
        <div className={styles.stripThumb}>
          {thumbnail
            ? <img src={thumbnail} alt={`Still from ${source.name}`} draggable={false} />
            : <span className={styles.stripThumbEmpty}>No still</span>}
        </div>
      )}
      <div className={styles.stripInfo}>
        <span className={styles.stripName} title={source.filePath}>{source.name}</span>
        <span className={styles.stripFacts}>{facts}</span>
        <span className={styles.stripFacts} data-state={source.proxyReady ? 'ready' : 'pending'}>
          {source.proxyReady ? 'Proxy ready' : 'Transcoding proxy…'}
        </span>
      </div>
      <IconButton
        size="sm"
        label={playing ? 'Stop preview' : 'Preview sound'}
        pressed={playing}
        hint="Play this source's audio"
        onClick={toggle}
      >
        {playing ? <Square size={10} aria-hidden="true" /> : <Play size={10} aria-hidden="true" />}
      </IconButton>
    </div>
  )
}
