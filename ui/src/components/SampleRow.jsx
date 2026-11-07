import { useState, useEffect, useCallback, useSyncExternalStore } from 'react'
import { Play, Square, ArrowLeftRight } from 'lucide-react'
import { labelColor, midiToNoteName } from '../constants/labels.js'
import { tokenValue } from '../theming/tokenValue.ts'
import { formatSampleDuration } from './browser/browserFormat.js'
import {
  getActivePreviewId,
  getMediaPort,
  subscribePreview,
  togglePreview,
} from './samplePreview.js'
import styles from './browser/Browser.module.css'

/**
 * One sample in the Browser list: a 24px row, the label's identity colour as a
 * 2px stripe on its edge, the name, then root note and duration in tabular
 * numerals. Clicking selects (the parent decides whether that also previews);
 * the play button previews on its own.
 *
 * Props:
 *   region          – { id, sourceId, startTime, endTime, label, name }
 *   isActive        – boolean (selected for drawing)
 *   onSelect        – (id) => void
 *   onContextMenu   – (e, region) => void
 *   isEditing       – boolean
 *   editValue       – string
 *   onRenameChange  – (value) => void
 *   onRenameCommit  – () => void
 *   onRenameCancel  – () => void
 *   sourceName      – string (display name of source file)
 *   sourceFilePath  – string (full path for audio playback)
 *   rootNote        – number | null (MIDI note, -1 = not found)
 */
export default function SampleRow({
  region,
  isActive,
  onSelect,
  onContextMenu,
  isEditing,
  editValue,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  sourceName,
  sourceFilePath,
  rootNote,
}) {
  const [mediaPort, setMediaPort] = useState(null)
  const isPlaying = useSyncExternalStore(subscribePreview, getActivePreviewId) === region.id

  const dur = Math.abs(region.endTime - region.startTime)

  useEffect(() => {
    let cancelled = false
    getMediaPort().then((port) => { if (!cancelled && port) setMediaPort(port) })
    return () => { cancelled = true }
  }, [])

  // ── Preview playback ───────────────────────────────────────────────────────
  const handleTogglePreview = useCallback((e) => {
    e.stopPropagation()  // don't trigger row select
    togglePreview({ region, sourceFilePath, mediaPort })
  }, [region, sourceFilePath, mediaPort])

  // ── Drag ───────────────────────────────────────────────────────────────────
  const handleDragStart = useCallback((e) => {
    const payload = {
      regionId:         region.id,
      sourceId:         region.sourceId,
      label:            region.label,
      name:             region.name,
      startTime:        region.startTime,
      endTime:          region.endTime,
      audioFilePath:    region.audioFilePath,
      hasSwappedAudio:  region.hasSwappedAudio,
      swappedAudioPath: region.swappedAudioPath,
      swappedAudioDurationSec: region.swappedAudioDurationSec,
    }
    e.dataTransfer.setData('application/xleth-sample', JSON.stringify(payload))
    e.dataTransfer.effectAllowed = 'copy'

    // Expose payload globally so timeline dragover can read it
    // (HTML5 DnD prevents reading dataTransfer.getData during dragover)
    window.__xlethDragSample = payload

    // Custom drag image — colored rectangle with sample name
    const el = document.createElement('div')
    el.textContent = region.name
    el.style.cssText = `
      position: absolute; top: -1000px; left: -1000px;
      padding: 4px 10px; border-radius: 4px; font-size: 12px;
      font-family: var(--xleth-global-font-family); font-weight: 600;
      background: ${getComputedLabelColor(region.label)}; color: #000;
      white-space: nowrap;
    `
    document.body.appendChild(el)
    e.dataTransfer.setDragImage(el, 0, 0)
    // Clean up the temporary element after browser captures it
    setTimeout(() => document.body.removeChild(el), 0)

  }, [region])

  const handleDragEnd = useCallback(() => {
    window.__xlethDragSample = null
  }, [region])

  // ── Rename key handling ────────────────────────────────────────────────────
  const handleRenameKeyDown = useCallback((e) => {
    e.stopPropagation()  // prevent SamplePicker/TransportBar shortcuts
    if (e.key === 'Enter') onRenameCommit()
    if (e.key === 'Escape') onRenameCancel()
  }, [onRenameCommit, onRenameCancel])

  const handleRowKeyDown = useCallback((e) => {
    if (isEditing || e.target !== e.currentTarget) return
    if (e.key === 'Enter') {
      e.preventDefault()
      onSelect(region.id)
    }
  }, [isEditing, onSelect, region.id])

  const swapTitle = `Audio swapped: ${region.swappedAudioPath?.split(/[\\/]/).pop() ?? ''}. Preview plays the original; the swap is audible only on the timeline.`

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      className={`${styles.row} sample-row`}
      data-browser-row=""
      data-selected={isActive ? 'true' : 'false'}
      role="option"
      aria-selected={isActive}
      tabIndex={0}
      style={{ '--row-id': labelColor(region.label) }}
      onClick={() => onSelect(region.id)}
      onKeyDown={handleRowKeyDown}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, region) }}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      data-hint={`${region.label}: ${region.name}. Click to select and preview; drag onto a pattern block.`}
      data-hint-mods="Right-click: menu · Drag: add to timeline"
    >
      {/* Play/Stop button */}
      <button
        type="button"
        className={`${styles.rowButton} sample-row-play`}
        onClick={handleTogglePreview}
        aria-label={isPlaying ? `Stop preview of ${region.name}` : `Preview ${region.name}`}
        aria-pressed={isPlaying}
        data-hint={isPlaying ? 'Stop preview' : 'Preview this sample'}
      >
        {isPlaying ? <Square size={10} aria-hidden="true" /> : <Play size={10} aria-hidden="true" />}
      </button>

      {/* Name or rename input */}
      {isEditing ? (
        <input
          className={styles.rename}
          value={editValue}
          onChange={e => onRenameChange(e.target.value)}
          onKeyDown={handleRenameKeyDown}
          onBlur={onRenameCommit}
          aria-label={`Rename ${region.name}`}
          autoFocus
        />
      ) : (
        <span className={styles.name} title={`${region.name} (${sourceName || '?'})`}>{region.name}</span>
      )}

      {/* Swap indicator */}
      {region.hasSwappedAudio && !isEditing && (
        <span className={styles.rowGlyph} title={swapTitle} aria-label={swapTitle} role="img">
          <ArrowLeftRight size={10} aria-hidden="true" />
        </span>
      )}

      {/* Root note for Pitch */}
      {region.label === 'Pitch' && (
        <span className={styles.note} title="Root note">
          {rootNote != null && rootNote >= 0 ? midiToNoteName(rootNote) : '--'}
        </span>
      )}

      {/* Duration */}
      <span className={styles.duration}>{formatSampleDuration(dur)}</span>
    </div>
  )
}

// ── Helper: resolve CSS variable to a concrete color for inline styles ───────
function getComputedLabelColor(label) {
  const varRef = labelColor(label)
  const map = {
    'var(--theme-label-kick)':   tokenValue('--theme-label-kick'),
    'var(--theme-label-snare)':  tokenValue('--theme-label-snare'),
    'var(--theme-label-hihat)':  tokenValue('--theme-label-hihat'),
    'var(--theme-label-crash)':  tokenValue('--theme-label-crash'),
    'var(--theme-label-pitch)':  tokenValue('--theme-label-pitch'),
    'var(--theme-label-quote)':  tokenValue('--theme-label-quote'),
    'var(--theme-label-custom)': tokenValue('--theme-label-custom'),
  }
  return map[varRef] || tokenValue('--theme-label-custom')
}
