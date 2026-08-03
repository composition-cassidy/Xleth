import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import packageInfo from '../../../../package.json'
import {
  CLIP_CONTROL_DEFAULTS,
  CLIP_CONTROL_SPEC_VERSION,
  CLIP_CONTROL_TUNABLE_FIELDS,
  applyFadeDrag,
  applyGainDrag,
  buildClipControlTuningReport,
  clipControlDefaultsHash,
  cloneClipControlSpec,
  getPathValue,
  hitTestClipControl,
  normalizeClipControlSpec,
  setPathValue,
} from '../clipControlSpec.js'
import { drawClipFadeOverlay, drawClipInlineControls } from '../timelineDrawing.js'
import './clipControlTuner.css'

const DEFAULTS_HASH = clipControlDefaultsHash(CLIP_CONTROL_DEFAULTS)
const STORAGE_KEY = `xleth.clip-control-tuner.v${CLIP_CONTROL_SPEC_VERSION}:${DEFAULTS_HASH}`
const PREVIEW_SIZES = [
  [40, 20],
  [64, 46],
  [180, 46],
  [360, 86],
]
const PREVIEW_STATES = ['idle', 'selected', 'hovered', 'active']
const TRACK_COLORS = ['#5687de', '#36bfa2', '#d36a86', '#c99b48', '#9b70d8']
const HISTORY_LIMIT = 300
const COALESCE_MS = 400

const DEFAULT_PREVIEW_STATE = {
  velocity: 1,
  fadeInPercent: 18,
  fadeOutPercent: 24,
  fadeInX1: 0.18,
  fadeInY1: 0,
  fadeInX2: 0.72,
  fadeInY2: 1,
  fadeOutX1: 0.18,
  fadeOutY1: 0,
  fadeOutX2: 0.72,
  fadeOutY2: 1,
  trackColor: TRACK_COLORS[0],
}

function persistedSession() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
    if (parsed?.schemaVersion !== CLIP_CONTROL_SPEC_VERSION || parsed?.defaultsHash !== DEFAULTS_HASH) return null
    return {
      spec: normalizeClipControlSpec(parsed.final),
      changeHistory: Array.isArray(parsed.changeHistory) ? parsed.changeHistory : [],
      previewState: { ...DEFAULT_PREVIEW_STATE, ...(parsed.previewState || {}) },
    }
  } catch {
    return null
  }
}

function PreviewCanvas({ width, height, state, spec, previewState, onPreviewStateChange }) {
  const canvasRef = useRef(null)
  const dragRef = useRef(null)
  const [hoverKind, setHoverKind] = useState(null)
  const [dragKind, setDragKind] = useState(null)
  const clip = useMemo(() => ({ id: 1, ...previewState }), [previewState])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.round(width * dpr))
    canvas.height = Math.max(1, Math.round(height * dpr))
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    const gradient = ctx.createLinearGradient(0, 0, 0, height)
    gradient.addColorStop(0, previewState.trackColor)
    gradient.addColorStop(1, '#25334f')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, width, height)
    ctx.strokeStyle = state === 'selected' || state === 'active' ? '#87b7ff' : 'rgba(255,255,255,.24)'
    ctx.lineWidth = state === 'selected' || state === 'active' ? 2 : 1
    ctx.strokeRect(0.5, 0.5, Math.max(0, width - 1), Math.max(0, height - 1))
    ctx.fillStyle = 'rgba(255,255,255,.78)'
    ctx.font = '600 9px Inter, sans-serif'
    ctx.fillText(`${width}×${height}`, 5, 11)

    const selected = state === 'selected' || state === 'active'
    const hoveredControl = state === 'hovered' || hoverKind
      ? { clipId: 1, kind: hoverKind || 'volume' }
      : null
    const activeControl = state === 'active' || dragKind
      ? {
          clipId: 1,
          kind: dragKind || 'volume',
          value: dragKind === 'fadeIn'
            ? previewState.fadeInPercent
            : (dragKind === 'fadeOut' ? previewState.fadeOutPercent : previewState.velocity),
        }
      : null
    drawClipFadeOverlay(ctx, clip, 0, 0, width, height, selected, 'rgba(3,7,16,.72)', spec)
    drawClipInlineControls(
      ctx, clip, 0, 0, width, height, previewState.trackColor,
      selected, activeControl, hoveredControl, spec,
    )
  }, [clip, dragKind, height, hoverKind, previewState, spec, state, width])

  const localPoint = useCallback((event) => {
    const bounds = canvasRef.current?.getBoundingClientRect()
    if (!bounds) return null
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
  }, [])

  const hitAt = useCallback((event) => {
    const point = localPoint(event)
    if (!point) return null
    return hitTestClipControl({
      localX: point.x,
      localY: point.y,
      clip,
      rect: { x: 0, y: 0, w: width, h: height },
      spec,
    })
  }, [clip, height, localPoint, spec, width])

  const handlePointerMove = useCallback((event) => {
    if (dragRef.current) return
    const hit = hitAt(event)
    setHoverKind(hit?.kind || null)
    if (canvasRef.current) canvasRef.current.style.cursor = hit?.kind === 'volume' ? 'ns-resize' : (hit ? 'ew-resize' : 'default')
  }, [hitAt])

  const handlePointerDown = useCallback((event) => {
    const hit = hitAt(event)
    if (!hit) return
    event.preventDefault()
    const start = {
      kind: hit.kind,
      clientX: event.clientX,
      clientY: event.clientY,
      velocity: previewState.velocity,
      fadeInPercent: previewState.fadeInPercent,
      fadeOutPercent: previewState.fadeOutPercent,
    }
    dragRef.current = start
    setDragKind(hit.kind)

    const move = (moveEvent) => {
      const active = dragRef.current
      if (!active) return
      if (active.kind === 'volume') {
        onPreviewStateChange({
          velocity: applyGainDrag(active.velocity, moveEvent.clientY - active.clientY, moveEvent, spec),
        })
      } else {
        const startPercent = active.kind === 'fadeIn' ? active.fadeInPercent : active.fadeOutPercent
        const opposite = active.kind === 'fadeIn' ? active.fadeOutPercent : active.fadeInPercent
        onPreviewStateChange({
          [active.kind === 'fadeIn' ? 'fadeInPercent' : 'fadeOutPercent']: applyFadeDrag(
            active.kind, startPercent, opposite, moveEvent.clientX - active.clientX, width, moveEvent, spec,
          ),
        })
      }
    }
    const up = () => {
      dragRef.current = null
      setDragKind(null)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('blur', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('blur', up)
  }, [hitAt, onPreviewStateChange, previewState, spec, width])

  return (
    <canvas
      ref={canvasRef}
      className="clip-control-tuner-preview-canvas"
      data-preview-state={state}
      aria-label={`${state} ${width} by ${height} clip control preview`}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => setHoverKind(null)}
      onPointerDown={handlePointerDown}
    />
  )
}

function FieldControl({ field, value, onChange }) {
  if (field.type === 'boolean') {
    return (
      <label className="clip-control-tuner-field clip-control-tuner-toggle">
        <span>{field.label}</span>
        <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />
      </label>
    )
  }
  if (field.type === 'enum') {
    return (
      <label className="clip-control-tuner-field">
        <span>{field.label}</span>
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
    )
  }
  return (
    <label className="clip-control-tuner-field">
      <span title={field.path}>{field.label}</span>
      <input
        type="range"
        min={field.min}
        max={field.max}
        step={field.step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <input
        type="number"
        min={field.min}
        max={field.max}
        step={field.step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  )
}

export default function ClipControlTuner({ spec, onSpecChange, onClose, pixelsPerBeat = null }) {
  const restoredRef = useRef(false)
  const skipFirstPersistRef = useRef(true)
  const lastEditRef = useRef({ path: null, at: 0 })
  const [undoStack, setUndoStack] = useState([])
  const [redoStack, setRedoStack] = useState([])
  const [changeHistory, setChangeHistory] = useState([])
  const [previewState, setPreviewState] = useState(DEFAULT_PREVIEW_STATE)
  const [copyStatus, setCopyStatus] = useState('')

  const groups = useMemo(() => {
    const result = new Map()
    for (const field of CLIP_CONTROL_TUNABLE_FIELDS) {
      if (!result.has(field.group)) result.set(field.group, [])
      result.get(field.group).push(field)
    }
    return [...result.entries()]
  }, [])

  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    const restored = persistedSession()
    if (!restored) return
    setChangeHistory(restored.changeHistory)
    setPreviewState(restored.previewState)
    onSpecChange(restored.spec)
  }, [onSpecChange])

  useEffect(() => {
    if (!restoredRef.current) return
    if (skipFirstPersistRef.current) {
      skipFirstPersistRef.current = false
      return
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        schemaVersion: CLIP_CONTROL_SPEC_VERSION,
        defaultsHash: DEFAULTS_HASH,
        final: normalizeClipControlSpec(spec),
        changeHistory,
        previewState,
        savedAt: new Date().toISOString(),
      }))
    } catch {
      // Dev aid only: quota/privacy failures must never affect timeline editing.
    }
  }, [changeHistory, previewState, spec])

  const recordChange = useCallback((path, before, after) => {
    const now = Date.now()
    setChangeHistory((current) => {
      const previous = current[current.length - 1]
      if (previous?.path === path && now - previous.atMs <= COALESCE_MS) {
        return [...current.slice(0, -1), { ...previous, to: after, atMs: now }]
      }
      return [...current, { path, from: before, to: after, atMs: now }].slice(-HISTORY_LIMIT)
    })
  }, [])

  const applySpec = useCallback((next, path = 'multiple') => {
    const normalized = normalizeClipControlSpec(next)
    const now = Date.now()
    if (lastEditRef.current.path !== path || now - lastEditRef.current.at > COALESCE_MS) {
      setUndoStack((current) => [...current, cloneClipControlSpec(spec)].slice(-HISTORY_LIMIT))
    }
    lastEditRef.current = { path, at: now }
    setRedoStack([])
    onSpecChange(normalized)
  }, [onSpecChange, spec])

  const changeField = useCallback((field, value) => {
    const before = getPathValue(spec, field.path)
    const next = setPathValue(spec, field.path, value)
    const normalized = normalizeClipControlSpec(next)
    const after = getPathValue(normalized, field.path)
    if (before === after) return
    recordChange(field.path, before, after)
    applySpec(normalized, field.path)
  }, [applySpec, recordChange, spec])

  const resetGroup = useCallback((groupName, fields) => {
    let next = cloneClipControlSpec(spec)
    for (const field of fields) next = setPathValue(next, field.path, getPathValue(CLIP_CONTROL_DEFAULTS, field.path))
    recordChange(`group:${groupName}`, 'custom', 'defaults')
    applySpec(next, `group:${groupName}`)
  }, [applySpec, recordChange, spec])

  const resetAll = useCallback(() => {
    recordChange('all', 'custom', 'defaults')
    applySpec(CLIP_CONTROL_DEFAULTS, 'all')
  }, [applySpec, recordChange])

  const undo = useCallback(() => {
    setUndoStack((current) => {
      if (!current.length) return current
      const previous = current[current.length - 1]
      setRedoStack((redo) => [...redo, cloneClipControlSpec(spec)].slice(-HISTORY_LIMIT))
      onSpecChange(normalizeClipControlSpec(previous))
      lastEditRef.current = { path: null, at: 0 }
      return current.slice(0, -1)
    })
  }, [onSpecChange, spec])

  const redo = useCallback(() => {
    setRedoStack((current) => {
      if (!current.length) return current
      const next = current[current.length - 1]
      setUndoStack((undoItems) => [...undoItems, cloneClipControlSpec(spec)].slice(-HISTORY_LIMIT))
      onSpecChange(normalizeClipControlSpec(next))
      lastEditRef.current = { path: null, at: 0 }
      return current.slice(0, -1)
    })
  }, [onSpecChange, spec])

  const updatePreviewState = useCallback((patch) => {
    setPreviewState((current) => {
      const next = { ...current, ...patch }
      for (const key of Object.keys(next)) {
        if (key !== 'trackColor') next[key] = Number(next[key]) || 0
      }
      next.velocity = Math.max(0, Math.min(2, Number(next.velocity) || 0))
      next.fadeInPercent = Math.max(0, Math.min(100, Number(next.fadeInPercent) || 0))
      next.fadeOutPercent = Math.max(0, Math.min(100 - next.fadeInPercent, Number(next.fadeOutPercent) || 0))
      return next
    })
  }, [])

  const copyReport = useCallback(async () => {
    const root = document.documentElement
    const report = buildClipControlTuningReport({
      finalSpec: spec,
      changeHistory,
      previewState,
      appVersion: packageInfo.version,
      context: {
        theme: root.getAttribute('data-theme') || document.body.getAttribute('data-theme') || 'default',
        colorScheme: window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
        devicePixelRatio: window.devicePixelRatio || 1,
        timelinePixelsPerBeat: pixelsPerBeat,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      },
    })
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2))
      setCopyStatus('Full report copied')
    } catch (error) {
      console.error('[ClipControlTuner] copy failed', error)
      setCopyStatus('Copy failed')
    }
    window.setTimeout(() => setCopyStatus(''), 1800)
  }, [changeHistory, pixelsPerBeat, previewState, spec])

  return (
    <aside className="clip-control-tuner" aria-label="Clip gain and fade tuning lab">
      <header className="clip-control-tuner-header">
        <div>
          <strong>Clip Control Tuning Lab</strong>
          <small>v{CLIP_CONTROL_SPEC_VERSION} · {DEFAULTS_HASH}</small>
        </div>
        <button type="button" onClick={onClose} aria-label="Close tuning lab">×</button>
      </header>

      <div className="clip-control-tuner-actions">
        <button type="button" onClick={undo} disabled={!undoStack.length}>Undo</button>
        <button type="button" onClick={redo} disabled={!redoStack.length}>Redo</button>
        <button type="button" onClick={resetAll}>Full reset</button>
        <button type="button" className="primary" onClick={copyReport}>Copy full report</button>
        {copyStatus && <output>{copyStatus}</output>}
      </div>

      <details className="clip-control-tuner-preview" open>
        <summary>Production preview matrix</summary>
        <div className="clip-control-tuner-preview-state">
          <label>Gain <input type="number" min="0" max="2" step="0.01" value={previewState.velocity} onChange={(event) => updatePreviewState({ velocity: event.target.value })} /></label>
          <label>Fade in <input type="number" min="0" max="100" step="0.1" value={previewState.fadeInPercent} onChange={(event) => updatePreviewState({ fadeInPercent: event.target.value })} /></label>
          <label>Fade out <input type="number" min="0" max="100" step="0.1" value={previewState.fadeOutPercent} onChange={(event) => updatePreviewState({ fadeOutPercent: event.target.value })} /></label>
          <label>Track colour <select value={previewState.trackColor} onChange={(event) => updatePreviewState({ trackColor: event.target.value })}>{TRACK_COLORS.map((color) => <option key={color} value={color}>{color}</option>)}</select></label>
        </div>
        <details>
          <summary>Fade Béziers</summary>
          <div className="clip-control-tuner-beziers">
            {['fadeInX1', 'fadeInY1', 'fadeInX2', 'fadeInY2', 'fadeOutX1', 'fadeOutY1', 'fadeOutX2', 'fadeOutY2'].map((key) => (
              <label key={key}>{key}<input type="number" min="0" max="1" step="0.01" value={previewState[key]} onChange={(event) => updatePreviewState({ [key]: event.target.value })} /></label>
            ))}
          </div>
        </details>
        <p>Drag any production handle. Hold Shift for precision.</p>
        <div className="clip-control-tuner-matrix">
          <div className="matrix-corner" />
          {PREVIEW_STATES.map((state) => <strong key={state}>{state}</strong>)}
          {PREVIEW_SIZES.flatMap(([width, height]) => [
            <span className="matrix-size" key={`${width}x${height}-label`}>{width}×{height}</span>,
            ...PREVIEW_STATES.map((state) => (
              <PreviewCanvas
                key={`${width}x${height}-${state}`}
                width={width}
                height={height}
                state={state}
                spec={spec}
                previewState={previewState}
                onPreviewStateChange={updatePreviewState}
              />
            )),
          ])}
        </div>
      </details>

      <div className="clip-control-tuner-groups">
        {groups.map(([groupName, fields], index) => (
          <details key={groupName} open={index === 0 || groupName === 'Debug'}>
            <summary>
              <span>{groupName}</span>
              <button type="button" onClick={(event) => { event.preventDefault(); resetGroup(groupName, fields) }}>Reset group</button>
            </summary>
            {fields.map((field) => (
              <FieldControl
                key={field.path}
                field={field}
                value={getPathValue(spec, field.path)}
                onChange={(value) => changeField(field, value)}
              />
            ))}
          </details>
        ))}
      </div>
    </aside>
  )
}
