// Live BS.1770-4 master-bus loudness meter.
//
// The engine tap sits at MixEngine's PostMasterOutput point (post master insert
// chain, post master fader) and is off by default — metering costs an atomic
// load per audio block when disabled and a full K-weighting pass when enabled,
// so the user opts in and the choice persists.
//
// Polling deliberately has no loop of its own: MixerPanel already runs one
// 125 ms poll for the peak meters, and pollMasterLoudness() below hangs off it.
// A second timer would double the IPC wakeups for the same 8 Hz of data.

import { useCallback, useEffect, useState } from 'react'
import { Activity, RotateCcw } from 'lucide-react'
import { PLATFORM_TARGETS } from '../constants/loudnessTargets.js'

// LoudnessAnalyzer::kNoMeasurement. A finite sentinel rather than -Infinity so
// it survives JSON; anything at or below it means "nothing measured yet".
const NO_MEASUREMENT = -200

export const LOUDNESS_ENABLED_KEY = 'xleth.meter.loudnessEnabled'
// Shared with ExportDialog: the platform you are mastering for is the same
// question in both places, so the meter's target marker follows the export
// picker rather than adding a second control that could disagree with it.
const LOUDNESS_TARGET_KEY = 'xleth.export.loudnessTarget'
// 'none' is an export-side choice — "do not renormalize the render" — not a
// mastering target, and it is what ExportDialog defaults to. Treating it as
// "no reference line" would leave the marker invisible for anyone who has ever
// opened the export dialog, so the meter reads it as "unset" and falls back
// here. Any real platform pick still wins.
const DEFAULT_METER_TARGET = 'youtube'

// Bar scale. -50 LUFS is well below anything a master ever sits at, and 0 LUFS
// is the top of the useful range, so a linear map over that span keeps the
// -23 … -9 LUFS region where mastering decisions happen in the upper third.
const SCALE_MIN_LUFS = -50
const SCALE_MAX_LUFS = 0

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

// Called once per peak-poll tick from MixerPanel. No-ops unless the panel is
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

function isMeasured(value) {
  return Number.isFinite(value) && value > NO_MEASUREMENT
}

function formatLevel(value, digits = 1) {
  return isMeasured(value) ? value.toFixed(digits) : '—'
}

// 0 → the bottom of the bar, SCALE_MAX_LUFS → the top. Unmeasured reads empty.
function levelToPercent(lufs) {
  if (!isMeasured(lufs)) return 0
  const span = SCALE_MAX_LUFS - SCALE_MIN_LUFS
  const pos = ((lufs - SCALE_MIN_LUFS) / span) * 100
  return Math.max(0, Math.min(100, pos))
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

// ── Component ───────────────────────────────────────────────────────────────

function LoudnessBar({ label, lufs, targetPercent, targetLabel }) {
  const percent = levelToPercent(lufs)
  return (
    <div className="loudness-meter-bar-row">
      <span className="loudness-meter-bar-label">{label}</span>
      <div className="loudness-meter-bar-track">
        <div className="loudness-meter-bar-fill" style={{ width: `${percent}%` }} />
        {targetPercent != null && (
          <div
            className="loudness-meter-bar-target"
            style={{ left: `${targetPercent}%` }}
            title={targetLabel}
          />
        )}
      </div>
      <span className="loudness-meter-bar-value">{formatLevel(lufs)}</span>
    </div>
  )
}

export default function MasterLoudnessMeter() {
  const [values, setValues] = useState(snapshot)
  const [enabled, setEnabled] = useState(readLoudnessEnabledPreference)
  const [target, setTarget] = useState(resolveTarget)

  // Poll tick: take the new values, and re-resolve the marker only when the
  // shared target key actually changed. The 'storage' event does not fire in
  // the window that wrote the key, so this is what picks up an export-dialog
  // change made while the mixer is open; keeping the old object identity when
  // the key is unchanged stops it re-rendering the marker 8 times a second.
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

  const handleToggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev
      try {
        localStorage.setItem(LOUDNESS_ENABLED_KEY, next ? '1' : '0')
      } catch {
        // no-op: the toggle still applies for this session
      }
      if (!next) publish(EMPTY_SNAPSHOT)
      // Picking up a target the export dialog may have changed since mount.
      setTarget(resolveTarget())
      return next
    })
  }, [])

  const handleReset = useCallback(async () => {
    try {
      await window.xleth?.audio?.resetMasterLoudness?.()
    } catch {
      // no-op: the next poll reports whatever the engine actually holds
    }
    publish(EMPTY_SNAPSHOT)
  }, [])

  const targetPercent = target.targetLufs == null ? null : levelToPercent(target.targetLufs)
  const targetLabel = target.targetLufs == null
    ? 'No platform target selected'
    : `${target.label} target ${target.targetLufs} LUFS`

  // Only a measured peak can be over the ceiling — the sentinel must never read
  // as "under" and light up green either.
  const peakOver = target.maxDbtp != null
    && isMeasured(values.truePeakDbtp)
    && values.truePeakDbtp > target.maxDbtp

  return (
    <div className={`loudness-meter${enabled ? '' : ' loudness-meter--off'}`}>
      <div className="loudness-meter-header">
        <span className="loudness-meter-title">LOUDNESS</span>
        <button
          type="button"
          className={`loudness-meter-btn${enabled ? ' loudness-meter-btn--active' : ''}`}
          onClick={handleToggle}
          aria-pressed={enabled}
          title={enabled ? 'Disable loudness metering' : 'Enable loudness metering'}
        >
          <Activity size={12} />
        </button>
        <button
          type="button"
          className="loudness-meter-btn"
          onClick={handleReset}
          title="Reset integrated / LRA / true peak"
        >
          <RotateCcw size={12} />
        </button>
      </div>

      <div className="loudness-meter-bars">
        <LoudnessBar
          label="M"
          lufs={values.momentary}
          targetPercent={targetPercent}
          targetLabel={targetLabel}
        />
        <LoudnessBar
          label="S"
          lufs={values.shortTerm}
          targetPercent={targetPercent}
          targetLabel={targetLabel}
        />
      </div>

      <div className="loudness-meter-readouts">
        <div className="loudness-meter-readout">
          <span className="loudness-meter-readout-label">I</span>
          <span className="loudness-meter-readout-value">
            {formatLevel(values.integrated)}
            <span className="loudness-meter-unit">LUFS</span>
          </span>
        </div>
        <div className="loudness-meter-readout">
          <span className="loudness-meter-readout-label">LRA</span>
          <span className="loudness-meter-readout-value">
            {isMeasured(values.integrated) ? values.lra.toFixed(1) : '—'}
            <span className="loudness-meter-unit">LU</span>
          </span>
        </div>
        <div className="loudness-meter-readout">
          <span className="loudness-meter-readout-label">TP</span>
          <span
            className={`loudness-meter-readout-value${peakOver ? ' loudness-meter-readout-value--over' : ''}`}
          >
            {formatLevel(values.truePeakDbtp)}
            <span className="loudness-meter-unit">dBTP</span>
          </span>
        </div>
      </div>

      <div className="loudness-meter-target" title={targetLabel}>
        {target.targetLufs == null
          ? `${target.label} — no target`
          : `${target.label} · ${target.targetLufs} LUFS · ${target.maxDbtp} dBTP`}
      </div>
    </div>
  )
}
