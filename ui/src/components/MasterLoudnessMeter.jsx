// Live BS.1770-4 master-bus loudness dock (Mixer tab, fixed at the right).
//
// The engine tap sits at MixerEngine's PostMasterOutput point (post master insert
// chain, post master fader) and is off by default: metering costs an atomic load
// per audio block when disabled and a full K-weighting pass when enabled, so the
// user opts in and the choice persists.
//
// Polling deliberately has no loop of its own: MixerPanel already runs one
// 125 ms poll for the peak meters, and pollMasterLoudness() below hangs off it.
// A second timer would double the IPC wakeups for the same 8 Hz of data.
//
// Nothing here is a placeholder: while the meter is off or nothing has been
// measured, every value reads "—" with its unit, and the bars are not drawn.

import { useCallback, useEffect, useRef, useState } from 'react'
import { IconButton, Select, Toggle, formatValue } from '../ui-kit'
import { tokenValue } from '../theming/tokenValue.ts'
import { useThemeEpoch } from '../theming/useThemeEpoch.js'
import { PLATFORM_TARGETS } from '../constants/loudnessTargets.js'
import useMixerUiStore from './mixer/mixerUiStore.js'
import styles from './MasterLoudnessMeter.module.css'
import { iconComponent } from '../ui-kit/icons'

const IcArrowCounterClockwise = iconComponent('arrow-counter-clockwise')
const IcCaretDoubleLeft = iconComponent('caret-double-left')
const IcCaretDoubleRight = iconComponent('caret-double-right')

// LoudnessAnalyzer::kNoMeasurement. A finite sentinel rather than -Infinity so
// it survives JSON; anything at or below it means "nothing measured yet".
const NO_MEASUREMENT = -200

export const LOUDNESS_ENABLED_KEY = 'xleth.meter.loudnessEnabled'
// Shared with ExportDialog: the platform you are mastering for is the same
// question in both places, so the meter's target follows the export picker
// rather than adding a second control that could disagree with it.
const LOUDNESS_TARGET_KEY = 'xleth.export.loudnessTarget'
// 'none' is an export-side choice (do not renormalize the render), not a
// mastering target, and it is what ExportDialog defaults to. The meter reads it as
// "unset" and falls back here; any real platform pick still wins.
const DEFAULT_METER_TARGET = 'youtube'

// Bar scale. -50 LUFS is well below anything a master sits at and 0 LUFS is the
// top of the useful range, so the -23 ... -9 LUFS region where mastering
// decisions happen sits in the upper half.
const SCALE_MIN_LUFS = -50
const SCALE_MAX_LUFS = 0
const SCALE_TICKS = [-48, -36, -24, -12, 0]
const TARGET_OPTIONS = Object.entries(PLATFORM_TARGETS)
  .filter(([key]) => key !== 'none')
  .map(([key, t]) => ({ value: key, label: t.label }))

const EMPTY_SNAPSHOT = {
  enabled: false,
  momentary: NO_MEASUREMENT,
  shortTerm: NO_MEASUREMENT,
  integrated: NO_MEASUREMENT,
  momentaryMax: NO_MEASUREMENT,
  shortTermMax: NO_MEASUREMENT,
  lra: 0,
  truePeakDbtp: NO_MEASUREMENT,
}

// ── Shared snapshot, published by the mixer's peak-poll loop ─────────────────

let snapshot = EMPTY_SNAPSHOT
const listeners = new Set()

function publish(next) {
  snapshot = next
  for (const fn of listeners) fn(next)
}

export function readLoudnessEnabledPreference() {
  try {
    return localStorage.getItem(LOUDNESS_ENABLED_KEY) === '1'
  } catch {
    return false
  }
}

// Called once per peak-poll tick from MixerPanel. No-ops unless the dock is
// mounted and the meter is switched on, so the disabled path costs nothing on
// either side of the bridge.
export async function pollMasterLoudness() {
  if (listeners.size === 0) return
  if (!readLoudnessEnabledPreference()) {
    if (snapshot !== EMPTY_SNAPSHOT) publish(EMPTY_SNAPSHOT)
    return
  }
  try {
    const data = await window.xleth?.audio?.getMasterLoudness?.()
    publish(data && typeof data === 'object' ? data : EMPTY_SNAPSHOT)
  } catch {
    publish(EMPTY_SNAPSHOT)
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function isMeasured(value) {
  return Number.isFinite(value) && value > NO_MEASUREMENT
}

/** "−14.2" with a true minus and one decimal, or "—" when nothing has been measured. */
export function levelText(value) {
  return isMeasured(value) ? formatValue(value, 'dB', { unitless: true }) : '—'
}

// 0 → the left of the bar, SCALE_MAX_LUFS → the right. Unmeasured reads empty.
export function levelToFraction(lufs) {
  if (!isMeasured(lufs)) return 0
  const span = SCALE_MAX_LUFS - SCALE_MIN_LUFS
  return Math.max(0, Math.min(1, (lufs - SCALE_MIN_LUFS) / span))
}

function resolveTarget() {
  let key = DEFAULT_METER_TARGET
  try {
    const saved = localStorage.getItem(LOUDNESS_TARGET_KEY)
    if (saved && saved !== 'none' && PLATFORM_TARGETS[saved]) key = saved
  } catch {
    // no-op: fall back to the default target
  }
  return { key, ...PLATFORM_TARGETS[key] }
}

// ── Bars: one canvas, M and S, a printed LUFS scale and the target tick ──────

const BAR_H = 10
const BAR_GAP = 4
const LABEL_W = 12
const SCALE_H = 12
export const BARS_H = BAR_H * 2 + BAR_GAP + SCALE_H + 2

export function drawBars(ctx, { width, momentary, shortTerm, targetLufs, palette }) {
  ctx.clearRect(0, 0, width, BARS_H)
  const x0 = LABEL_W
  const w = width - LABEL_W
  ctx.font = `10px ${palette.font}`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  const rows = [['M', momentary, 0], ['S', shortTerm, BAR_H + BAR_GAP]]
  for (const [label, lufs, y] of rows) {
    ctx.fillStyle = palette.well
    ctx.fillRect(x0, y, w, BAR_H)
    const fraction = levelToFraction(lufs)
    if (fraction > 0) {
      ctx.fillStyle = palette.fill
      ctx.fillRect(x0, y, Math.round(w * fraction), BAR_H)
    }
    ctx.fillStyle = palette.label
    ctx.fillText(label, 0, y + BAR_H / 2)
  }
  const scaleY = BAR_H * 2 + BAR_GAP + 2
  ctx.textAlign = 'center'
  for (const db of SCALE_TICKS) {
    const x = x0 + w * levelToFraction(db)
    ctx.fillStyle = palette.tick
    ctx.fillRect(Math.round(x), scaleY, 1, 3)
    ctx.fillText(String(db).replace('-', '−'), Math.min(width - 8, Math.max(x0 + 6, x)), scaleY + 8)
  }
  if (targetLufs != null) {
    const x = Math.round(x0 + w * levelToFraction(targetLufs))
    ctx.fillStyle = palette.target
    ctx.fillRect(x, 0, 1, BAR_H * 2 + BAR_GAP)
  }
}

function LoudnessBars({ values, targetLufs }) {
  const epoch = useThemeEpoch()
  const canvasRef = useRef(null)
  const drawRef = useRef(null)

  useEffect(() => {
    drawRef.current = () => {
      const canvas = canvasRef.current
      const ctx = canvas?.getContext?.('2d')
      if (!canvas || !ctx) return
      const width = canvas.clientWidth
      if (width <= 0) return
      const dpr = window.devicePixelRatio || 1
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(BARS_H * dpr)) {
        canvas.width = Math.round(width * dpr)
        canvas.height = Math.round(BARS_H * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      // Read at draw time: tokenValue() is empty before the ThemeProvider mounts.
      drawBars(ctx, {
        width,
        momentary: values.momentary,
        shortTerm: values.shortTerm,
        targetLufs,
        palette: {
          well: tokenValue('--ui-g0'),
          fill: tokenValue('--ui-value'),
          label: tokenValue('--ui-ink-2'),
          tick: tokenValue('--ui-ink-3'),
          target: tokenValue('--ui-ink'),
          font: tokenValue('--ui-font'),
        },
      })
    }
    drawRef.current()
  }, [values, targetLufs, epoch])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => drawRef.current?.())
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className={styles.bars}
      style={{ height: BARS_H }}
      role="img"
      aria-label={`Momentary ${levelText(values.momentary)} LUFS, short-term ${levelText(values.shortTerm)} LUFS`}
    />
  )
}

// ── Component ───────────────────────────────────────────────────────────────

function Readout({ label, value, unit, over, hint }) {
  return (
    <div className={styles.readout} data-hint={hint}>
      <span className={styles.readoutLabel}>{label}</span>
      <span className={styles.readoutValue} data-over={over || undefined}>
        {value}
        <span className={styles.unit}>{unit}</span>
        {over ? <span className={styles.overFlag}>Over</span> : null}
      </span>
    </div>
  )
}

export default function MasterLoudnessMeter() {
  const [values, setValues] = useState(snapshot)
  const [enabled, setEnabled] = useState(readLoudnessEnabledPreference)
  const [target, setTarget] = useState(resolveTarget)
  // While metering is off the dock is a 28px rail unless the user opened it (the choice is
  // kept, renderer-only). While metering is on it is always open: a running meter is shown.
  const userOpen = useMixerUiStore(s => s.loudnessDockOpen)
  const setUserOpen = useMixerUiStore(s => s.setLoudnessDockOpen)

  // Poll tick: take the new values, and re-resolve the target only when the
  // shared key actually changed. The 'storage' event does not fire in the window
  // that wrote the key, so this is what picks up an export-dialog change made
  // while the mixer is open; keeping the old object identity when the key is
  // unchanged stops it re-rendering the target 8 times a second.
  const onSnapshot = useCallback((next) => {
    setValues(next)
    setTarget((prev) => {
      const resolved = resolveTarget()
      return resolved.key === prev.key ? prev : resolved
    })
  }, [])

  useEffect(() => {
    listeners.add(onSnapshot)
    setValues(snapshot)
    return () => {
      listeners.delete(onSnapshot)
    }
  }, [onSnapshot])

  // The engine always boots with the meter off, so a persisted "on" has to be
  // pushed back down once the bridge is up.
  useEffect(() => {
    window.xleth?.audio?.setMasterLoudnessEnabled?.(enabled)
  }, [enabled])

  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === LOUDNESS_TARGET_KEY) setTarget(resolveTarget())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const handleToggle = useCallback((next) => {
    setEnabled(next)
    try {
      localStorage.setItem(LOUDNESS_ENABLED_KEY, next ? '1' : '0')
    } catch {
      // no-op: the toggle still applies for this session
    }
    if (!next) publish(EMPTY_SNAPSHOT)
    // Picking up a target the export dialog may have changed since mount.
    setTarget(resolveTarget())
  }, [])

  const handleReset = useCallback(async () => {
    try {
      await window.xleth?.audio?.resetMasterLoudness?.()
    } catch {
      // no-op: the next poll reports whatever the engine actually holds
    }
    publish(EMPTY_SNAPSHOT)
  }, [])

  const handleTarget = useCallback((key) => {
    try {
      localStorage.setItem(LOUDNESS_TARGET_KEY, key)
    } catch {
      // no-op: the choice still applies for this session
    }
    setTarget(resolveTarget())
  }, [])

  // Only a measured peak can be over the ceiling; the sentinel must never read as "under".
  const peakOver = target.maxDbtp != null
    && isMeasured(values.truePeakDbtp)
    && values.truePeakDbtp > target.maxDbtp
  const lraText = isMeasured(values.integrated) ? formatValue(values.lra, 'dB', { unitless: true }) : '—'
  const targetText = target.targetLufs == null ? '—' : formatValue(target.targetLufs, 'dB', { unitless: true })
  const ceilingText = target.maxDbtp == null ? '—' : formatValue(target.maxDbtp, 'dB', { unitless: true })

  if (!enabled && !userOpen) {
    return (
      <section className={styles.rail} aria-label="Loudness, collapsed" data-testid="loudness-rail">
        <button
          type="button"
          className={styles.railButton}
          aria-expanded={false}
          aria-label="Open the loudness dock. Metering is off"
          data-hint="Loudness: BS.1770-4 metering of the master bus. Metering is off."
          data-hint-mods="Click: open the dock"
          onClick={() => setUserOpen(true)}
        >
          <IcCaretDoubleLeft size={14} aria-hidden="true" />
          <span className={styles.railText}>Loudness</span>
          <span className={styles.railState}>Off</span>
        </button>
      </section>
    )
  }

  return (
    <section className={styles.dock} aria-label="Loudness">
      <header className={styles.header}>
        <span className={styles.title}>Loudness</span>
        <Toggle
          size="sm" on={enabled} onChange={handleToggle}
          hint={enabled ? 'Master loudness metering is on. Click to turn it off.' : 'Turn on BS.1770-4 loudness metering of the master bus.'}
        >{enabled ? 'On' : 'Off'}</Toggle>
        <IconButton
          size="sm" label="Reset loudness" onClick={handleReset}
          hint="Reset integrated loudness, loudness range and true peak"
        ><IcArrowCounterClockwise size={14} aria-hidden="true" /></IconButton>
        {enabled ? null : (
          <IconButton
            size="sm" label="Collapse the loudness dock" onClick={() => setUserOpen(false)}
            hint="Collapse the loudness dock to a rail. It opens again when metering is turned on."
          ><IcCaretDoubleRight size={14} aria-hidden="true" /></IconButton>
        )}
      </header>

      <div className={styles.row}>
        <span className={styles.rowLabel}>Target</span>
        <Select
          size="sm" className={styles.target} ariaLabel="Loudness target" value={target.key}
          options={TARGET_OPTIONS} onChange={handleTarget}
          hint="Platform target for the marker and the true-peak ceiling. Shared with the export dialog."
        />
      </div>

      {enabled
        ? <LoudnessBars values={values} targetLufs={target.targetLufs} />
        : <p className={styles.status} role="status">Metering is off. Turn it on to measure the master bus.</p>}

      <div className={styles.readouts}>
        <Readout label="Momentary" value={levelText(values.momentary)} unit="LUFS" hint="Momentary loudness, 400 ms" />
        <Readout label="Short-term" value={levelText(values.shortTerm)} unit="LUFS" hint="Short-term loudness, 3 s" />
        <Readout label="Integrated" value={levelText(values.integrated)} unit="LUFS" hint="Integrated loudness since the last reset" />
        <Readout label="Range" value={lraText} unit="LU" hint="Loudness range since the last reset" />
        <Readout
          label="True peak" value={levelText(values.truePeakDbtp)} unit="dBTP" over={peakOver}
          hint="True peak since the last reset. Flagged when it is over the target ceiling."
        />
      </div>

      <div className={styles.targets}>
        <Readout label="Target" value={targetText} unit="LUFS" hint={`${target.label} loudness target`} />
        <Readout label="Ceiling" value={ceilingText} unit="dBTP" hint={`${target.label} true-peak ceiling`} />
      </div>

    </section>
  )
}
