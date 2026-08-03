import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, RotateCcw } from 'lucide-react'
import XlethSelect from '../common/XlethSelect.jsx'

export const LINEAR_TRANSITION_CURVE = Object.freeze({ x1: 0, y1: 0, x2: 1, y2: 1 })

export const TRANSITION_EASING_PRESETS = Object.freeze({
  linear:    Object.freeze({ label: 'Linear',      curve: LINEAR_TRANSITION_CURVE }),
  easeIn:    Object.freeze({ label: 'Ease In',     curve: Object.freeze({ x1: 0.42, y1: 0, x2: 1, y2: 1 }) }),
  easeOut:   Object.freeze({ label: 'Ease Out',    curve: Object.freeze({ x1: 0, y1: 0, x2: 0.58, y2: 1 }) }),
  easeInOut: Object.freeze({ label: 'Ease In-Out', curve: Object.freeze({ x1: 0.42, y1: 0, x2: 0.58, y2: 1 }) }),
})

const PRESET_OPTIONS = [
  { value: 'custom', label: 'Custom', disabled: true },
  ...Object.entries(TRANSITION_EASING_PRESETS).map(([value, preset]) => ({
    value, label: preset.label,
  })),
]

const clampUnit = (value) => Math.min(1, Math.max(0, value))

export function normalizeTransitionCurve(raw) {
  if (!raw || typeof raw !== 'object'
      || !Object.keys(LINEAR_TRANSITION_CURVE).every((key) => Number.isFinite(raw[key]))) {
    return { ...LINEAR_TRANSITION_CURVE }
  }
  return {
    x1: clampUnit(raw.x1),
    y1: clampUnit(raw.y1),
    x2: clampUnit(raw.x2),
    y2: clampUnit(raw.y2),
  }
}

export function normalizeTransitionEasing(raw) {
  const easing = raw && typeof raw === 'object' ? raw : {}
  return {
    startToPin: normalizeTransitionCurve(easing.startToPin),
    pinToEnd: normalizeTransitionCurve(easing.pinToEnd),
  }
}

function curvePresetValue(curve) {
  const normalized = normalizeTransitionCurve(curve)
  for (const [value, preset] of Object.entries(TRANSITION_EASING_PRESETS)) {
    if (Object.keys(LINEAR_TRANSITION_CURVE).every(
      (key) => Math.abs(normalized[key] - preset.curve[key]) < 1e-6,
    )) return value
  }
  return 'custom'
}

const WIDTH = 176
const HEIGHT = 96
const PAD = 10
const START = { x: PAD, y: HEIGHT - PAD }
const PIN = { x: WIDTH / 2, y: HEIGHT / 2 }
const END = { x: WIDTH - PAD, y: PAD }
const HALF_WIDTH = PIN.x - START.x
const HALF_HEIGHT = START.y - PIN.y

function controlPoint(side, point, curve) {
  const x = point === 1 ? curve.x1 : curve.x2
  const y = point === 1 ? curve.y1 : curve.y2
  if (side === 'startToPin') {
    return { x: START.x + HALF_WIDTH * x, y: START.y - HALF_HEIGHT * y }
  }
  return { x: PIN.x + HALF_WIDTH * x, y: PIN.y - HALF_HEIGHT * y }
}

function curvePath(easing) {
  const a1 = controlPoint('startToPin', 1, easing.startToPin)
  const a2 = controlPoint('startToPin', 2, easing.startToPin)
  const b1 = controlPoint('pinToEnd', 1, easing.pinToEnd)
  const b2 = controlPoint('pinToEnd', 2, easing.pinToEnd)
  return `M ${START.x} ${START.y} C ${a1.x} ${a1.y}, ${a2.x} ${a2.y}, ${PIN.x} ${PIN.y} C ${b1.x} ${b1.y}, ${b2.x} ${b2.y}, ${END.x} ${END.y}`
}

function pointFromPointer(side, clientX, clientY, svg) {
  const rect = svg.getBoundingClientRect()
  const scaleX = WIDTH / Math.max(1, rect.width)
  const scaleY = HEIGHT / Math.max(1, rect.height)
  const x = (clientX - rect.left) * scaleX
  const y = (clientY - rect.top) * scaleY
  if (side === 'startToPin') {
    return {
      x: clampUnit((x - START.x) / HALF_WIDTH),
      y: clampUnit((START.y - y) / HALF_HEIGHT),
    }
  }
  return {
    x: clampUnit((x - PIN.x) / HALF_WIDTH),
    y: clampUnit((PIN.y - y) / HALF_HEIGHT),
  }
}

export default function SnapshotTransitionBezierEditor({ easing, onChange }) {
  const normalized = normalizeTransitionEasing(easing)
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState(normalized)
  const draftRef = useRef(normalized)
  const svgRef = useRef(null)
  const draggingRef = useRef(null)

  const replaceDraft = useCallback((next) => {
    const safe = normalizeTransitionEasing(next)
    draftRef.current = safe
    setDraft(safe)
    return safe
  }, [])

  useEffect(() => {
    if (!draggingRef.current) replaceDraft(easing)
  }, [easing, replaceDraft])

  const commit = useCallback((next) => {
    const safe = replaceDraft(next)
    onChange?.(safe)
  }, [onChange, replaceDraft])

  const startDrag = useCallback((side, point) => (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    draggingRef.current = { side, point, pointerId: event.pointerId }
    svgRef.current?.setPointerCapture?.(event.pointerId)
  }, [])

  const handlePointerMove = useCallback((event) => {
    const drag = draggingRef.current
    const svg = svgRef.current
    if (!drag || drag.pointerId !== event.pointerId || !svg) return
    const value = pointFromPointer(drag.side, event.clientX, event.clientY, svg)
    const curve = { ...draftRef.current[drag.side] }
    curve[`x${drag.point}`] = value.x
    curve[`y${drag.point}`] = value.y
    replaceDraft({ ...draftRef.current, [drag.side]: curve })
  }, [replaceDraft])

  const finishDrag = useCallback((event) => {
    const drag = draggingRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    draggingRef.current = null
    svgRef.current?.releasePointerCapture?.(event.pointerId)
    commit(draftRef.current)
  }, [commit])

  const handleKey = useCallback((side, point) => (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    const amount = event.shiftKey ? 0.1 : 0.01
    const curve = { ...draftRef.current[side] }
    const xKey = `x${point}`
    const yKey = `y${point}`
    if (event.key === 'ArrowLeft') curve[xKey] -= amount
    if (event.key === 'ArrowRight') curve[xKey] += amount
    if (event.key === 'ArrowDown') curve[yKey] -= amount
    if (event.key === 'ArrowUp') curve[yKey] += amount
    commit({ ...draftRef.current, [side]: curve })
  }, [commit])

  const applyPreset = useCallback((side, presetKey) => {
    const preset = TRANSITION_EASING_PRESETS[presetKey]
    if (!preset) return
    commit({ ...draftRef.current, [side]: { ...preset.curve } })
  }, [commit])

  const points = {
    a1: controlPoint('startToPin', 1, draft.startToPin),
    a2: controlPoint('startToPin', 2, draft.startToPin),
    b1: controlPoint('pinToEnd', 1, draft.pinToEnd),
    b2: controlPoint('pinToEnd', 2, draft.pinToEnd),
  }

  const renderHandle = (key, side, point, anchor) => {
    const cp = points[key]
    const curve = draft[side]
    return (
      <g key={key}>
        <line className="vmt-easing-guide" x1={anchor.x} y1={anchor.y} x2={cp.x} y2={cp.y} />
        <circle
          className={'vmt-easing-control'
            + (key === 'a2' ? ' is-pin-outer' : '')
            + (key === 'b1' ? ' is-pin-inner' : '')}
          cx={cp.x}
          cy={cp.y}
          r={key === 'a2' ? 7 : key === 'b1' ? 4 : 5}
          role="slider"
          tabIndex="0"
          aria-label={`${side === 'startToPin' ? 'Start to pin' : 'Pin to end'} control point ${point}`}
          aria-valuemin="0"
          aria-valuemax="1"
          aria-valuenow={curve[`x${point}`]}
          aria-valuetext={`x ${Math.round(curve[`x${point}`] * 100)}%, y ${Math.round(curve[`y${point}`] * 100)}%`}
          onPointerDown={startDrag(side, point)}
          onKeyDown={handleKey(side, point)}
        />
      </g>
    )
  }

  return (
    <div className={'vmt-easing-editor' + (expanded ? ' is-expanded' : '')}>
      <button
        type="button"
        className="vmt-easing-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span>Easing</span>
        <svg className="vmt-easing-mini" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} aria-hidden="true">
          <path d={curvePath(draft)} />
        </svg>
        <ChevronDown size={13} aria-hidden="true" />
      </button>

      {expanded && (
        <div className="vmt-easing-expanded">
          <svg
            ref={svgRef}
            className="vmt-easing-graph"
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            role="group"
            aria-label="Snapshot transition easing curves"
            onPointerMove={handlePointerMove}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
          >
            <line className="vmt-easing-grid" x1={PIN.x} y1={PAD} x2={PIN.x} y2={HEIGHT - PAD} />
            <line className="vmt-easing-grid" x1={PAD} y1={PIN.y} x2={WIDTH - PAD} y2={PIN.y} />
            <line className="vmt-easing-linear" x1={START.x} y1={START.y} x2={END.x} y2={END.y} />
            <path className="vmt-easing-path" d={curvePath(draft)} />
            {renderHandle('a1', 'startToPin', 1, START)}
            {renderHandle('a2', 'startToPin', 2, PIN)}
            {renderHandle('b1', 'pinToEnd', 1, PIN)}
            {renderHandle('b2', 'pinToEnd', 2, END)}
            <circle className="vmt-easing-anchor" cx={START.x} cy={START.y} r="3" />
            <circle className="vmt-easing-anchor is-pin" cx={PIN.x} cy={PIN.y} r="2" />
            <circle className="vmt-easing-anchor" cx={END.x} cy={END.y} r="3" />
            <text className="vmt-easing-label" x={START.x} y={HEIGHT - 1}>Start</text>
            <text className="vmt-easing-label" x={PIN.x} y={HEIGHT - 1} textAnchor="middle">Pin</text>
            <text className="vmt-easing-label" x={END.x} y={HEIGHT - 1} textAnchor="end">End</text>
          </svg>

          <div className="vmt-easing-presets">
            <label>
              <span>Start → Pin</span>
              <XlethSelect
                className="vmt-easing-preset-select"
                value={curvePresetValue(draft.startToPin)}
                options={PRESET_OPTIONS}
                onChange={(value) => applyPreset('startToPin', value)}
                ariaLabel="Start to pin easing preset"
              />
            </label>
            <label>
              <span>Pin → End</span>
              <XlethSelect
                className="vmt-easing-preset-select"
                value={curvePresetValue(draft.pinToEnd)}
                options={PRESET_OPTIONS}
                onChange={(value) => applyPreset('pinToEnd', value)}
                ariaLabel="Pin to end easing preset"
              />
            </label>
          </div>
          <button
            type="button"
            className="vmt-easing-reset"
            onClick={() => commit(normalizeTransitionEasing())}
          >
            <RotateCcw size={11} aria-hidden="true" />
            Reset both to Linear
          </button>
        </div>
      )}
    </div>
  )
}
