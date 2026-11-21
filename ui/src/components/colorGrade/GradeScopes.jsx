import { useCallback, useEffect, useRef, useState } from 'react'
import { SegmentedControl } from '../../ui-kit'
import { backingSize, getDpr, useDprEpoch } from '../../ui-kit/dpr'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import { uiCanvasFont } from '../../styles/typography.js'
import {
  frameHistogram, frameVectorscope, frameWaveform, hasPreviewFrameReader, readPreviewFrame,
  subscribePreviewFrameReader, vectorscopeTarget,
} from '../../colorGrade/frameFeed.js'
import styles from './colorGrade.module.css'

// Scopes: the instruments for judging a grade instead of eyeballing it. All
// three read the finished preview frame (every grade applied), a few times a
// second, so they show what the picture on screen actually contains.
//
//   Histogram    how much of the picture sits at each brightness, per colour
//   Waveform     brightness (bottom = black, top = white) across the picture's width
//   Vectorscope  colour: the centre is grey, distance is saturation, direction is hue
//
// With no Preview open there is no frame to read; the scope says so and draws
// nothing, never a placeholder trace.

const REFRESH_MS = 120

const VIEWS = [
  { value: 'histogram', label: 'Histogram', hint: 'How much of the picture sits at each brightness, for red, green and blue.' },
  { value: 'waveform', label: 'Waveform', hint: 'Brightness across the picture, left to right. Bottom is black, top is white.' },
  { value: 'vectorscope', label: 'Vectorscope', hint: 'Colour. The centre is grey; further out is more saturated; the direction is the hue.' },
]

const RGB = { r: '#E0605A', g: '#5FB36A', b: '#5C9DF0' }

function readColours(el) {
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null
  const get = (name, fb) => cs?.getPropertyValue(name)?.trim() || fb
  return {
    ground: get('--ui-g0', '#141414'),
    grid: get('--ui-g4', '#3A3A3A'),
    boundary: get('--ui-boundary', '#747474'),
    ink: get('--ui-ink', '#E6E6E6'),
    ink3: get('--ui-ink-3', '#929292'),
  }
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [230, 230, 230]
}

function drawHistogram(ctx, w, h, c, frame) {
  const hist = frameHistogram(frame)
  let peak = 0
  for (const key of ['r', 'g', 'b']) for (let i = 1; i < 255; i++) if (hist[key][i] > peak) peak = hist[key][i]
  // Quarter lines.
  ctx.strokeStyle = c.grid
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let i = 1; i < 4; i++) {
    const x = Math.round((w * i) / 4) + 0.5
    ctx.moveTo(x, 0); ctx.lineTo(x, h)
  }
  ctx.stroke()
  if (peak === 0) return
  ctx.globalCompositeOperation = 'lighter'
  for (const key of ['r', 'g', 'b']) {
    ctx.beginPath()
    ctx.moveTo(0, h)
    for (let i = 0; i < 256; i++) {
      const v = Math.min(1, Math.sqrt(hist[key][i] / peak))
      ctx.lineTo((i / 255) * w, h - v * (h - 4))
    }
    ctx.lineTo(w, h)
    ctx.closePath()
    ctx.globalAlpha = 0.55
    ctx.fillStyle = RGB[key]
    ctx.fill()
  }
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
}

function drawWaveform(ctx, w, h, c, frame, dpr) {
  const cols = Math.min(256, Math.max(64, Math.round(w / 2)))
  const { grid, peak } = frameWaveform(frame, cols)
  // Painted through an offscreen image at one texel per (column, level), then
  // scaled up: far cheaper than a rect per cell.
  const img = new ImageData(cols, 256)
  const [ir, ig, ib] = hexToRgb(c.ink)
  const gain = peak > 0 ? 1 / Math.log(1 + peak) : 0
  for (let col = 0; col < cols; col++) {
    for (let lv = 0; lv < 256; lv++) {
      const v = grid[col * 256 + lv]
      if (!v) continue
      const o = ((255 - lv) * cols + col) * 4
      img.data[o] = ir
      img.data[o + 1] = ig
      img.data[o + 2] = ib
      img.data[o + 3] = Math.min(255, Math.round(60 + 195 * Math.log(1 + v) * gain))
    }
  }
  const off = document.createElement('canvas')
  off.width = cols
  off.height = 256
  off.getContext('2d')?.putImageData(img, 0, 0)
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(off, 0, 0, cols, 256, 0, 0, w, h)

  // 0 / 25 / 50 / 75 / 100 % lines, labelled.
  ctx.strokeStyle = c.grid
  ctx.lineWidth = 1
  ctx.font = uiCanvasFont('10px')
  ctx.fillStyle = c.ink3
  ctx.textAlign = 'left'
  ctx.textBaseline = 'bottom'
  for (let i = 0; i <= 4; i++) {
    const y = Math.min(h - 0.5, Math.round(h - (h * i) / 4) + 0.5)
    ctx.beginPath()
    ctx.moveTo(0, y); ctx.lineTo(w, y)
    ctx.stroke()
    if (i > 0 && i < 4) ctx.fillText(`${i * 25}`, 3, y - 1)
  }
  void dpr
}

function drawVectorscope(ctx, w, h, c, frame) {
  const size = Math.min(w, h)
  const cx = w / 2
  const cy = h / 2
  const radius = size / 2 - 6
  const res = 128
  const { grid, peak } = frameVectorscope(frame, res)
  const img = new ImageData(res, res)
  const [ir, ig, ib] = hexToRgb(c.ink)
  const gain = peak > 0 ? 1 / Math.log(1 + peak) : 0
  for (let i = 0; i < res * res; i++) {
    const v = grid[i]
    if (!v) continue
    img.data[i * 4] = ir
    img.data[i * 4 + 1] = ig
    img.data[i * 4 + 2] = ib
    img.data[i * 4 + 3] = Math.min(255, Math.round(70 + 185 * Math.log(1 + v) * gain))
  }
  const off = document.createElement('canvas')
  off.width = res
  off.height = res
  off.getContext('2d')?.putImageData(img, 0, 0)

  // Graticule: outer ring (full range of the plot), half ring, crosshair.
  ctx.strokeStyle = c.grid
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.moveTo(cx + radius / 2, cy)
  ctx.arc(cx, cy, radius / 2, 0, Math.PI * 2)
  ctx.moveTo(cx - radius, Math.round(cy) + 0.5); ctx.lineTo(cx + radius, Math.round(cy) + 0.5)
  ctx.moveTo(Math.round(cx) + 0.5, cy - radius); ctx.lineTo(Math.round(cx) + 0.5, cy + radius)
  ctx.stroke()

  // The picture's chroma. The grid spans +/-0.5 in Cb and Cr; the plot's
  // radius is that same 0.5.
  ctx.drawImage(off, 0, 0, res, res, cx - radius, cy - radius, radius * 2, radius * 2)

  // Where the six pure colours sit, as labelled boxes.
  const targets = [
    ['R', 1, 0, 0], ['Yl', 1, 1, 0], ['G', 0, 1, 0], ['Cy', 0, 1, 1], ['B', 0, 0, 1], ['Mg', 1, 0, 1],
  ]
  ctx.font = uiCanvasFont('10px')
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const [label, r, g, b] of targets) {
    const t = vectorscopeTarget(r, g, b)
    const x = cx + t.x * radius
    const y = cy - t.y * radius
    ctx.strokeStyle = c.boundary
    ctx.strokeRect(Math.round(x) - 3.5, Math.round(y) - 3.5, 7, 7)
    ctx.fillStyle = c.ink3
    // Labels sit just INSIDE their box, towards the centre: the pure colours
    // lie on the plot's edge, so a label outside it would be cut off.
    const inward = 1 - 13 / Math.max(14, Math.hypot(x - cx, y - cy))
    ctx.fillText(label, cx + (x - cx) * inward, cy + (y - cy) * inward)
  }
}

export default function GradeScopes() {
  const [view, setView] = useState('histogram')
  const [hasFrame, setHasFrame] = useState(() => hasPreviewFrameReader())
  const canvasRef = useRef(null)
  const themeEpoch = useThemeEpoch()
  const dprEpoch = useDprEpoch()
  const viewRef = useRef(view)
  viewRef.current = view

  const paint = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const cssW = canvas.clientWidth
    const cssH = canvas.clientHeight
    if (cssW < 40 || cssH < 40) return
    const dpr = getDpr()
    const tw = backingSize(cssW, dpr)
    const th = backingSize(cssH, dpr)
    if (canvas.width !== tw || canvas.height !== th) { canvas.width = tw; canvas.height = th }
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const c = readColours(canvas)
    ctx.fillStyle = c.ground
    ctx.fillRect(0, 0, cssW, cssH)
    const frame = readPreviewFrame()
    setHasFrame(frame !== null)
    if (!frame) return
    if (viewRef.current === 'waveform') drawWaveform(ctx, cssW, cssH, c, frame, dpr)
    else if (viewRef.current === 'vectorscope') drawVectorscope(ctx, cssW, cssH, c, frame)
    else drawHistogram(ctx, cssW, cssH, c, frame)
  }, [])

  // A live signal: redraw on a timer while it is on screen, and at once when
  // the view, the theme or the display scale changes.
  useEffect(() => {
    paint()
    const id = setInterval(paint, REFRESH_MS)
    const off = subscribePreviewFrameReader(() => paint())
    return () => { clearInterval(id); off() }
  }, [paint])
  useEffect(() => { paint() }, [paint, view, themeEpoch, dprEpoch])

  return (
    <>
      <div className={styles.row}>
        <span className={styles.rowLabel}>Scope</span>
        <div className={styles.rowControl}>
          <SegmentedControl size="sm" label="Which scope" options={VIEWS} value={view} onChange={setView} />
        </div>
      </div>
      <div className={styles.well}>
        <canvas
          ref={canvasRef}
          className={styles.scopeCanvas}
          data-shape={view === 'vectorscope' ? 'square' : undefined}
          data-mo-live
          role="img"
          aria-label={`${VIEWS.find((v) => v.value === view)?.label} of the preview picture`}
          data-testid="xleth-grade-scope"
        />
      </div>
      <p className={styles.caption}>
        {hasFrame
          ? 'Reads the preview picture, with every grade applied.'
          : 'Open the Preview to see the scopes. They read the picture it shows.'}
      </p>
    </>
  )
}
