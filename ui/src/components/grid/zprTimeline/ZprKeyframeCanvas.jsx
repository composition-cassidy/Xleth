import { useCallback, useEffect, useRef, useState } from 'react'
import { tokenValue } from '../../../theming/tokenValue.ts'
import { evaluateTrack } from './zprCurveMath.js'

// Canvas keyframe timeline for the ZPR effect card. Modeled on
// pianoRoll/PianoRollCanvas.jsx: a DOM label gutter beside a single canvas
// that owns the ruler, rows, curves, keyframes and playhead — never DOM
// overlays for the per-frame content (that's the piano roll's own documented
// scroll/zoom-drift and hit-test-corruption trap).
//
// tokenValue() is read at draw time (inside the effect), never at module
// scope, where it would resolve empty before ThemeProvider mounts.

const ROW_H = 48
const RULER_H = 22
const DIAMOND_R = 5
const HIT_PX = 9

const CHANNELS = [
  { key: 'panX',       label: 'Pos X',   group: 'position' },
  { key: 'panY',       label: 'Pos Y',   group: 'position' },
  { key: 'zoomLog2',   label: 'Zoom',    group: 'zoom' },
  { key: 'rotationDeg',label: 'Rotation',group: 'rotation' },
]

function resolvePalette() {
  return {
    bg:        tokenValue('--xleth-flat-panel') || '#15151C',
    rowAlt:    tokenValue('--xleth-flat-panel-alt') || 'rgba(255,255,255,0.02)',
    border:    tokenValue('--xleth-flat-border') || '#2A2A38',
    text:      tokenValue('--xleth-flat-text-secondary') || '#9AA0AE',
    textDim:   tokenValue('--xleth-flat-text-subtle') || '#5A5F6B',
    accent:    tokenValue('--theme-accent') || '#33CED6',
    panX:      tokenValue('--theme-warning') || '#E6A23C',
    panY:      tokenValue('--theme-success') || '#3FB27A',
    rotation:  tokenValue('--theme-danger') || '#E6607C',
    playhead:  tokenValue('--theme-accent') || '#33CED6',
    selected:  '#FFFFFF',
  }
}

function channelColor(pal, key) {
  if (key === 'panX') return pal.panX
  if (key === 'panY') return pal.panY
  if (key === 'rotationDeg') return pal.rotation
  return pal.accent
}

// Row's own value range for vertical placement — purely visual (keyframes
// only drag horizontally in time; there is no vertical/value drag on the
// canvas, that's the numeric inspector's job).
function trackValueRange(track) {
  const keys = track?.keys || []
  if (!keys.length) {
    const c = track?.constantValue ?? 0
    return [c - 1, c + 1]
  }
  let lo = Infinity, hi = -Infinity
  for (const k of keys) { if (k.v < lo) lo = k.v; if (k.v > hi) hi = k.v }
  if (lo === hi) { lo -= 1; hi += 1 }
  return [lo, hi]
}

export default function ZprKeyframeCanvas({
  tracks,
  scrubT,
  onScrub,
  selectedKey,
  onSelectKey,
  selectedSegment,
  onSelectSegment,
  onKeyframeAdd,
  onKeyframeMove,
  onKeyframeMoveCommit,
  onKeyframeDelete,
  positionExpanded,
  onTogglePositionExpanded,
  timeLabels, // [{ frac: 0..1, label: string }]
}) {
  const canvasRef = useRef(null)
  const wrapRef = useRef(null)
  const [width, setWidth] = useState(600)
  const dragRef = useRef(null) // { channel, index, moved }

  const visibleRows = positionExpanded
    ? CHANNELS
    : [{ key: 'position', label: 'Position', group: 'position' }, ...CHANNELS.slice(2)]

  const rowsHeight = visibleRows.length * ROW_H
  const totalHeight = RULER_H + rowsHeight + ROW_H // + disabled Opacity row

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r && r.width > 40) setWidth(Math.round(r.width))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const timeToX = useCallback((t) => t * width, [width])
  const xToTime = useCallback((x) => Math.max(0, Math.min(1, x / width)), [width])

  const rowTop = useCallback((rowIndex) => RULER_H + rowIndex * ROW_H, [])

  const valueToY = useCallback((track, rowIndex, v) => {
    const [lo, hi] = trackValueRange(track)
    const top = rowTop(rowIndex) + 6
    const bandH = ROW_H - 12
    const frac = hi > lo ? (v - lo) / (hi - lo) : 0.5
    return top + (1 - frac) * bandH
  }, [rowTop])

  // ── draw ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = totalHeight * dpr
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const pal = resolvePalette()

    ctx.fillStyle = pal.bg
    ctx.fillRect(0, 0, width, totalHeight)

    // ruler
    ctx.fillStyle = pal.rowAlt
    ctx.fillRect(0, 0, width, RULER_H)
    ctx.strokeStyle = pal.border
    ctx.beginPath()
    ctx.moveTo(0, RULER_H); ctx.lineTo(width, RULER_H)
    ctx.stroke()
    ctx.fillStyle = pal.text
    ctx.font = '10px var(--font-mono, monospace)'
    ctx.textBaseline = 'middle'
    for (const tl of (timeLabels || [])) {
      const x = timeToX(tl.frac)
      ctx.strokeStyle = pal.border
      ctx.beginPath(); ctx.moveTo(x, RULER_H - 5); ctx.lineTo(x, RULER_H); ctx.stroke()
      ctx.fillText(tl.label, Math.min(x + 3, width - 60), RULER_H / 2)
    }

    // rows
    visibleRows.forEach((row, rowIndex) => {
      const top = rowTop(rowIndex)
      if (rowIndex % 2 === 1) {
        ctx.fillStyle = pal.rowAlt
        ctx.fillRect(0, top, width, ROW_H)
      }
      ctx.strokeStyle = pal.border
      ctx.beginPath()
      ctx.moveTo(0, top + ROW_H); ctx.lineTo(width, top + ROW_H)
      ctx.stroke()

      const channelsInRow = row.group === 'position' && !positionExpanded
        ? ['panX', 'panY']
        : [row.key]

      for (const chKey of channelsInRow) {
        const track = tracks[chKey]
        const color = channelColor(pal, chKey)
        const keys = track?.keys || []

        if (keys.length === 0) {
          // flat row — constantValue
          const y = rowTop(rowIndex) + ROW_H / 2
          ctx.strokeStyle = color
          ctx.globalAlpha = 0.6
          ctx.lineWidth = 1.5
          ctx.beginPath()
          ctx.moveTo(0, y); ctx.lineTo(width, y)
          ctx.stroke()
          ctx.globalAlpha = 1
          continue
        }

        // interpolated curve
        ctx.strokeStyle = color
        ctx.lineWidth = 1.5
        ctx.beginPath()
        const STEPS = Math.max(24, Math.round(width / 6))
        for (let i = 0; i <= STEPS; i++) {
          const t = i / STEPS
          const v = evaluateTrack(track, t)
          const x = timeToX(t)
          const y = valueToY(track, rowIndex, v)
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
        }
        ctx.stroke()

        // segment highlight
        if (selectedSegment && selectedSegment.channel === chKey) {
          const a = keys[selectedSegment.index]
          const b = keys[selectedSegment.index + 1]
          if (a && b) {
            ctx.fillStyle = color
            ctx.globalAlpha = 0.12
            ctx.fillRect(timeToX(a.t), rowTop(rowIndex), timeToX(b.t) - timeToX(a.t), ROW_H)
            ctx.globalAlpha = 1
          }
        }

        // diamonds
        keys.forEach((k, index) => {
          const x = timeToX(k.t)
          const y = valueToY(track, rowIndex, k.v)
          const isSelected = selectedKey && selectedKey.channel === chKey && selectedKey.index === index
          ctx.save()
          ctx.translate(x, y)
          ctx.rotate(Math.PI / 4)
          ctx.fillStyle = isSelected ? pal.selected : color
          ctx.fillRect(-DIAMOND_R, -DIAMOND_R, DIAMOND_R * 2, DIAMOND_R * 2)
          if (isSelected) {
            ctx.strokeStyle = pal.bg
            ctx.lineWidth = 1
            ctx.strokeRect(-DIAMOND_R, -DIAMOND_R, DIAMOND_R * 2, DIAMOND_R * 2)
          }
          ctx.restore()
        })
      }

      // row label (drawn on canvas too, in case the gutter is narrow)
      ctx.fillStyle = pal.textDim
    })

    // disabled Opacity row
    const opTop = RULER_H + rowsHeight
    ctx.fillStyle = pal.rowAlt
    ctx.globalAlpha = 0.5
    ctx.fillRect(0, opTop, width, ROW_H)
    ctx.globalAlpha = 1
    ctx.strokeStyle = pal.border
    ctx.beginPath()
    ctx.moveTo(0, opTop); ctx.lineTo(width, opTop)
    ctx.stroke()
    ctx.fillStyle = pal.textDim
    ctx.font = '10px var(--font-mono, monospace)'
    ctx.fillText('not yet animatable', 12, opTop + ROW_H / 2)

    // playhead
    if (Number.isFinite(scrubT)) {
      const x = timeToX(scrubT)
      ctx.strokeStyle = pal.playhead
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(x, 0); ctx.lineTo(x, totalHeight)
      ctx.stroke()
      ctx.fillStyle = pal.playhead
      ctx.beginPath()
      ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 8); ctx.closePath()
      ctx.fill()
    }
  }, [tracks, width, totalHeight, rowsHeight, visibleRows, positionExpanded,
      scrubT, selectedKey, selectedSegment, timeLabels, timeToX, valueToY, rowTop])

  // ── hit testing ──────────────────────────────────────────────────────
  const hitTestKeyframe = useCallback((px, py) => {
    for (let rowIndex = 0; rowIndex < visibleRows.length; rowIndex++) {
      const row = visibleRows[rowIndex]
      const top = rowTop(rowIndex)
      if (py < top || py > top + ROW_H) continue
      const channelsInRow = row.group === 'position' && !positionExpanded ? ['panX', 'panY'] : [row.key]
      for (const chKey of channelsInRow) {
        const track = tracks[chKey]
        const keys = track?.keys || []
        for (let index = 0; index < keys.length; index++) {
          const x = timeToX(keys[index].t)
          const y = valueToY(track, rowIndex, keys[index].v)
          if (Math.hypot(px - x, py - y) <= HIT_PX) return { channel: chKey, index, rowIndex }
        }
      }
    }
    return null
  }, [visibleRows, positionExpanded, tracks, timeToX, valueToY, rowTop])

  const hitTestRow = useCallback((py) => {
    for (let rowIndex = 0; rowIndex < visibleRows.length; rowIndex++) {
      const top = rowTop(rowIndex)
      if (py >= top && py <= top + ROW_H) return { row: visibleRows[rowIndex], rowIndex }
    }
    return null
  }, [visibleRows, rowTop])

  const hitTestSegment = useCallback((px, py) => {
    const hit = hitTestRow(py)
    if (!hit) return null
    const channelsInRow = hit.row.group === 'position' && !positionExpanded ? ['panX', 'panY'] : [hit.row.key]
    const t = xToTime(px)
    for (const chKey of channelsInRow) {
      const keys = tracks[chKey]?.keys || []
      for (let i = 0; i < keys.length - 1; i++) {
        if (t >= keys[i].t && t <= keys[i + 1].t) return { channel: chKey, index: i }
      }
    }
    return null
  }, [hitTestRow, positionExpanded, tracks, xToTime])

  const handlePointerDown = useCallback((e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top

    if (py <= RULER_H) {
      onScrub?.(xToTime(px))
      dragRef.current = { channel: null, index: -1, moved: true, scrub: true }
      try { e.currentTarget.setPointerCapture(e.pointerId) } catch (_) {}
      return
    }

    const kf = hitTestKeyframe(px, py)
    if (kf) {
      onSelectKey?.({ channel: kf.channel, index: kf.index })
      onSelectSegment?.(null)
      dragRef.current = { channel: kf.channel, index: kf.index, moved: false, scrub: false }
      try { e.currentTarget.setPointerCapture(e.pointerId) } catch (_) {}
      return
    }

    const seg = hitTestSegment(px, py)
    if (seg) {
      onSelectSegment?.(seg)
      onSelectKey?.(null)
      return
    }

    onSelectKey?.(null)
    onSelectSegment?.(null)
  }, [hitTestKeyframe, hitTestSegment, onScrub, onSelectKey, onSelectSegment, xToTime])

  const handlePointerMove = useCallback((e) => {
    const d = dragRef.current
    if (!d) return
    const rect = canvasRef.current.getBoundingClientRect()
    const px = e.clientX - rect.left
    if (d.scrub) {
      onScrub?.(xToTime(px))
      return
    }
    if (!d.channel) return
    d.moved = true
    onKeyframeMove?.(d.channel, d.index, xToTime(px))
  }, [xToTime, onScrub, onKeyframeMove])

  const handlePointerUp = useCallback((e) => {
    const d = dragRef.current
    dragRef.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch (_) {}
    if (!d || d.scrub || !d.channel || !d.moved) return
    const rect = canvasRef.current.getBoundingClientRect()
    const px = e.clientX - rect.left
    onKeyframeMoveCommit?.(d.channel, d.index, xToTime(px))
  }, [xToTime, onKeyframeMoveCommit])

  const handleDoubleClick = useCallback((e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    if (py <= RULER_H) return
    if (hitTestKeyframe(px, py)) return
    const hit = hitTestRow(py)
    if (!hit || hit.row.key === 'opacity') return
    const channelsInRow = hit.row.group === 'position' && !positionExpanded ? ['panX'] : [hit.row.key]
    const t = xToTime(px)
    for (const chKey of channelsInRow) onKeyframeAdd?.(chKey, t)
  }, [hitTestKeyframe, hitTestRow, positionExpanded, xToTime, onKeyframeAdd])

  const handleKeyDown = useCallback((e) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return
    if (!selectedKey) return
    e.preventDefault()
    onKeyframeDelete?.(selectedKey.channel, selectedKey.index)
    onSelectKey?.(null)
  }, [selectedKey, onKeyframeDelete, onSelectKey])

  return (
    <div className="zpr-timeline-body">
      <div className="zpr-timeline-gutter">
        <div className="zpr-timeline-gutter-ruler" />
        {visibleRows.map((row) => (
          <div key={row.key} className="zpr-timeline-gutter-row" style={{ height: ROW_H }}>
            {row.key === 'position' ? (
              <button
                type="button"
                className="zpr-timeline-expand-btn"
                onClick={onTogglePositionExpanded}
                title="Expand X/Y"
              >
                {positionExpanded ? '▾' : '▸'} {row.label}
              </button>
            ) : (
              <span>{row.label}</span>
            )}
          </div>
        ))}
        <div className="zpr-timeline-gutter-row zpr-timeline-gutter-row--disabled" style={{ height: ROW_H }}>
          <span>Opacity</span>
        </div>
      </div>
      <div ref={wrapRef} className="zpr-timeline-canvas-wrap">
        <canvas
          ref={canvasRef}
          className="zpr-timeline-canvas"
          style={{ width, height: totalHeight }}
          tabIndex={0}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onDoubleClick={handleDoubleClick}
          onKeyDown={handleKeyDown}
        />
      </div>
    </div>
  )
}
