import { useState } from 'react'
import ModCurveCanvas from './ModCurveCanvas.jsx'
import { ModKnob, Field } from './ModControls.jsx'
import { TARGET_SRC_AMOUNT } from './modTargets.js'

// ── VELO / NOTE response-curve editor ────────────────────────────────────────
// A compact editor for the two response curves (input 0..1 → output 0..1).
// Empty = identity; the Linear preset clears back to it. Selected-point tension
// bends its segment. Drag streams through preview(); mouseup commits.

const PRESETS = {
  linear: () => [],   // empty = identity
  invert: () => ([{ x: 0, y: 1, tension: 0 }, { x: 1, y: 0, tension: 0 }]),
}

export default function CurveEditor({ curve, color, preview, commit, label, source = null }) {
  const [selectedIdx, setSelectedIdx] = useState(-1)
  const points = Array.isArray(curve.points) ? curve.points : []
  const selPoint = selectedIdx >= 0 && selectedIdx < points.length ? points[selectedIdx] : null

  const setPointsLive = (pts) => preview({ points: pts })
  const setPointsFinal = (pts) => { preview({ points: pts }); commit() }

  const setSelTensionLive = (tension) => {
    if (!selPoint) return
    setPointsLive(points.map((p, i) => (i === selectedIdx ? { ...p, tension } : p)))
  }
  const setSelTensionFinal = (tension) => {
    if (!selPoint) return
    setPointsFinal(points.map((p, i) => (i === selectedIdx ? { ...p, tension } : p)))
  }

  return (
    <div className="sampler-mod-editor">
      <div className="sampler-mod-editor-head">
        <span className="sampler-mod-tool-label">{label} response</span>
        <div className="sampler-mod-tool-group">
          <button type="button" className="sampler-mod-text-btn" onClick={() => { setPointsFinal(PRESETS.linear()); setSelectedIdx(-1) }}>Linear</button>
          <button type="button" className="sampler-mod-text-btn" onClick={() => { setPointsFinal(PRESETS.invert()); setSelectedIdx(-1) }}>Invert</button>
        </div>
        <div className="sampler-mod-head-spacer" />
        <ModKnob
          label="OUT"
          modTarget={source == null ? null : { target: TARGET_SRC_AMOUNT, index: source, stage: 0, scale: 0.01 }}
          value={(curve.outputAmount ?? 1) * 100}
          min={0} max={100} defaultValue={100}
          size={34} color={color}
          formatValue={(v) => `${Math.round(v)}%`}
          onLiveChange={(v) => preview({ outputAmount: Math.round(v) / 100 })}
          onCommit={(v) => { preview({ outputAmount: Math.round(v) / 100 }); commit() }}
        />
      </div>

      <div className="sampler-mod-curve-layout">
        <div className="sampler-mod-graph-well sampler-mod-graph-well--curve">
          <ModCurveCanvas
            points={points}
            selectedIdx={selectedIdx}
            color={color}
            width={300}
            height={150}
            onPreview={setPointsLive}
            onCommit={setPointsFinal}
            onSelect={setSelectedIdx}
          />
        </div>
        <div className="sampler-mod-curve-side">
          <Field label="TENS">
            <ModKnob
              value={selPoint?.tension || 0} min={-1} max={1} defaultValue={0}
              size={34} dragRange={120} capStyle="soft-disk" color="var(--theme-accent)"
              formatValue={(v) => selPoint ? v.toFixed(2) : '--'}
              onLiveChange={(v) => setSelTensionLive(Number(v.toFixed(3)))}
              onCommit={(v) => setSelTensionFinal(Number(v.toFixed(3)))}
            />
          </Field>
        </div>
      </div>
      <span className="sampler-mod-caption">Double-click to add · drag to move · alt/right-click to delete</span>
    </div>
  )
}
