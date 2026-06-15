import { useState, useRef, useCallback } from 'react'
import { Play, Square, ArrowLeftRight } from 'lucide-react'
import { labelColor, buildAudioUrl, formatDuration, midiToNoteName } from '../constants/labels.js'
import { tokenValue } from '../theming/tokenValue.ts'

// ── Singleton audio element for preview (only one preview plays at a time) ───
let previewAudio = null
let previewStopTimer = null
let activeRowId = null  // id of the row currently previewing

function stopPreview() {
  if (previewAudio) {
    previewAudio.pause()
    previewAudio.src = ''
  }
  if (previewStopTimer) {
    clearTimeout(previewStopTimer)
    previewStopTimer = null
  }
  activeRowId = null
}

/**
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
  const [isPlaying, setIsPlaying] = useState(false)
  const playingRef = useRef(false)

  const dur = Math.abs(region.endTime - region.startTime)

  // ── Preview playback ───────────────────────────────────────────────────────
  const handleTogglePreview = useCallback((e) => {
    e.stopPropagation()  // don't trigger row select

    // If this row is already playing, stop it
    if (activeRowId === region.id) {
      stopPreview()
      setIsPlaying(false)
      playingRef.current = false
      console.log(`[SampleSelector] Preview stopped: "${region.name}"`)
      return
    }

    // Stop any other preview
    stopPreview()

    if (!sourceFilePath) return

    previewAudio = new Audio(buildAudioUrl(sourceFilePath))
    previewAudio.currentTime = region.startTime
    activeRowId = region.id

    // Schedule stop at endTime with a single timer (no polling)
    const durationMs = Math.max(0, (region.endTime - region.startTime) * 1000)
    previewStopTimer = setTimeout(() => {
      stopPreview()
      setIsPlaying(false)
      playingRef.current = false
    }, durationMs)

    previewAudio.addEventListener('ended', () => {
      stopPreview()
      setIsPlaying(false)
      playingRef.current = false
    })

    previewAudio.play().catch(err => {
      console.error('[SampleSelector] Preview error:', err)
      stopPreview()
      setIsPlaying(false)
      playingRef.current = false
    })

    setIsPlaying(true)
    playingRef.current = true
    console.log(`[SampleSelector] Preview: "${region.name}" ${region.startTime.toFixed(2)}–${region.endTime.toFixed(2)}s`)
  }, [region, sourceFilePath])

  // ── Drag ───────────────────────────────────────────────────────────────────
  const handleDragStart = useCallback((e) => {
    const payload = {
      regionId:  region.id,
      sourceId:  region.sourceId,
      label:     region.label,
      name:      region.name,
      startTime: region.startTime,
      endTime:   region.endTime,
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

    console.log(`[SampleSelector] Drag started: "${region.name}"`)
  }, [region])

  const handleDragEnd = useCallback(() => {
    window.__xlethDragSample = null
    console.log(`[SampleSelector] Drag ended: "${region.name}"`)
  }, [region])

  // ── Rename key handling ────────────────────────────────────────────────────
  const handleRenameKeyDown = useCallback((e) => {
    e.stopPropagation()  // prevent SamplePicker/TransportBar shortcuts
    if (e.key === 'Enter') onRenameCommit()
    if (e.key === 'Escape') onRenameCancel()
  }, [onRenameCommit, onRenameCancel])

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      className={`sample-row ${isActive ? 'active' : ''}`}
      style={isActive ? { boxShadow: `inset 2px 0 0 ${getComputedLabelColor(region.label)}` } : undefined}
      onClick={() => onSelect(region.id)}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, region) }}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      {/* Play/Stop button */}
      <button
        className="sample-row-play"
        onClick={handleTogglePreview}
        title="Preview"
      >
        {isPlaying ? <Square size={10} /> : <Play size={10} />}
      </button>

      {/* Name or rename input */}
      {isEditing ? (
        <input
          className="sample-row-name-input"
          value={editValue}
          onChange={e => onRenameChange(e.target.value)}
          onKeyDown={handleRenameKeyDown}
          onBlur={onRenameCommit}
          autoFocus
        />
      ) : (
        <span className="sample-row-name" title={region.name}>{region.name}</span>
      )}

      {/* Swap indicator */}
      {region.hasSwappedAudio && !isEditing && (
        <span
          className="sample-row-swap-icon"
          title={`Audio swapped: ${region.swappedAudioPath?.split(/[\\/]/).pop() ?? ''} — preview plays original, swap is audible only on timeline`}
        >
          <ArrowLeftRight size={10} />
        </span>
      )}

      {/* Duration */}
      <span className="sample-row-duration">{formatDuration(dur)}</span>

      {/* Source name */}
      <span className="sample-row-source" title={sourceName}>{sourceName || '?'}</span>

      {/* Root note for Pitch / syllable placeholder for Quote */}
      {region.label === 'Pitch' && (
        <span className="sample-row-note">
          {rootNote != null && rootNote >= 0 ? midiToNoteName(rootNote) : '--'}
        </span>
      )}
      {region.label === 'Quote' && (
        <span className="sample-row-note sample-row-note-quote">--</span>
      )}
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
