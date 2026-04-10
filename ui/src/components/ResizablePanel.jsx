import { useState, useRef, useCallback, useEffect } from 'react'

const STORAGE_KEY = 'xleth-panel-width'
const DEFAULT_WIDTH = 300
const MIN_WIDTH = 250
const MAX_WIDTH = 400

export default function ResizablePanel({ left, children }) {
  const [width, setWidth] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const w = parseInt(saved, 10)
        if (w >= MIN_WIDTH && w <= MAX_WIDTH) return w
      }
    } catch {}
    return DEFAULT_WIDTH
  })

  const dragging = useRef(false)
  const startX = useRef(0)
  const startW = useRef(0)

  // Persist to localStorage on change
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, String(width)) } catch {}
  }, [width])

  const onMouseDown = useCallback((e) => {
    e.preventDefault()
    dragging.current = true
    startX.current = e.clientX
    startW.current = width
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    console.log(`[UI] Panel resize started (${width}px)`)
  }, [width])

  useEffect(() => {
    const onMouseMove = (e) => {
      if (!dragging.current) return
      const delta = e.clientX - startX.current
      const newW = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startW.current + delta))
      setWidth(newW)
    }

    const onMouseUp = () => {
      if (!dragging.current) return
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      console.log(`[UI] Panel resize ended (${width}px)`)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [width])

  return (
    <div className="resizable-layout">
      <div className="resizable-left" style={{ width }}>
        {left}
      </div>
      <div
        className="resizable-divider"
        onMouseDown={onMouseDown}
        title="Drag to resize"
      />
      <div className="resizable-right">
        {children}
      </div>
    </div>
  )
}
