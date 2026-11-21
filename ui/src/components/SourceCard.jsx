import { SourceAudioIcon, SourceVideoIcon } from '../ui-kit'
import { formatClock } from './browser/browserFormat.js'
import styles from './browser/Browser.module.css'
import { iconComponent } from '../ui-kit/icons'
import { GradeIndicator } from './colorGrade/GradeStack.jsx'
import { isStillSource } from './stillSource.js'

const IcSpinnerGap = iconComponent('spinner-gap')
const IcImage = iconComponent('images-square')

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
  const still = isStillSource(source)
  const Glyph = still ? IcImage : isVideo ? SourceVideoIcon : SourceAudioIcon

  // Audio-only sources are draggable onto the timeline — a drop creates both
  // a full-span region and a clip referencing it, so it plays like any sample.
  // Stills (images, solid colours, gradients) are drag-only: no samples to cut.
  const draggable = !isVideo || still
  const handleDragStart = draggable ? (e) => {
    const payload = {
      sourceId: source.id,
      filePath: source.filePath,
      fileName: source.name,
      duration: source.duration || 0,
      still,
    }
    e.dataTransfer.setData('application/xleth-source', JSON.stringify(payload))
    e.dataTransfer.effectAllowed = 'copy'
    window.__xlethDragSource = payload
  } : undefined
  const handleDragEnd = draggable ? () => {
    window.__xlethDragSource = null
  } : undefined

  const kind = still ? 'Image' : isVideo ? 'Video' : 'Audio'
  const openPicker = still ? null : onDoubleClick
  const proxyPending = !source.proxyReady

  return (
    <div
      className={styles.row}
      data-browser-row=""
      data-selected={selected ? 'true' : 'false'}
      data-kind={still ? 'image' : isVideo ? 'video' : 'audio'}
      role="option"
      aria-selected={selected}
      tabIndex={0}
      onClick={() => onSelect?.(source)}
      onContextMenu={onContextMenu}
      onDoubleClick={openPicker ? () => openPicker(source) : undefined}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter') { e.preventDefault(); openPicker ? openPicker(source) : onSelect?.(source) }
        if (e.key === ' ') { e.preventDefault(); onSelect?.(source) }
      }}
      draggable={draggable}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      data-hint={still
        ? `Image source: ${source.name}. Drag onto a timeline track to add it as a clip.`
        : `${kind} source: ${source.name}. Double-click to mark samples.${draggable ? ' Drag onto a timeline track to add it as a clip.' : ''}`}
      data-hint-mods={still ? 'Right-click: menu · Drag: add clip' : draggable ? 'Enter: open picker · Right-click: menu · Drag: add clip' : 'Enter: open picker · Right-click: menu'}
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
      {isVideo && <GradeIndicator target={{ level: 'source', id: source.id }} />}
      <span className={styles.duration}>{still ? 'Still' : formatClock(source.duration || 0)}</span>
    </div>
  )
}
