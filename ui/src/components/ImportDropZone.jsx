import { useState, useCallback, useRef } from 'react'
import styles from './browser/Browser.module.css'

const ALLOWED_EXT = /\.(mp4|avi|mov|mkv|wav|mp3|flac|mid|midi|flp)$/i
// MIDI files and FL Studio projects both open the MIDI import dialog.
const MIDI_EXT = /\.(mid|midi|flp)$/i

/**
 * Wraps content with drag-and-drop file import. The whole wrapped region is the
 * drop target; while a file is over it the region is outlined and says so.
 *
 * Props:
 *   onFilesDropped(paths: string[]) – called with array of A/V file paths
 *   onMidiFileDropped(path: string) – optional; called with the first .mid/.midi path
 *   children
 *   disabled
 */
export default function ImportDropZone({ onFilesDropped, onMidiFileDropped, children, disabled }) {
  const [dragging, setDragging] = useState(false)
  const dragCounter = useRef(0)

  const onDragEnter = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    // Only files from outside the app are imports; a sample or source being
    // dragged around inside the Browser is not.
    if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return
    dragCounter.current++
    if (!disabled) setDragging(true)
  }, [disabled])

  const onDragLeave = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return
    dragCounter.current--
    if (dragCounter.current <= 0) {
      dragCounter.current = 0
      setDragging(false)
    }
  }, [])

  const onDragOver = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const onDrop = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current = 0
    setDragging(false)

    if (disabled) return

    const files = Array.from(e.dataTransfer.files)

    // Electron 41+ removed File.path; use webUtils via the preload bridge.
    const getPath = (f) => window.xleth?.getDroppedFilePath?.(f) || f.path || f.name

    // Route the first .mid/.midi/.flp to the MIDI import dialog
    const midiFile = files.find(f => MIDI_EXT.test(f.name))
    if (midiFile && onMidiFileDropped) {
      const path = getPath(midiFile)
      onMidiFileDropped(path)
    }

    // Route A/V files to the existing source-import flow
    const avPaths = files
      .filter(f => ALLOWED_EXT.test(f.name) && !MIDI_EXT.test(f.name))
      .map(getPath)
      .filter(Boolean)

    if (avPaths.length > 0) {
      onFilesDropped(avPaths)
    } else if (!midiFile) {
    }
  }, [disabled, onFilesDropped, onMidiFileDropped])

  return (
    <div
      className={styles.dropZone}
      data-dragging={dragging ? 'true' : 'false'}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {children}
      {dragging && (
        <div className={styles.dropOverlay} role="status">
          Drop files to import
        </div>
      )}
    </div>
  )
}
