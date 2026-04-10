import { Music2, Loader2, Check } from 'lucide-react'
import ProgressBar from './ProgressBar.jsx'

/**
 * Renders a single imported source in the media list.
 *
 * Props:
 *   source        – { id, name, filePath, width, height, fps, duration, proxyReady, hasVideo }
 *   thumbnail     – base64 data URL or null
 *   onContextMenu – (e) => void
 *   onDoubleClick – (source) => void  — opens Sample Picker
 */
export default function SourceCard({
  source,
  thumbnail,
  onContextMenu,
  onDoubleClick,
}) {
  const isVideo = source.hasVideo !== false
  const duration = formatDuration(source.duration || 0)
  const resolution = isVideo && source.width
    ? `${source.width}×${source.height}`
    : null
  const fpsStr = isVideo && source.fps ? `${Math.round(source.fps)}fps` : null

  // Audio-only sources are draggable onto the timeline — a drop creates both
  // a full-span region and a clip referencing it, so it plays like any sample.
  const draggable = !isVideo
  const handleDragStart = draggable ? (e) => {
    const payload = {
      sourceId: source.id,
      filePath: source.filePath,
      fileName: source.name,
      duration: source.duration || 0,
    }
    e.dataTransfer.setData('application/xleth-source', JSON.stringify(payload))
    e.dataTransfer.effectAllowed = 'copy'
    window.__xlethDragSource = payload
  } : undefined
  const handleDragEnd = draggable ? () => {
    window.__xlethDragSource = null
  } : undefined

  return (
    <div
      className="source-card"
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick ? () => onDoubleClick(source) : undefined}
      draggable={draggable}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      style={onDoubleClick || draggable ? { cursor: draggable ? 'grab' : 'pointer' } : undefined}
      title={draggable ? 'Drag onto a timeline track to add as a clip' : undefined}
    >
      {/* ── Thumbnail ───────────────────────────────────────────────── */}
      <div className="source-card-thumbnail">
        {thumbnail ? (
          <img src={thumbnail} alt={source.name} draggable={false} />
        ) : isVideo ? (
          <div className="source-card-thumbnail-placeholder" />
        ) : (
          <div className="source-card-thumbnail-placeholder">
            <Music2 size={18} />
          </div>
        )}
      </div>

      {/* ── Info ─────────────────────────────────────────────────────── */}
      <div className="source-card-info">
        <span className="source-card-filename" title={source.name}>
          {source.name}
        </span>
        <div className="source-card-meta">
          {resolution && <span className="source-card-badge">{resolution}</span>}
          {fpsStr && <span className="source-card-badge">{fpsStr}</span>}
          <span className="source-card-duration">{duration}</span>
        </div>
        {!source.proxyReady && (
          <ProgressBar progress={null} className="source-card-progress" />
        )}
      </div>

      {/* ── Status ───────────────────────────────────────────────────── */}
      <div className="source-card-status">
        {source.proxyReady ? (
          <Check size={14} className="source-card-status-done" />
        ) : (
          <Loader2 size={14} className="source-card-status-spin" />
        )}
      </div>
    </div>
  )
}

function formatDuration(seconds) {
  const s = Math.max(0, seconds)
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}
