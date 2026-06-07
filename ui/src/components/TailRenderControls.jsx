import React, { useCallback, useEffect, useState } from 'react'
import useLoopRegionStore from '../stores/loopRegionStore.js'

// ── TailRenderControls (Phase 3A) ─────────────────────────────────────────────
// Shared export-dialog controls for the project LoopRegion tail policy. The tail
// settings live in the LoopRegion (project state), so edits route through the
// existing undo-tracked mutation path (timeline.setLoopRegion). Both the audio
// and video export dialogs embed this so the two agree on tail behaviour.
//
// Tail modes:
//   - hardCut  : works. Warns about click/pop at the boundary.
//   - tailClamp: works (default). Effects ring out; last video frame frozen.
//   - wrap     : Phase 3B. Folds the post-region audio tail back onto the region
//                head for a seamless loop export. Audio only — video is not
//                extended/frozen. Only meaningful for a scoped loop-region render
//                (the engine fails it closed to tailClamp for a full-timeline
//                export). Exact for linear time-invariant effects (reverb/delay);
//                approximate for compressors/limiters/distortion/modulation.
//   - renderOrigin: absolute (real) selectable; normalized DISABLED/reserved
//                   because the engine still falls back to absolute.

export const TAIL_THRESHOLD_MIN = -120
export const TAIL_THRESHOLD_MAX = 0
export const TAIL_MAX_SECONDS_MIN = 0
export const TAIL_MAX_SECONDS_MAX = 120

// Clamp + sanitize a user-entered number to [lo, hi]; non-finite → fallback.
// Mirrors the engine model-boundary clamp (normalizeLoopRegion) so the optimistic
// UI and the committed model agree.
export function clampTailNumber(value, lo, hi, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

export default function TailRenderControls({ disabled = false }) {
  const loopRegion = useLoopRegionStore((s) => s.loopRegion)
  const fetchLoopRegion = useLoopRegionStore((s) => s.fetchLoopRegion)

  // Pull the committed region once on mount so the controls reflect the engine.
  useEffect(() => { fetchLoopRegion() }, [fetchLoopRegion])

  const tailMode = loopRegion.tailMode || 'tailClamp'
  const renderOrigin = loopRegion.renderOrigin || 'absolute'
  const committedThreshold = Number.isFinite(loopRegion.tailThresholdDb)
    ? loopRegion.tailThresholdDb : -60
  const committedMaxSeconds = Number.isFinite(loopRegion.tailMaxSeconds)
    ? loopRegion.tailMaxSeconds : 10

  // Local editing buffers for the numeric fields so typing is not interrupted by
  // per-keystroke clamping / undo commits. Committed (clamped) on blur / Enter.
  const [thresholdText, setThresholdText] = useState(String(committedThreshold))
  const [maxSecondsText, setMaxSecondsText] = useState(String(committedMaxSeconds))

  // Re-sync local buffers when the committed value changes from elsewhere
  // (undo/redo, another dialog, refetch).
  useEffect(() => { setThresholdText(String(committedThreshold)) }, [committedThreshold])
  useEffect(() => { setMaxSecondsText(String(committedMaxSeconds)) }, [committedMaxSeconds])

  // Single undo-tracked mutation. No optional chaining on the bridge call itself.
  const commit = useCallback((patch) => {
    if (!(window.xleth && window.xleth.timeline && window.xleth.timeline.setLoopRegion))
      return
    Promise.resolve(window.xleth.timeline.setLoopRegion(patch, 1))
      .then(() => fetchLoopRegion())
      .catch((e) => console.warn('[TailRender] setLoopRegion failed:', e))
  }, [fetchLoopRegion])

  const commitThreshold = useCallback(() => {
    const v = clampTailNumber(thresholdText, TAIL_THRESHOLD_MIN, TAIL_THRESHOLD_MAX, -60)
    setThresholdText(String(v))
    if (v !== committedThreshold) commit({ tailThresholdDb: v })
  }, [thresholdText, committedThreshold, commit])

  const commitMaxSeconds = useCallback(() => {
    const v = clampTailNumber(maxSecondsText, TAIL_MAX_SECONDS_MIN, TAIL_MAX_SECONDS_MAX, 10)
    setMaxSecondsText(String(v))
    if (v !== committedMaxSeconds) commit({ tailMaxSeconds: v })
  }, [maxSecondsText, committedMaxSeconds, commit])

  const tailFieldsDisabled = disabled || tailMode === 'hardCut'

  return (
    <div className="tail-render-controls">
      <div className="export-row">
        <label>Tail mode</label>
        <select
          value={tailMode}
          onChange={(e) => commit({ tailMode: e.target.value })}
          disabled={disabled}
        >
          <option value="tailClamp">Tail clamp — let effects ring out</option>
          <option value="hardCut">Hard cut — stop at region end</option>
          <option value="wrap">Wrap — fold tails back for a seamless loop</option>
        </select>
      </div>

      {tailMode === 'hardCut' ? (
        <div className="tail-warning">
          ⚠ Audio and video stop exactly at the region end. This can click/pop
          because the waveform and any reverb/delay tails are cut at the boundary.
        </div>
      ) : tailMode === 'wrap' ? (
        <div className="tail-help">
          Wrap folds audio tails back onto the start for seamless loop exports —
          for loop-region renders. The reverb/delay tail that rings out past the
          region end is folded onto the region head, so the exported audio loops
          without a click. The exported length stays exactly the region length and
          the video is not extended or frozen. Tail folding is exact for mostly
          linear, time-invariant effects such as reverb and delay; compressors,
          limiters, distortion, and modulation effects can make the fold
          approximate.
        </div>
      ) : (
        <div className="tail-help">
          No new clips or notes trigger after the region end, but existing effect
          tails (reverb, delay) ring out. The last video frame is frozen for the
          audio tail so audio and video stay the same length.
        </div>
      )}

      <div className="export-row">
        <label>Tail threshold (dBFS)</label>
        <input
          type="number"
          min={TAIL_THRESHOLD_MIN}
          max={TAIL_THRESHOLD_MAX}
          step={1}
          value={thresholdText}
          disabled={tailFieldsDisabled}
          onChange={(e) => setThresholdText(e.target.value)}
          onBlur={commitThreshold}
          onKeyDown={(e) => { if (e.key === 'Enter') commitThreshold() }}
        />
      </div>

      <div className="export-row">
        <label>Tail max (seconds)</label>
        <input
          type="number"
          min={TAIL_MAX_SECONDS_MIN}
          max={TAIL_MAX_SECONDS_MAX}
          step={0.5}
          value={maxSecondsText}
          disabled={tailFieldsDisabled}
          onChange={(e) => setMaxSecondsText(e.target.value)}
          onBlur={commitMaxSeconds}
          onKeyDown={(e) => { if (e.key === 'Enter') commitMaxSeconds() }}
        />
      </div>

      <div className="export-row">
        <label>Render origin</label>
        <select
          value={renderOrigin === 'normalized' ? 'absolute' : renderOrigin}
          onChange={(e) => commit({ renderOrigin: e.target.value })}
          disabled={disabled}
        >
          <option value="absolute">Absolute — warm up from project start</option>
          <option value="normalized" disabled>Normalized — reserved</option>
        </select>
      </div>
    </div>
  )
}
