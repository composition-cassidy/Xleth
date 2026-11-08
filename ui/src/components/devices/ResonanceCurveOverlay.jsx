// Dynamic Focus Curve editor for the Resonance Suppressor device.
//
// The canvas painter owns spectrum, reduction, and weighting visuals. This
// component only owns interaction on top of it: the HP / LP boundary handles and
// the active focus-band handles (an SVG of at most ten handles, never one node
// per bin). Moved from plugin-ui's runtime when the Resonance Suppressor became a
// device: the handles, drag maths and keys are unchanged; it takes params and a
// writer as props, its band selection can be owned by the device (whose Focus
// section edits the selected band), and its keys act only while focus is inside
// the overlay instead of on the whole window.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import styles from './ResonanceCurveOverlay.module.css'
import {
  BAND_HANDLES,
  BAND_TYPE,
  BAND_TYPE_OPTIONS,
  BAND_Q_MIN, BAND_Q_MAX,
  BELL_FREQ_MIN_HZ, BELL_FREQ_MAX_HZ,
  BELL_GAIN_MIN_DB, BELL_GAIN_MAX_DB,
  HP_MIN_HZ, HP_MAX_HZ,
  LP_MIN_HZ, LP_MAX_HZ,
  NUM_BANDS,
  bandParamIds,
  clamp,
  clampBandQ,
  clampBandType,
  clampBellFreq, clampBellGain,
  clampHp, clampLp,
  computeDragParamUpdates,
  findFirstInactiveBandIndex,
  freqToX, gainToY,
} from '../../plugin-ui/runtime/visualizers/resonanceCurveMapping.js'

const FALLBACK_GRAPH_W = 640
const FALLBACK_GRAPH_H = 260
const HANDLE_RADIUS_PX = 9
const BOUNDARY_HANDLE_W_PX = 14
const BOUNDARY_HANDLE_H_PX = 14
const BOUNDARY_HANDLE_DROP_PX = 6
const Q_WHEEL_FACTOR = 0.001
const Q_KEY_FACTOR = 1.06
const Q_KEY_FACTOR_FINE = 1.015

const FREQ_LOG_SPAN = Math.log(BELL_FREQ_MAX_HZ / BELL_FREQ_MIN_HZ)

function paramOr(params, id, fallback) {
  const v = params?.[id]
  return Number.isFinite(v) ? v : fallback
}

export function formatEditorFreq(hz) {
  const safe = clampBellFreq(Number(hz))
  return safe >= 1000 ? `${(safe / 1000).toFixed(2)} kHz` : `${safe.toFixed(0)} Hz`
}

export function formatEditorGain(db) {
  const safe = clampBellGain(Number(db))
  return `${safe >= 0 ? '+' : ''}${safe.toFixed(1)} dB`
}

export function freqToEditorValue(hz) {
  const safe = clampBellFreq(Number(hz))
  return clamp(Math.log(safe / BELL_FREQ_MIN_HZ) / FREQ_LOG_SPAN, 0, 1)
}

export function editorValueToFreq(value) {
  const norm = clamp(Number(value), 0, 1)
  return clampBellFreq(BELL_FREQ_MIN_HZ * Math.exp(norm * FREQ_LOG_SPAN))
}

export function clampEditorGainForType(type, value) {
  const upper = clampBandType(type) === BAND_TYPE.BAND_REJECT ? 0 : BELL_GAIN_MAX_DB
  return clamp(Number(value), BELL_GAIN_MIN_DB, upper)
}

export function isBandWidthEditable(type) {
  return clampBandType(type) !== BAND_TYPE.TILT
}

export function buildActiveBandModels(params) {
  const out = []
  for (const h of BAND_HANDLES) {
    const isActive = Number(params?.[h.activeId] ?? 0) >= 0.5
    if (!isActive) continue
    out.push({
      idx: h.idx,
      type: clampBandType(params?.[h.typeId] ?? 0),
      freq: clampBellFreq(paramOr(params, h.freqId, 1000)),
      gain: clampBellGain(paramOr(params, h.gainId, 0)),
      q: clampBandQ(paramOr(params, h.qId, 1)),
      ids: h,
    })
  }
  return out
}

export function buildBandEditorModel(params, selectedBandIdx) {
  const activeBands = buildActiveBandModels(params)
  const selectedBand = selectedBandIdx != null
    ? activeBands.find(b => b.idx === selectedBandIdx) || null
    : null
  const firstInactive = findFirstInactiveBandIndex(params)
  return {
    activeBands,
    activeCount: activeBands.length,
    firstInactive,
    canAddBand: firstInactive != null,
    selectedBand,
    selectedBandIdx: selectedBand?.idx ?? null,
  }
}

export function createAddBandAction(params) {
  const idx = findFirstInactiveBandIndex(params)
  if (idx == null) return null
  const ids = bandParamIds(idx)
  return { idx, updates: { [ids.activeId]: 1 } }
}

export function createRemoveBandAction(params, selectedBandIdx) {
  if (selectedBandIdx == null) return null
  const ids = bandParamIds(selectedBandIdx)
  if (Number(params?.[ids.activeId] ?? 0) < 0.5) return null
  return { idx: selectedBandIdx, updates: { [ids.activeId]: 0 } }
}

export function createBandTypeAction(params, selectedBandIdx, value) {
  if (selectedBandIdx == null) return null
  const ids = bandParamIds(selectedBandIdx)
  const type = clampBandType(value)
  const updates = { [ids.typeId]: type }
  const currentGain = clampBellGain(paramOr(params, ids.gainId, 0))
  if (type === BAND_TYPE.BAND_REJECT && currentGain > 0) {
    updates[ids.gainId] = 0
  }
  return { idx: selectedBandIdx, updates }
}

export function createBandFreqAction(selectedBandIdx, value) {
  if (selectedBandIdx == null) return null
  const ids = bandParamIds(selectedBandIdx)
  return { idx: selectedBandIdx, updates: { [ids.freqId]: editorValueToFreq(value) } }
}

export function createBandGainAction(selectedBandIdx, type, value) {
  if (selectedBandIdx == null) return null
  const ids = bandParamIds(selectedBandIdx)
  return { idx: selectedBandIdx, updates: { [ids.gainId]: clampEditorGainForType(type, value) } }
}

export function createBandQAction(selectedBandIdx, value) {
  if (selectedBandIdx == null) return null
  const ids = bandParamIds(selectedBandIdx)
  return { idx: selectedBandIdx, updates: { [ids.qId]: clampBandQ(Number(value)) } }
}

export function applyParamUpdates(setParam, updates) {
  for (const [id, value] of Object.entries(updates || {})) {
    setParam(id, value)
  }
}

// params / setParam: the device's parameter state and writer.
// selectedBandIdx / onSelectBand: pass both to own the selection (the device's
// Focus section edits the selected band); omit them and the overlay keeps its own.
export default function ResonanceCurveOverlay({ params, setParam, selectedBandIdx: selectedProp, onSelectBand }) {

  const rootRef = useRef(null)
  const svgRef = useRef(null)
  const dragRef = useRef(null)
  const ctxRef = useRef({ setParam, params })
  ctxRef.current = { setParam, params }

  const [size, setSize] = useState({ w: 0, h: 0 })
  const [activeKey, setActiveKey] = useState(null)
  const [ownSelected, setOwnSelected] = useState(null)
  const controlled = selectedProp !== undefined
  const selectedBandIdx = controlled ? selectedProp : ownSelected
  const selectRef = useRef(null)
  selectRef.current = controlled ? onSelectBand : setOwnSelected
  const setSelectedBandIdx = useCallback((idx) => { selectRef.current?.(idx) }, [])

  const selectedRef = useRef(null)
  selectedRef.current = selectedBandIdx

  useEffect(() => {
    const el = rootRef.current
    if (!el) return

    const measure = () => {
      const rect = el.getBoundingClientRect()
      const w = Math.max(1, Math.round(rect.width || 0))
      const h = Math.max(1, Math.round(rect.height || 0))
      setSize(prev => (prev.w === w && prev.h === h ? prev : { w, h }))
    }

    measure()
    const raf1 = requestAnimationFrame(measure)
    const raf2 = requestAnimationFrame(() => requestAnimationFrame(measure))

    let ro = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => measure())
      ro.observe(el)
    }
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
      ro?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  useEffect(() => {
    function applyAt(clientX, clientY) {
      const drag = dragRef.current
      if (!drag) return
      const rect = svgRef.current?.getBoundingClientRect()
      if (!rect) return
      const updates = computeDragParamUpdates(
        drag,
        clientX - rect.left,
        clientY - rect.top,
        rect.width,
        rect.height,
      )
      applyParamUpdates(ctxRef.current.setParam, updates)
    }

    function onMove(e) {
      if (!dragRef.current) return
      if (e.cancelable) e.preventDefault()
      applyAt(e.clientX, e.clientY)
    }

    function onEnd() {
      if (!dragRef.current) return
      dragRef.current = null
      setActiveKey(null)
    }

    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
    }
  }, [])

  // Keys for the selected band while focus is inside the overlay (a band handle
  // handles its own keys first). Never on the window: Delete there belongs to the
  // timeline, and several Resonance devices can be on screen at once.
  const onRootKeyDown = useCallback((e) => {
    // A band handle that handled the key already prevented it.
    if (e.defaultPrevented) return
    if (e.key === 'Escape') {
      if (selectedRef.current != null) {
        e.preventDefault()
        setSelectedBandIdx(null)
      }
      return
    }

    const idx = selectedRef.current
    if (idx == null) return
    const ids = bandParamIds(idx)

    if (e.key === '[' || e.key === ']') {
      e.preventDefault()
      const cur = paramOr(ctxRef.current.params, ids.qId, 1)
      const step = e.shiftKey ? Q_KEY_FACTOR_FINE : Q_KEY_FACTOR
      const next = e.key === ']' ? cur * step : cur / step
      ctxRef.current.setParam(ids.qId, clampBandQ(next))
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      ctxRef.current.setParam(ids.activeId, 0)
      setSelectedBandIdx(null)
    }
  }, [setSelectedBandIdx])

  const editorModel = useMemo(
    () => buildBandEditorModel(params, selectedBandIdx),
    [params, selectedBandIdx],
  )
  const activeBands = editorModel.activeBands
  const selectedBand = editorModel.selectedBand

  useEffect(() => {
    if (selectedBandIdx != null && !selectedBand) {
      setSelectedBandIdx(null)
    }
  }, [selectedBandIdx, selectedBand])

  const beginBoundaryDrag = useCallback((e, kind, key) => {
    if (e.button !== undefined && e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = { kind }
    setActiveKey(key)
    setSelectedBandIdx(null)
  }, [])

  const beginBandDrag = useCallback((e, idx, type) => {
    if (e.button !== undefined && e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const ids = bandParamIds(idx)
    dragRef.current = {
      kind: 'band',
      bandType: clampBandType(type),
      freqId: ids.freqId,
      gainId: ids.gainId,
    }
    setActiveKey(`b${idx}`)
    setSelectedBandIdx(idx)
  }, [])

  const onBackgroundDown = useCallback((e) => {
    if (e.button !== undefined && e.button !== 0) return
    setSelectedBandIdx(null)
  }, [])

  const onWheel = useCallback((e) => {
    const idx = selectedRef.current
    if (idx == null) return
    e.preventDefault()
    const ids = bandParamIds(idx)
    const cur = paramOr(ctxRef.current.params, ids.qId, 1)
    const factor = Math.exp(-e.deltaY * Q_WHEEL_FACTOR)
    ctxRef.current.setParam(ids.qId, clampBandQ(cur * factor))
  }, [])

  const onBoundaryKeyDown = useCallback((e, paramId, min, max) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const span = max - min
    const stepFine = Math.max(1, span * 0.005)
    const stepCoarse = Math.max(1, span * 0.02)
    const step = e.shiftKey ? stepFine : stepCoarse
    const cur = paramOr(ctxRef.current.params, paramId, (min + max) / 2)
    const next = clamp(cur + (e.key === 'ArrowRight' ? step : -step), min, max)
    ctxRef.current.setParam(paramId, next)
  }, [])

  const onBandKeyDown = useCallback((e, idx, type) => {
    const ids = bandParamIds(idx)
    const freqStep = e.shiftKey ? 1.01 : 1.05
    const gainStep = e.shiftKey ? 0.1 : 0.5
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      const cur = paramOr(ctxRef.current.params, ids.freqId, 1000)
      ctxRef.current.setParam(ids.freqId, clampBellFreq(cur / freqStep))
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      const cur = paramOr(ctxRef.current.params, ids.freqId, 1000)
      ctxRef.current.setParam(ids.freqId, clampBellFreq(cur * freqStep))
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const cur = paramOr(ctxRef.current.params, ids.gainId, 0)
      const next = cur + (e.key === 'ArrowUp' ? gainStep : -gainStep)
      ctxRef.current.setParam(ids.gainId, clampEditorGainForType(type, next))
    } else if (e.key === '[' || e.key === ']') {
      e.preventDefault()
      const cur = paramOr(ctxRef.current.params, ids.qId, 1)
      const step = e.shiftKey ? Q_KEY_FACTOR_FINE : Q_KEY_FACTOR
      const next = e.key === ']' ? cur * step : cur / step
      ctxRef.current.setParam(ids.qId, clampBandQ(next))
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      ctxRef.current.setParam(ids.activeId, 0)
      setSelectedBandIdx(null)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setSelectedBandIdx(null)
    }
  }, [])

  const measured = size.w >= 4 && size.h >= 4
  const w = measured ? size.w : FALLBACK_GRAPH_W
  const h = measured ? size.h : FALLBACK_GRAPH_H

  const hpHz = clampHp(paramOr(params, 'wc_hp', 80))
  const lpHz = clampLp(paramOr(params, 'wc_lp', 16000))
  const hpX = freqToX(hpHz, w)
  const lpX = freqToX(lpHz, w)
  const zeroY = gainToY(0, h)
  const boundaryY = h - BOUNDARY_HANDLE_DROP_PX - BOUNDARY_HANDLE_H_PX
  const boundaryHalfW = BOUNDARY_HANDLE_W_PX * 0.5

  return (
    <div
      ref={rootRef}
      className={styles.overlay}
      role="group"
      aria-label="Focus curve editor"
      onKeyDown={onRootKeyDown}
    >
      <svg
        ref={svgRef}
        className={styles.svg}
        width="100%"
        height="100%"
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        onWheel={onWheel}
      >
        <rect
          className={styles.bg}
          x="0"
          y="0"
          width={w}
          height={h}
          fill="transparent"
          onPointerDown={onBackgroundDown}
        />

        <line
          x1="0"
          y1={zeroY}
          x2={w}
          y2={zeroY}
          className={styles.zero}
        />

        <g className={`${styles.handle} ${styles.boundary}`} data-active={activeKey === 'hp' || undefined}>
          <line x1={hpX} y1={0} x2={hpX} y2={h} className={styles.rail} />
          <rect
            data-handle="hp"
            x={hpX - boundaryHalfW}
            y={boundaryY}
            width={BOUNDARY_HANDLE_W_PX}
            height={BOUNDARY_HANDLE_H_PX}
            rx="2"
            ry="2"
            role="slider"
            tabIndex={0}
            aria-label="HP focus boundary frequency"
            aria-valuemin={HP_MIN_HZ}
            aria-valuemax={HP_MAX_HZ}
            aria-valuenow={Math.round(hpHz)}
            aria-valuetext={`${Math.round(hpHz)} Hz`}
            className={styles.rect}
            onPointerDown={(e) => beginBoundaryDrag(e, 'hp', 'hp')}
            onKeyDown={(e) => onBoundaryKeyDown(e, 'wc_hp', HP_MIN_HZ, HP_MAX_HZ)}
          />
          <text x={hpX} y={boundaryY - 3} textAnchor="middle" className={styles.label}>HP</text>
        </g>

        <g className={`${styles.handle} ${styles.boundary}`} data-active={activeKey === 'lp' || undefined}>
          <line x1={lpX} y1={0} x2={lpX} y2={h} className={styles.rail} />
          <rect
            data-handle="lp"
            x={lpX - boundaryHalfW}
            y={boundaryY}
            width={BOUNDARY_HANDLE_W_PX}
            height={BOUNDARY_HANDLE_H_PX}
            rx="2"
            ry="2"
            role="slider"
            tabIndex={0}
            aria-label="LP focus boundary frequency"
            aria-valuemin={LP_MIN_HZ}
            aria-valuemax={LP_MAX_HZ}
            aria-valuenow={Math.round(lpHz)}
            aria-valuetext={`${Math.round(lpHz)} Hz`}
            className={styles.rect}
            onPointerDown={(e) => beginBoundaryDrag(e, 'lp', 'lp')}
            onKeyDown={(e) => onBoundaryKeyDown(e, 'wc_lp', LP_MIN_HZ, LP_MAX_HZ)}
          />
          <text x={lpX} y={boundaryY - 3} textAnchor="middle" className={styles.label}>LP</text>
        </g>

        {activeBands.map(b => (
          <BandHandle
            key={`b${b.idx}`}
            band={b}
            w={w}
            h={h}
            isActive={activeKey === `b${b.idx}`}
            isSelected={selectedBandIdx === b.idx}
            onPointerDown={(e) => beginBandDrag(e, b.idx, b.type)}
            onKeyDown={(e) => onBandKeyDown(e, b.idx, b.type)}
          />
        ))}
      </svg>

    </div>
  )
}

export function BandHandle({ band, w, h, isActive, isSelected, onPointerDown, onKeyDown }) {
  const cx = freqToX(band.freq, w)
  const cy = gainToY(band.gain, h)
  const isNeutral = Math.abs(band.gain) < 0.05
  const cls = `${styles.handle} ${styles.band}`

  const opt = BAND_TYPE_OPTIONS[band.type] || BAND_TYPE_OPTIONS[0]
  const aria = `${opt.label} band ${band.idx}: ${Math.round(band.freq)} Hz, ${band.gain.toFixed(1)} dB, Q ${band.q.toFixed(2)}`
  const r = HANDLE_RADIUS_PX

  let glyph = null
  switch (band.type) {
    case BAND_TYPE.LOW_SHELF:
      glyph = (
        <path
          d={`M ${cx - r} ${cy} L ${cx} ${cy - r} L ${cx + r} ${cy} L ${cx + r} ${cy + r} L ${cx - r} ${cy + r} Z`}
          className={styles.glyph}
        />
      )
      break
    case BAND_TYPE.HIGH_SHELF:
      glyph = (
        <path
          d={`M ${cx + r} ${cy} L ${cx} ${cy - r} L ${cx - r} ${cy} L ${cx - r} ${cy + r} L ${cx + r} ${cy + r} Z`}
          className={styles.glyph}
        />
      )
      break
    case BAND_TYPE.BAND_REJECT:
      glyph = (
        <path
          d={`M ${cx} ${cy - r} L ${cx + r} ${cy} L ${cx} ${cy + r} L ${cx - r} ${cy} Z`}
          className={styles.glyph}
        />
      )
      break
    case BAND_TYPE.TILT:
      glyph = (
        <path
          d={`M ${cx - r} ${cy + r} L ${cx + r} ${cy - r} L ${cx + r} ${cy + r} L ${cx - r} ${cy + r} Z`}
          className={styles.glyph}
        />
      )
      break
    case BAND_TYPE.BELL:
    default:
      glyph = <circle cx={cx} cy={cy} r={r} className={styles.glyph} />
      break
  }

  return (
    <g className={cls} data-band={band.idx} data-type={band.type} data-active={isActive || undefined} data-selected={isSelected || undefined} data-neutral={isNeutral || undefined}>
      {isSelected && (
        <circle
          cx={cx}
          cy={cy}
          r={r + 6}
          className={styles.ring}
        />
      )}
      {glyph}
      <circle
        data-handle={`band-${band.idx}`}
        cx={cx}
        cy={cy}
        r={r + 5}
        className={styles.hit}
        role="slider"
        tabIndex={0}
        aria-label={aria}
        aria-valuetext={aria}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      />
      <text
        x={cx}
        y={cy + 0.5}
        textAnchor="middle"
        dominantBaseline="middle"
        className={`${styles.label} ${styles.bandLabel}`}
      >
        {band.idx}
      </text>
    </g>
  )
}
