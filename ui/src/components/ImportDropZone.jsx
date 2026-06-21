import { useState, useCallback, useRef } from 'react'
import { Download } from 'lucide-react'

const ALLOWED_EXT = /\.(mp4|avi|mov|mkv|wav|mp3|flac|mid|midi)$/i
const MIDI_EXT = /\.(mid|midi)$/i

/**
 * Wraps content with drag-and-drop file import.
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
    dragCounter.current++
    if (!disabled) setDragging(true)
  }, [disabled])

  const onDragLeave = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
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

    // Route first .mid/.midi to the MIDI import dialog
    const midiFile = files.find(f => MIDI_EXT.test(f.name))
    if (midiFile && onMidiFileDropped) {
      const path = getPath(midiFile)
      console.log('[ProjectMedia] MIDI import requested (drop):', path)
      onMidiFileDropped(path)
    }

    // Route A/V files to the existing source-import flow
    const avPaths = files
      .filter(f => ALLOWED_EXT.test(f.name) && !MIDI_EXT.test(f.name))
      .map(getPath)
      .filter(Boolean)

    if (avPaths.length > 0) {
      console.log(`[ProjectMedia] Import requested (drop): ${avPaths.length} file(s)`)
      onFilesDropped(avPaths)
    } else if (!midiFile) {
      console.log('[ProjectMedia] Drop ignored — no supported media files')
    }
  }, [disabled, onFilesDropped, onMidiFileDropped])

  return (
    <div
      className={`import-dropzone ${dragging ? 'dragging' : ''}`}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {children}
      {dragging && (
        <div className="import-dropzone-overlay">
          <Download size={32} />
          <span>Drop files to import</span>
        </div>
      )}
    </div>
  )
}
