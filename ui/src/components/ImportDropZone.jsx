import { useState, useCallback, useRef } from 'react'
import { Download } from 'lucide-react'

const ALLOWED_EXT = /\.(mp4|avi|mov|mkv|wav|mp3|flac)$/i

/**
 * Wraps content with drag-and-drop file import.
 *
 * Props:
 *   onFilesDropped(paths: string[]) – called with array of file paths
 *   children
 *   disabled
 */
export default function ImportDropZone({ onFilesDropped, children, disabled }) {
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
    // In Electron, File objects have a .path property with full filesystem path
    const paths = files
      .filter(f => ALLOWED_EXT.test(f.name))
      .map(f => f.path || f.name)
      .filter(Boolean)

    if (paths.length > 0) {
      console.log(`[ProjectMedia] Import requested (drop): ${paths.length} file(s)`)
      onFilesDropped(paths)
    } else {
      console.log('[ProjectMedia] Drop ignored — no supported media files')
    }
  }, [disabled, onFilesDropped])

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
