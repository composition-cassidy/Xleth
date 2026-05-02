// Dynamic Focus Curve editor for the Resonance Suppressor visualizer.
//
// The canvas painter owns spectrum, reduction, and weighting visuals. This
// component only owns UI interaction: HP/LP boundary handles, active band
// handles, and a docked selected-band editor strip below the graph.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePluginUI } from '../PluginUIContext.js'
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
} from '../visualizers/resonanceCurveMapping.js'

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

function isTextEditableTarget(target) {
  if (!target || target.nodeType !== 1) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.isContentEditable === true
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

function applyParamUpdates(setParam, updates) {
  for (const [id, value] of Object.entries(updates || {})) {
    setParam(id, value)
  }
}

export default function ResonanceCurveOverlay() {
  const { params, setParam } = usePluginUI()

  const rootRef = useRef(null)
  const svgRef = useRef(null)
  const dragRef = useRef(null)
  const ctxRef = useRef({ setParam, params })
  ctxRef.current = { setParam, params }

  const [size, setSize] = useState({ w: 0, h: 0 })
  const [activeKey, setActiveKey] = useState(null)
  const [selectedBandIdx, setSelectedBandIdx] = useState(null)

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

  useEffect(() => {
    function onKeyDown(e) {
      if (isTextEditableTarget(e.target)) return
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
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

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

  const addBand = useCallback(() => {
    const action = createAddBandAction(ctxRef.current.params)
    if (!action) return
    applyParamUpdates(ctxRef.current.setParam, action.updates)
    setSelectedBandIdx(action.idx)
  }, [])

  const removeSelectedBand = useCallback(() => {
    const action = createRemoveBandAction(ctxRef.current.params, selectedRef.current)
    if (!action) return
    applyParamUpdates(ctxRef.current.setParam, action.updates)
    setSelectedBandIdx(null)
  }, [])

  const setSelectedActive = useCallback((active) => {
    const idx = selectedRef.current
    if (idx == null) return
    const ids = bandParamIds(idx)
    ctxRef.current.setParam(ids.activeId, active ? 1 : 0)
    if (!active) setSelectedBandIdx(null)
  }, [])

  const setSelectedType = useCallback((value) => {
    const action = createBandTypeAction(ctxRef.current.params, selectedRef.current, value)
    if (!action) return
    applyParamUpdates(ctxRef.current.setParam, action.updates)
  }, [])

  const setSelectedFreq = useCallback((value) => {
    const action = createBandFreqAction(selectedRef.current, value)
    if (!action) return
    applyParamUpdates(ctxRef.current.setParam, action.updates)
  }, [])

  const setSelectedGain = useCallback((value) => {
    const idx = selectedRef.current
    const type = idx == null ? BAND_TYPE.BELL : clampBandType(ctxRef.current.params?.[bandParamIds(idx).typeId] ?? 0)
    const action = createBandGainAction(idx, type, value)
    if (!action) return
    applyParamUpdates(ctxRef.current.setParam, action.updates)
  }, [])

  const setSelectedQ = useCallback((value) => {
    const action = createBandQAction(selectedRef.current, value)
    if (!action) return
    applyParamUpdates(ctxRef.current.setParam, action.updates)
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
      className="pluginui-resonance-overlay"
      role="group"
      aria-label="Resonance Suppressor focus curve editor"
    >
      <svg
        ref={svgRef}
        className="pluginui-resonance-overlay__svg"
        width="100%"
        height="100%"
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        onWheel={onWheel}
      >
        <rect
          className="pluginui-resonance-overlay__bg"
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
          className="pluginui-resonance-overlay__zero"
        />

        <g className={`pluginui-resonance-handle pluginui-resonance-handle--boundary${activeKey === 'hp' ? ' is-active' : ''}`}>
          <line x1={hpX} y1={0} x2={hpX} y2={h} className="pluginui-resonance-handle__rail" />
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
            className="pluginui-resonance-handle__rect"
            onPointerDown={(e) => beginBoundaryDrag(e, 'hp', 'hp')}
            onKeyDown={(e) => onBoundaryKeyDown(e, 'wc_hp', HP_MIN_HZ, HP_MAX_HZ)}
          />
          <text x={hpX} y={boundaryY - 3} textAnchor="middle" className="pluginui-resonance-handle__label">HP</text>
        </g>

        <g className={`pluginui-resonance-handle pluginui-resonance-handle--boundary${activeKey === 'lp' ? ' is-active' : ''}`}>
          <line x1={lpX} y1={0} x2={lpX} y2={h} className="pluginui-resonance-handle__rail" />
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
            className="pluginui-resonance-handle__rect"
            onPointerDown={(e) => beginBoundaryDrag(e, 'lp', 'lp')}
            onKeyDown={(e) => onBoundaryKeyDown(e, 'wc_lp', LP_MIN_HZ, LP_MAX_HZ)}
          />
          <text x={lpX} y={boundaryY - 3} textAnchor="middle" className="pluginui-resonance-handle__label">LP</text>
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

      <ResonanceBandEditorStrip
        model={editorModel}
        onAddBand={addBand}
        onRemoveBand={removeSelectedBand}
        onToggleActive={setSelectedActive}
        onSelectType={setSelectedType}
        onChangeFreq={setSelectedFreq}
        onChangeGain={setSelectedGain}
        onChangeQ={setSelectedQ}
      />
    </div>
  )
}

export function BandHandle({ band, w, h, isActive, isSelected, onPointerDown, onKeyDown }) {
  const cx = freqToX(band.freq, w)
  const cy = gainToY(band.gain, h)
  const isNeutral = Math.abs(band.gain) < 0.05
  const cls =
    'pluginui-resonance-handle pluginui-resonance-handle--band' +
    ` pluginui-resonance-handle--band-${band.idx}` +
    ` pluginui-resonance-handle--type-${band.type}` +
    (isActive ? ' is-active' : '') +
    (isSelected ? ' is-selected' : '') +
    (isNeutral ? ' is-neutral' : '')

  const opt = BAND_TYPE_OPTIONS[band.type] || BAND_TYPE_OPTIONS[0]
  const aria = `${opt.label} band ${band.idx}: ${Math.round(band.freq)} Hz, ${band.gain.toFixed(1)} dB, Q ${band.q.toFixed(2)}`
  const r = HANDLE_RADIUS_PX

  let glyph = null
  switch (band.type) {
    case BAND_TYPE.LOW_SHELF:
      glyph = (
        <path
          d={`M ${cx - r} ${cy} L ${cx} ${cy - r} L ${cx + r} ${cy} L ${cx + r} ${cy + r} L ${cx - r} ${cy + r} Z`}
          className="pluginui-resonance-handle__glyph"
        />
      )
      break
    case BAND_TYPE.HIGH_SHELF:
      glyph = (
        <path
          d={`M ${cx + r} ${cy} L ${cx} ${cy - r} L ${cx - r} ${cy} L ${cx - r} ${cy + r} L ${cx + r} ${cy + r} Z`}
          className="pluginui-resonance-handle__glyph"
        />
      )
      break
    case BAND_TYPE.BAND_REJECT:
      glyph = (
        <path
          d={`M ${cx} ${cy - r} L ${cx + r} ${cy} L ${cx} ${cy + r} L ${cx - r} ${cy} Z`}
          className="pluginui-resonance-handle__glyph"
        />
      )
      break
    case BAND_TYPE.TILT:
      glyph = (
        <path
          d={`M ${cx - r} ${cy + r} L ${cx + r} ${cy - r} L ${cx + r} ${cy + r} L ${cx - r} ${cy + r} Z`}
          className="pluginui-resonance-handle__glyph"
        />
      )
      break
    case BAND_TYPE.BELL:
    default:
      glyph = <circle cx={cx} cy={cy} r={r} className="pluginui-resonance-handle__glyph" />
      break
  }

  return (
    <g className={cls}>
      {isSelected && (
        <circle
          cx={cx}
          cy={cy}
          r={r + 6}
          className="pluginui-resonance-handle__selection-ring"
        />
      )}
      {glyph}
      <circle
        data-handle={`band-${band.idx}`}
        cx={cx}
        cy={cy}
        r={r + 5}
        className="pluginui-resonance-handle__hit"
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
        className="pluginui-resonance-handle__label pluginui-resonance-handle__label--band"
      >
        {band.idx}
      </text>
    </g>
  )
}

export function ResonanceBandEditorStrip({
  model,
  onAddBand,
  onRemoveBand,
  onToggleActive,
  onSelectType,
  onChangeFreq,
  onChangeGain,
  onChangeQ,
}) {
  const band = model?.selectedBand || null
  const disabled = !band
  const type = band ? clampBandType(band.type) : BAND_TYPE.BELL
  const gainForEditor = band ? clampEditorGainForType(type, band.gain) : 0
  const showWidth = band && isBandWidthEditable(type)

  return (
    <div
      className={'pluginui-resonance-band-editor' + (disabled ? ' is-empty' : '')}
      role="region"
      aria-label="Selected focus band editor"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="pluginui-resonance-band-editor__identity">
        <span
          className={
            'pluginui-resonance-band-token' +
            (band ? ` pluginui-resonance-band-token--b${band.idx}` : '')
          }
        >
          <span className="pluginui-resonance-band-token__dot" aria-hidden="true" />
          <span className="pluginui-resonance-band-token__text">
            {band ? `Band ${band.idx}` : 'Select band'}
          </span>
        </span>

        <label className="pluginui-resonance-band-editor__active">
          <input
            type="checkbox"
            checked={!!band}
            disabled={disabled}
            onChange={(e) => onToggleActive?.(e.target.checked)}
          />
          <span>Active</span>
        </label>

        <button
          type="button"
          className="pluginui-resonance-band-editor__button"
          onClick={onAddBand}
          disabled={!model?.canAddBand}
          aria-label="Add focus band"
        >
          + Band
        </button>

        {band && (
          <button
            type="button"
            className="pluginui-resonance-band-editor__button pluginui-resonance-band-editor__button--remove"
            onClick={onRemoveBand}
            aria-label={`Remove band ${band.idx}`}
          >
            - Band
          </button>
        )}

        <span className="pluginui-resonance-band-editor__count">
          {model?.activeCount ?? 0}/{NUM_BANDS}
        </span>
      </div>

      <div
        className={'pluginui-resonance-band-editor__controls' + (disabled ? ' is-disabled' : '')}
        aria-disabled={disabled ? 'true' : 'false'}
      >
        <div className="pluginui-resonance-band-editor__type" role="radiogroup" aria-label="Band shape">
          {BAND_TYPE_OPTIONS.map(opt => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={band ? type === opt.value : false}
              className={
                'pluginui-resonance-band-editor__type-btn' +
                (band && type === opt.value ? ' is-selected' : '')
              }
              disabled={disabled}
              title={opt.label}
              onClick={() => onSelectType?.(opt.value)}
            >
              {opt.shortLabel}
            </button>
          ))}
        </div>

        <label className="pluginui-resonance-band-editor__control">
          <span>Focus</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.001"
            value={band ? freqToEditorValue(band.freq) : freqToEditorValue(1000)}
            disabled={disabled}
            onChange={(e) => onChangeFreq?.(e.target.value)}
          />
          <output>{band ? formatEditorFreq(band.freq) : '--'}</output>
        </label>

        <label className="pluginui-resonance-band-editor__control">
          <span>Sens</span>
          <input
            type="range"
            min={BELL_GAIN_MIN_DB}
            max={type === BAND_TYPE.BAND_REJECT ? 0 : BELL_GAIN_MAX_DB}
            step="0.1"
            value={gainForEditor}
            disabled={disabled}
            onChange={(e) => onChangeGain?.(e.target.value)}
          />
          <output>{band ? formatEditorGain(gainForEditor) : '--'}</output>
        </label>

        {showWidth && (
          <label className="pluginui-resonance-band-editor__control pluginui-resonance-band-editor__control--width">
            <span>Width</span>
            <input
              type="range"
              min={BAND_Q_MIN}
              max={BAND_Q_MAX}
              step="0.01"
              value={band.q}
              disabled={disabled}
              onChange={(e) => onChangeQ?.(e.target.value)}
            />
            <output>{band.q.toFixed(2)}</output>
          </label>
        )}
      </div>
    </div>
  )
}
