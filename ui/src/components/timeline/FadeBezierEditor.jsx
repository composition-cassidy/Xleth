import { useRef, useEffect, useCallback, useState } from 'react'
import { tokenValue } from '../../theming/tokenValue.ts'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'

/**
 * Cubic bezier fade curve editor.
 * CSS convention: P0=(0,0), P1=(x1,y1), P2=(x2,y2), P3=(1,1).
 * Drag P1 and P2 control points to shape the fade curve.
 *
 * Props:
 *   x1, y1, x2, y2  – current bezier control points (0..1)
 *   onChange          – (x1, y1, x2, y2) called on commit (mouseup)
 *   onLiveChange     – (x1, y1, x2, y2) called during drag (optional)
 *   type              – 'fadeIn' | 'fadeOut' (visual direction)
 *   width, height     – canvas size (default 120×120)
 */

const PRESETS = [
  { label: 'Linear',   x1: 0,    y1: 0,    x2: 1,    y2: 1    },
  { label: 'Ease In',  x1: 0.42, y1: 0,    x2: 1,    y2: 1    },
  { label: 'Ease Out', x1: 0,    y1: 0,    x2: 0.58, y2: 1    },
  { label: 'S-Curve',  x1: 0.42, y1: 0,    x2: 0.58, y2: 1    },
  { label: 'Exp',      x1: 0.9,  y1: 0,    x2: 1,    y2: 0.1  },
]

const HANDLE_R = 5
const PAD = 12

export default function FadeBezierEditor({
  x1 = 0, y1 = 0, x2 = 1, y2 = 1,
  onChange, onLiveChange,
  type = 'fadeIn',
  width = 120, height = 120,
}) {
  const canvasRef = useRef(null)
  const [p1, setP1] = useState({ x: x1, y: y1 })
  const [p2, setP2] = useState({ x: x2, y: y2 })
  const dragging = useRef(null)
  const themeEpoch = useThemeEpoch()

  // Sync props -> state when they change externally
  useEffect(() => { setP1({ x: x1, y: y1 }) }, [x1, y1])
  useEffect(() => { setP2({ x: x2, y: y2 }) }, [x2, y2])

  // Canvas coordinate helpers
  const toCanvas = useCallback((nx, ny) => ({
    cx: PAD + nx * (width - 2 * PAD),
    cy: PAD + (1 - ny) * (height - 2 * PAD),
  }), [width, height])

  const fromCanvas = useCallback((cx, cy) => ({
    nx: Math.max(0, Math.min(1, (cx - PAD) / (width - 2 * PAD))),
    ny: Math.max(0, Math.min(1, 1 - (cy - PAD) / (height - 2 * PAD))),
  }), [width, height])

  // Draw the curve
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = height * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    const p0 = toCanvas(0, 0)
    const p3 = toCanvas(1, 1)
    const cp1 = toCanvas(p1.x, p1.y)
    const cp2 = toCanvas(p2.x, p2.y)

    // Background
    ctx.fillStyle = '#1a1a1a'
    ctx.fillRect(0, 0, width, height)

    // Diagonal reference (linear)
    ctx.beginPath()
    ctx.moveTo(p0.cx, p0.cy)
    ctx.lineTo(p3.cx, p3.cy)
    ctx.strokeStyle = tokenValue('--theme-fx-surface-tint-medium')
    ctx.lineWidth = 1
    ctx.stroke()

    // Bezier curve
    ctx.beginPath()
    ctx.moveTo(p0.cx, p0.cy)
    ctx.bezierCurveTo(cp1.cx, cp1.cy, cp2.cx, cp2.cy, p3.cx, p3.cy)
    ctx.strokeStyle = tokenValue('--theme-border-focus')
    ctx.lineWidth = 2
    ctx.stroke()

    // Fill area under curve (gain region)
    ctx.beginPath()
    ctx.moveTo(p0.cx, p0.cy)
    ctx.bezierCurveTo(cp1.cx, cp1.cy, cp2.cx, cp2.cy, p3.cx, p3.cy)
    ctx.lineTo(p3.cx, p0.cy)
    ctx.closePath()
    ctx.fillStyle = 'rgba(51, 206, 214, 0.12)'
    ctx.fill()

    // Guide lines
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(p0.cx, p0.cy)
    ctx.lineTo(cp1.cx, cp1.cy)
    ctx.strokeStyle = tokenValue('--theme-timeline-bezier-handle-cp1')
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(p3.cx, p3.cy)
    ctx.lineTo(cp2.cx, cp2.cy)
    ctx.strokeStyle = tokenValue('--theme-timeline-bezier-handle-cp2')
    ctx.stroke()
    ctx.setLineDash([])

    // Control point handles
    const drawHandle = (cx, cy, color) => {
      ctx.beginPath()
      ctx.arc(cx, cy, HANDLE_R, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
      ctx.strokeStyle = tokenValue('--theme-fg-inverse')
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
    drawHandle(cp1.cx, cp1.cy, tokenValue('--theme-timeline-bezier-handle-cp1'))
    drawHandle(cp2.cx, cp2.cy, tokenValue('--theme-timeline-bezier-handle-cp2'))
  }, [p1, p2, width, height, toCanvas, themeEpoch])

  // Hit test
  const hitTest = useCallback((cx, cy) => {
    const cp1 = toCanvas(p1.x, p1.y)
    const cp2 = toCanvas(p2.x, p2.y)
    const d1 = Math.hypot(cx - cp1.cx, cy - cp1.cy)
    const d2 = Math.hypot(cx - cp2.cx, cy - cp2.cy)
    if (d1 <= HANDLE_R + 4 && d1 <= d2) return 'p1'
    if (d2 <= HANDLE_R + 4) return 'p2'
    return null
  }, [p1, p2, toCanvas])

  const handleMouseDown = useCallback((e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const hit = hitTest(cx, cy)
    if (hit) {
      dragging.current = hit
      e.preventDefault()
    }
  }, [hitTest])

  useEffect(() => {
    const handleMove = (e) => {
      if (!dragging.current) return
      const rect = canvasRef.current.getBoundingClientRect()
      const { nx, ny } = fromCanvas(e.clientX - rect.left, e.clientY - rect.top)
      if (dragging.current === 'p1') {
        setP1({ x: nx, y: ny })
        onLiveChange?.(nx, ny, p2.x, p2.y)
      } else {
        setP2({ x: nx, y: ny })
        onLiveChange?.(p1.x, p1.y, nx, ny)
      }
    }

    const handleUp = () => {
      if (dragging.current) {
        dragging.current = null
        onChange?.(p1.x, p1.y, p2.x, p2.y)
      }
    }

    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [p1, p2, fromCanvas, onChange, onLiveChange])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <canvas
        ref={canvasRef}
        style={{ width, height, cursor: 'crosshair', borderRadius: 4 }}
        onMouseDown={handleMouseDown}
      />
      <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        {PRESETS.map(pr => (
          <button
            key={pr.label}
            onClick={() => {
              setP1({ x: pr.x1, y: pr.y1 })
              setP2({ x: pr.x2, y: pr.y2 })
              onChange?.(pr.x1, pr.y1, pr.x2, pr.y2)
            }}
            style={{
              fontSize: 9, padding: '1px 4px', background: '#333', color: '#ccc',
              border: '1px solid #555', borderRadius: 3, cursor: 'pointer',
            }}
          >
            {pr.label}
          </button>
        ))}
      </div>
    </div>
  )
}
