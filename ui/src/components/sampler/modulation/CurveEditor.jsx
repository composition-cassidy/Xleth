import { useState } from 'react'
import { Button, NumberBox } from '../../../ui-kit'
import { ModNumberBox } from '../kitMod.jsx'
import { formatSigned2, parseOffset } from '../samplerFormat.js'
import ModCurveCanvas from './ModCurveCanvas.jsx'
import { useBoxSize } from './useBoxSize.js'
import { TARGET_SRC_AMOUNT } from './modTargets.js'
import styles from '../Sampler.module.css'

// ── Velocity / Note response curve ───────────────────────────────────────────
// Input 0..1 → output 0..1. Empty = identity; Linear clears back to it. The
// selected point's tension bends its segment. Drag streams through preview();
// release commits.

const PRESETS = {
  linear: () => [],   // empty = identity
  invert: () => ([{ x: 0, y: 1, tension: 0 }, { x: 1, y: 0, tension: 0 }]),
}

export default function CurveEditor({ curve, color, preview, commit, label, source = null }) {
  const [selectedIdx, setSelectedIdx] = useState(-1)
  const [wellRef, size] = useBoxSize({ width: 300, height: 150 })
  const points = Array.isArray(curve.points) ? curve.points : []
  const selPoint = selectedIdx >= 0 && selectedIdx < points.length ? points[selectedIdx] : null

  const setPointsLive = (pts) => preview({ points: pts })
  const setPointsFinal = (pts) => { preview({ points: pts }); commit() }
  const withTension = (tension) => points.map((p, i) => (i === selectedIdx ? { ...p, tension } : p))

  return (
    <div className={styles.editor} data-editor="curve">
      <div className={styles.editorHead}>
        <Button size="sm" onClick={() => { setPointsFinal(PRESETS.linear()); setSelectedIdx(-1) }}
          hint={`${label} passes through unchanged`}>Linear</Button>
        <Button size="sm" onClick={() => { setPointsFinal(PRESETS.invert()); setSelectedIdx(-1) }}
          hint={`High ${label.toLowerCase()} gives a low output, and the reverse`}>Invert</Button>
        <NumberBox
          label="Tension" width={112} min={-1} max={1} step={0.01} defaultValue={0} bipolar
          disabled={!selPoint}
          format={(v) => (selPoint ? formatSigned2(v) : '—')} parse={parseOffset}
          value={selPoint?.tension || 0}
          onChange={(v) => { if (selPoint) setPointsLive(withTension(Number(v.toFixed(3)))) }}
          onCommit={(v) => { if (selPoint) setPointsFinal(withTension(Number(v.toFixed(3)))) }}
          hint="Bend of the segment after the selected point"
          data-curve-field="tension"
        />
        <span className={styles.spacer} />
        <ModNumberBox
          label="Out" width={96} min={0} max={100} unit="%" defaultValue={100} quantize={(v) => Math.round(v)}
          modTarget={source == null ? null : { target: TARGET_SRC_AMOUNT, index: source, stage: 0, scale: 0.01 }}
          value={(curve.outputAmount ?? 1) * 100}
          onChange={(v) => preview({ outputAmount: Math.round(v) / 100 })}
          onCommit={(v) => { preview({ outputAmount: Math.round(v) / 100 }); commit() }}
          hint={`Output: scales everything ${label.toLowerCase()} drives`}
          data-curve-field="outputAmount"
        />
      </div>
      <div
        className={`${styles.editorWell} ${styles.curveWell}`}
        ref={wellRef}
        data-hint={`${label} response: input across, output up`}
        data-hint-mods="Double-click: add a point · Drag: move · Alt+click or right-click: delete"
      >
        <ModCurveCanvas
          points={points}
          selectedIdx={selectedIdx}
          color={color}
          width={size.width}
          height={size.height}
          onPreview={setPointsLive}
          onCommit={setPointsFinal}
          onSelect={setSelectedIdx}
        />
      </div>
    </div>
  )
}
