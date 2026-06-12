import React, { useCallback, useEffect, useState } from 'react'
import useLoopRegionStore from '../stores/loopRegionStore.js'

// Shared export-dialog controls for LoopRegion tail and warmup settings. The
// values live in project state and are committed through timeline.setLoopRegion.
export const TAIL_THRESHOLD_MIN = -120
export const TAIL_THRESHOLD_MAX = 0
export const TAIL_MAX_SECONDS_MIN = 0
export const TAIL_MAX_SECONDS_MAX = 120

export function clampTailNumber(value, lo, hi, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

export default function TailRenderControls({ disabled = false }) {
  const loopRegion = useLoopRegionStore((s) => s.loopRegion)
  const fetchLoopRegion = useLoopRegionStore((s) => s.fetchLoopRegion)

  useEffect(() => { fetchLoopRegion() }, [fetchLoopRegion])

  const tailMode = loopRegion.tailMode || 'tailClamp'
  const renderOrigin = loopRegion.renderOrigin || 'absolute'
  const committedThreshold = Number.isFinite(loopRegion.tailThresholdDb)
    ? loopRegion.tailThresholdDb : -60
  const committedMaxSeconds = Number.isFinite(loopRegion.tailMaxSeconds)
    ? loopRegion.tailMaxSeconds : 10

  const [thresholdText, setThresholdText] = useState(String(committedThreshold))
  const [maxSecondsText, setMaxSecondsText] = useState(String(committedMaxSeconds))

  useEffect(() => { setThresholdText(String(committedThreshold)) }, [committedThreshold])
  useEffect(() => { setMaxSecondsText(String(committedMaxSeconds)) }, [committedMaxSeconds])

  const commit = useCallback((patch) => {
    if (!(window.xleth && window.xleth.timeline && window.xleth.timeline.setLoopRegion)) return
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

  const tailModeHelp = tailMode === 'hardCut'
    ? 'Export stops at the region end. Effect tails are cut off.'
    : tailMode === 'wrap'
      ? 'Effect tails are folded back into the start of the region for seamless loop exports.'
      : 'After the region ends, existing reverb, delay, and effect tails continue until they fade below the limit.'

  return (
    <div className="tail-render-controls">
      <div className="export-row">
        <label>End Behavior</label>
        <select
          value={tailMode}
          onChange={(e) => commit({ tailMode: e.target.value })}
          disabled={disabled}
        >
          <option value="tailClamp">Let audio fade out</option>
          <option value="hardCut">Cut exactly at end</option>
          <option value="wrap">Loop-safe wrap</option>
        </select>
      </div>

      <div className="tail-help">{tailModeHelp}</div>

      {tailMode === 'tailClamp' && (
        <div className="tail-advanced-fields" aria-label="Tail fade settings">
          <div className="export-row tail-compact-row">
            <label htmlFor="tail-threshold-db">Tail threshold (dBFS)</label>
            <input
              id="tail-threshold-db"
              type="number"
              min={TAIL_THRESHOLD_MIN}
              max={TAIL_THRESHOLD_MAX}
              step={1}
              value={thresholdText}
              disabled={disabled}
              onChange={(e) => setThresholdText(e.target.value)}
              onBlur={commitThreshold}
              onKeyDown={(e) => { if (e.key === 'Enter') commitThreshold() }}
            />
          </div>

          <div className="export-row tail-compact-row">
            <label htmlFor="tail-max-seconds">Tail max (seconds)</label>
            <input
              id="tail-max-seconds"
              type="number"
              min={TAIL_MAX_SECONDS_MIN}
              max={TAIL_MAX_SECONDS_MAX}
              step={0.5}
              value={maxSecondsText}
              disabled={disabled}
              onChange={(e) => setMaxSecondsText(e.target.value)}
              onBlur={commitMaxSeconds}
              onKeyDown={(e) => { if (e.key === 'Enter') commitMaxSeconds() }}
            />
          </div>
        </div>
      )}

      <div className="export-row">
        <label>Start Processing From</label>
        <select
          value={renderOrigin}
          onChange={(e) => commit({ renderOrigin: e.target.value })}
          disabled={disabled}
        >
          <option value="absolute">Project start — safest for effects</option>
          <option value="normalized" disabled>Region start — faster, may sound different</option>
        </select>
      </div>
      {renderOrigin === 'normalized' && (
        <div className="tail-help">
          Region start processing is reserved in this build, so exports still use project-start warmup.
        </div>
      )}
    </div>
  )
}
