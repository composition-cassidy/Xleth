import { useState, useEffect, useCallback, useRef } from 'react'
import { FolderOpen, Plus, Trash2, RefreshCw, FolderSearch, Music, Music2 } from 'lucide-react'
import { timelineEvents } from '../timelineEvents.js'
import ImportDropZone from './ImportDropZone.jsx'
import { useXlethRootContext } from '../windowing/contexts/XlethRootContext.jsx'
import SourceCard from './SourceCard.jsx'
import ContextMenu from './ContextMenu.jsx'
import { useToast } from './Toast.jsx'
import { DEFAULT_LABELS, loadCustomLabels, labelColor } from '../constants/labels.js'

export default function ProjectMediaTab({ onOpenPicker }) {
  const { onOpenMidiImport } = useXlethRootContext()
  const { showToast } = useToast()
  const [sources, setSources] = useState([])
  const [thumbnails, setThumbnails] = useState({})   // { [sourceId]: dataURL }
  const [importing, setImporting] = useState(false)
  const [contextMenu, setContextMenu] = useState(null) // { x, y, source }
  const [labelPickerMenu, setLabelPickerMenu] = useState(null) // { x, y, source }
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
      console.error('[ProjectMedia] Error fetching sources:', e)
    }
    return null
  }, [])

  // ── Fetch thumbnail for a source ──────────────────────────────────────────
  const fetchThumbnail = useCallback(async (source, generation = projectGeneration.current) => {
    if (!source.filePath) return
    try {
      const dataUrl = await window.xleth?.project?.getSourceThumbnail(source.filePath, source.duration)
      if (dataUrl && generation === projectGeneration.current) {
        console.log(`[ProjectMedia] Thumbnail generated: id=${source.id}`)
        setThumbnails(prev => ({ ...prev, [source.id]: dataUrl }))
      }
    } catch (e) {
      console.error(`[ProjectMedia] Thumbnail error for id=${source.id}:`, e)
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
    console.log('[ProjectMedia] Import requested (dialog)')
    setImporting(true)

    try {
      const filePaths = await window.xleth?.project?.openImportDialog()
      if (!filePaths || filePaths.length === 0) {
        console.log('[ProjectMedia] Import cancelled')
        return
      }
      await importFiles(filePaths)
    } catch (e) {
      console.error('[ProjectMedia] Import error:', e)
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
      console.error('[ProjectMedia] Drop import error:', e)
    } finally {
      setImporting(false)
    }
  }, [importing])

  // ── Shared import logic ───────────────────────────────────────────────────
  async function importFiles(filePaths) {
    let didImport = false

    for (const fp of filePaths) {
      const name = fp.replace(/^.*[\\/]/, '')
      console.log(`[ProjectMedia] Importing ${name}`)

      try {
        const sourceId = await window.xleth?.project?.importSource(fp)
        if (!Number.isFinite(sourceId) || sourceId < 0) {
          throw new Error('Engine rejected the media file.')
        }
        didImport = true
        console.log(`[ProjectMedia] Import complete: id=${sourceId} ${name}`)
      } catch (e) {
        console.error(`[ProjectMedia] Error importing ${name}:`, e)
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
        console.log(`[ProjectMedia] Reveal: ${contextMenu.source.filePath}`)
        window.xleth?.shell?.showItemInFolder(contextMenu.source.filePath)
      },
    },
    {
      label: 'Import as Sample',
      icon: Music,
      onClick: () => {
        // Open label picker as a second context menu at the same position
        setLabelPickerMenu({ x: contextMenu.x, y: contextMenu.y, source: contextMenu.source })
      },
    },
    {
      label: 'Re-transcode Proxy',
      icon: RefreshCw,
      onClick: () => {
        console.log(`[ProjectMedia] Re-transcode requested: id=${contextMenu.source.id}`)
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
        console.log(`[ProjectMedia] Source removed: id=${id}`)
        try {
          await window.xleth?.project?.removeSource(id)
        } catch (e) {
          console.error(`[ProjectMedia] Engine removeSource failed: id=${id}`, e)
        }
        setSources(prev => prev.filter(s => s.id !== id))
        setThumbnails(prev => {
          const next = { ...prev }
          delete next[id]
          return next
        })
        prevSourceIds.current.delete(id)
        timelineEvents.dispatchEvent(new Event('timeline-sources-changed'))
      },
    },
  ] : []

  // Label picker items for "Import as Sample"
  const labelPickerItems = labelPickerMenu ? [
    ...[...DEFAULT_LABELS, ...loadCustomLabels()].map(label => ({
      label,
      icon: <span className="tab-label-dot" style={{ background: labelColor(label) }} />,
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
          console.log(`[ProjectMedia] Imported source "${src.name}" as ${label} sample`)
        } catch (e) {
          console.warn('[ProjectMedia] addRegion failed:', e.message)
        }
      },
    })),
  ] : []

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <ImportDropZone
      onFilesDropped={handleFilesDropped}
      onMidiFileDropped={(fp) => onOpenMidiImport?.(fp)}
      disabled={importing}
    >
      <div className="project-media-tab">
        {/* ── Header ─────────────────────────────────────────────────── */}
        <div className="tab-placeholder-header">
          <span className="tab-section-label">Sources</span>
          <button
            className="tab-icon-btn"
            title="Import MIDI"
            onClick={() => onOpenMidiImport?.()}
          >
            <Music2 size={14} />
          </button>
          <button
            className="tab-icon-btn"
            title="Import source"
            onClick={handleImportDialog}
            disabled={importing}
          >
            <Plus size={14} />
          </button>
        </div>

        {/* ── Source list or empty state ──────────────────────────────── */}
        {sources.length === 0 ? (
          <div className="tab-placeholder-empty">
            <FolderOpen size={32} strokeWidth={1} className="tab-placeholder-icon" />
            <p>No sources imported</p>
            <p className="tab-placeholder-hint">
              Import video or audio files to get started
            </p>
            <p className="tab-placeholder-hint" style={{ marginTop: 4, opacity: 0.5 }}>
              Click + or drag files here
            </p>
          </div>
        ) : (
          <div className="source-list">
            {sources.map(source => (
              <SourceCard
                key={source.id}
                source={source}
                thumbnail={thumbnails[source.id] || null}
                onContextMenu={(e) => handleContextMenu(e, source)}
                onDoubleClick={onOpenPicker || null}
              />
            ))}
          </div>
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
