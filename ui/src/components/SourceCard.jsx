import { SourceAudioIcon, SourceVideoIcon } from '../ui-kit'
import { formatClock } from './browser/browserFormat.js'
import styles from './browser/Browser.module.css'
import { iconComponent } from '../ui-kit/icons'

const IcSpinnerGap = iconComponent('spinner-gap')

/**
 * One imported source in the Media list: a 24px row with its type glyph, name,
 * proxy state and duration. (The file is still called SourceCard; it is a row
 * now, not a card.)
 *
 * Props:
 *   source        – { id, name, filePath, width, height, fps, duration, proxyReady, hasVideo }
 *   selected      – boolean
 *   onSelect      – (source) => void
 *   onContextMenu – (e) => void
 *   onDoubleClick – (source) => void  — opens Sample Picker
 */
export default function SourceCard({
  source,
  selected = false,
  onSelect,
  onContextMenu,
  onDoubleClick,
}) {
  const isVideo = source.hasVideo !== false
  const Glyph = isVideo ? SourceVideoIcon : SourceAudioIcon

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

  const kind = isVideo ? 'Video' : 'Audio'
  const proxyPending = !source.proxyReady

  return (
    <div
      className={styles.row}
      data-browser-row=""
      data-selected={selected ? 'true' : 'false'}
      data-kind={isVideo ? 'video' : 'audio'}
      role="option"
      aria-selected={selected}
      tabIndex={0}
      onClick={() => onSelect?.(source)}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick ? () => onDoubleClick(source) : undefined}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter') { e.preventDefault(); onDoubleClick ? onDoubleClick(source) : onSelect?.(source) }
        if (e.key === ' ') { e.preventDefault(); onSelect?.(source) }
      }}
      draggable={draggable}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      data-hint={`${kind} source: ${source.name}. Double-click to mark samples.${draggable ? ' Drag onto a timeline track to add it as a clip.' : ''}`}
      data-hint-mods={draggable ? 'Enter: open picker · Right-click: menu · Drag: add clip' : 'Enter: open picker · Right-click: menu'}
    >
      <span className={styles.typeGlyph} title={kind}>
        <Glyph size={14} aria-label={`${kind} source`} />
      </span>
      <span className={styles.name} title={source.name}>{source.name}</span>
      {proxyPending && (
        <span className={styles.rowGlyph} role="img" aria-label="Transcoding proxy" title="Transcoding proxy">
          <IcSpinnerGap size={14} className={styles.spin} aria-hidden="true" />
        </span>
      )}
      <span className={styles.duration}>{formatClock(source.duration || 0)}</span>
    </div>
  )
}
