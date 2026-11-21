import { useEffect, useMemo, useRef, useState } from 'react'
import { NumberBox, SegmentedControl, formatValue } from '../../ui-kit'
import { tokenValue } from '../../theming/tokenValue.ts'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import {
  STRENGTH_MAX, STRENGTH_MIN, keysOfChannel, laneRange, matchPreset, noteSpan, scalePresetKeys,
  sortNoteKeys, valueAtNote, valueToUnit, zoneSpan,
} from '../../lensRoam/lensKeyModel.js'
import styles from '../inspector/Inspector.module.css'
import lens from './lensRoam.module.css'

// The Simple Lens controls for a Pattern Track source's hit curve: the four
// presets, Strength, Short notes. (Docs/XLETH_LENS_ROAM_SPEC.md, "Hit curve
// presets".) The preset keys come from the engine (timeline_getHitPresets); a
// curve that is not exactly a scaled preset is "Custom", and Strength waits for a
// preset to scale.

const SHORT_NOTE_OPTIONS = [
  { value: 'Squash', label: 'Squash', hint: 'A note shorter than the head plus the tail plays all of it, squeezed to fit. The default.' },
  { value: 'Cut', label: 'Cut', hint: 'A note shorter than the head plus the tail keeps the tail whole and cuts the head short.' },
]

const REFERENCE_NOTE_TICKS = 960   // the sparkline's note: a quarter

function Row({ label, children }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <div className={styles.rowControl}>{children}</div>
    </div>
  )
}

const strengthFmt = {
  format: (v) => formatValue(v * 100, '%', { decimals: 0 }),
  parse: (t) => { const n = Number.parseFloat(String(t).replace(/%/g, '').replace(/−/g, '-')); return Number.isFinite(n) ? n / 100 : null },
}

/** The zoom curve of a hit curve over one reference note: read-only, drawn from the real keys. */
function HitCurveSparkline({ keys, zones }) {
  const epoch = useThemeEpoch()
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const [width, setWidth] = useState(260)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return undefined
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width
      if (w && w > 40) setWidth(Math.round(w))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const H = 44
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(H * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const g0 = tokenValue('--ui-g0'); const g1 = tokenValue('--ui-g1'); const g3 = tokenValue('--ui-g3')
    const inkC = tokenValue('--ui-ink'); const ink3 = tokenValue('--ui-ink-3')
    ctx.fillStyle = g0
    ctx.fillRect(0, 0, width, H)
    const span = noteSpan(REFERENCE_NOTE_TICKS, zones)
    const x0 = 6
    const w = width - 12
    const xOf = (t) => x0 + (t / REFERENCE_NOTE_TICKS) * w
    ;['Head', 'Body', 'Tail'].forEach((z) => {
      const [lo, hi] = zoneSpan(span, z)
      if (hi - lo < 1e-6) return
      ctx.fillStyle = z === 'Body' ? g0 : g1
      ctx.fillRect(xOf(lo), 0, xOf(hi) - xOf(lo), H)
    })
    const zoomKeys = sortNoteKeys(keysOfChannel(keys, 'zoom'), zones)
    const samples = []
    for (let x = x0; x <= x0 + w; x += 2) samples.push(valueAtNote(zoomKeys, span, ((x - x0) / w) * REFERENCE_NOTE_TICKS, 1))
    const range = laneRange('zoom', [...samples, ...zoomKeys.map((k) => k.value)])
    const y = (v) => 4 + (1 - Math.min(Math.max(valueToUnit(range, v), 0), 1)) * (H - 8)
    ctx.fillStyle = g3
    ctx.fillRect(x0, Math.round(y(1)), w, 1)
    ctx.beginPath()
    samples.forEach((v, i) => { const x = x0 + i * 2; if (i === 0) ctx.moveTo(x, y(v)); else ctx.lineTo(x, y(v)) })
    ctx.strokeStyle = zoomKeys.length ? inkC : ink3
    ctx.lineWidth = 1.5
    ctx.stroke()
  }, [keys, zones, width, epoch])

  return (
    <div ref={wrapRef} className={lens.sparkline} data-theme-epoch={epoch}>
      <canvas
        ref={canvasRef}
        style={{ width, height: H, display: 'block' }}
        data-testid="lens-hit-sparkline"
        role="img"
        aria-label="The hit curve's zoom over a quarter note, with the Head, Body and Tail bands"
      />
    </div>
  )
}

/**
 * @param {object} props
 * @param {{curve: {keys: object[], zones: object}|null, write: Function, applyPreset: Function}} props.source  useSourceCurve()
 * @param {{name: string, keys: object[]}[]|null} props.presets   from the engine
 */
export default function LensHitControls({ source, presets }) {
  const { curve, write, applyPreset } = source
  const [strengthDraft, setStrengthDraft] = useState(null)
  const ready = !!curve && !!presets
  const keys = curve?.keys ?? []
  const match = useMemo(() => (ready ? matchPreset(keys, presets) : null), [ready, keys, presets])
  const preset = match ? presets.find((p) => p.name === match.name) : null
  const canScale = !!preset && preset.keys.length > 0
  const shownStrength = strengthDraft ?? match?.strength ?? 1
  const previewKeys = strengthDraft != null && preset ? scalePresetKeys(preset.keys, strengthDraft) : keys

  const options = (presets ?? []).map((p) => ({
    value: p.name,
    label: p.name,
    hint: p.keys.length === 0
      ? 'No hit animation: every note holds the framing.'
      : `Every note plays the ${p.name} animation on its zoom. Notes set to Own keep their own curve.`,
  }))

  return (
    <div data-testid="lens-hit-controls">
      <Row label="Hit curve">
        {ready ? (
          <SegmentedControl
            size="sm" label="Hit curve preset" options={options} className={lens.presetGrid}
            value={match?.name ?? '__custom'}
            onChange={(name) => { setStrengthDraft(null); applyPreset(name) }}
            hint="The animation every note of this source plays when it hits. Presets only; Advanced edits the keys."
          />
        ) : (
          <span className={lens.note}>{presets === null ? 'Presets unavailable' : 'Loading…'}</span>
        )}
      </Row>
      {ready && !match && (
        <p className={lens.note} data-testid="lens-hit-custom">Custom curve. Pick a preset to start over from it.</p>
      )}
      <Row label="Strength">
        <NumberBox
          label="Hit curve strength" hideLabel width={88}
          min={STRENGTH_MIN} max={STRENGTH_MAX} defaultValue={1}
          value={shownStrength} format={strengthFmt.format} parse={strengthFmt.parse}
          disabled={!canScale}
          onChange={(s) => setStrengthDraft(s)}
          onCommit={(s) => {
            setStrengthDraft(null)
            if (preset) write(scalePresetKeys(preset.keys, s))
          }}
          onCancel={() => setStrengthDraft(null)}
          hint={canScale
            ? 'How far the preset moves the picture. 100 % is the preset as designed.'
            : 'Pick a preset with motion to scale it. Still has none, and a custom curve is edited in Advanced.'}
        />
      </Row>
      <Row label="Short notes">
        <SegmentedControl
          size="sm" label="Short notes" options={SHORT_NOTE_OPTIONS}
          value={curve?.zones?.shortNote === 'Cut' ? 'Cut' : 'Squash'}
          disabled={!curve}
          onChange={(shortNote) => write(keys, { shortNote })}
          hint="What a note shorter than the head plus the tail does with the curve."
        />
      </Row>
      {ready && <HitCurveSparkline keys={previewKeys} zones={curve.zones} />}
    </div>
  )
}
