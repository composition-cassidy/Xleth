import React, { useCallback, useEffect, useState } from 'react'
import useLoopRegionStore from '../stores/loopRegionStore.js'
import { NumberBox } from '../ui-kit'
import { ExportSelect, Row, exportStyles as styles } from './exportPresets/exportKit.jsx'

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

  const tailModeHelp = tailMode === 'hardCut'
    ? 'Export stops at the region end. Effect tails are cut off.'
    : tailMode === 'wrap'
      ? 'Effect tails are folded back into the start of the region for seamless loop exports.'
      : 'After the region ends, existing reverb, delay, and effect tails continue until they fade below the limit.'

  const tailModeOptions = [
    { value: 'tailClamp', label: 'Let audio fade out' },
    { value: 'hardCut', label: 'Cut exactly at end' },
    { value: 'wrap', label: 'Loop-safe wrap' },
  ]
  const originOptions = [
    { value: 'absolute', label: 'Project start: safest for effects' },
    { value: 'normalized', label: 'Region start: faster, may sound different', disabled: true },
  ]

  return (
    <div className={styles.panel}>
      <Row label="End behavior" note={tailModeHelp}>
        <ExportSelect label="End behavior" value={tailMode} options={tailModeOptions} disabled={disabled} onChange={(v) => commit({ tailMode: v })} />
      </Row>

      {tailMode === 'tailClamp' && (
        <div className={styles.grid} role="group" aria-label="Tail fade settings">
          <Row label="Tail threshold">
            <NumberBox
              label="Tail threshold" hideLabel width={96}
              min={TAIL_THRESHOLD_MIN} max={TAIL_THRESHOLD_MAX} step={1} unit="dBFS" quantize={Math.round}
              defaultValue={-60} disabled={disabled}
              value={clampTailNumber(thresholdText, TAIL_THRESHOLD_MIN, TAIL_THRESHOLD_MAX, -60)}
              onChange={(v) => setThresholdText(String(v))}
              onCommit={(v) => { setThresholdText(String(v)); if (v !== committedThreshold) commit({ tailThresholdDb: v }) }}
            />
          </Row>
          <Row label="Tail max">
            <NumberBox
              label="Tail max" hideLabel width={96}
              min={TAIL_MAX_SECONDS_MIN} max={TAIL_MAX_SECONDS_MAX} step={0.5} unit="s"
              defaultValue={10} disabled={disabled}
              value={clampTailNumber(maxSecondsText, TAIL_MAX_SECONDS_MIN, TAIL_MAX_SECONDS_MAX, 10)}
              onChange={(v) => setMaxSecondsText(String(v))}
              onCommit={(v) => { setMaxSecondsText(String(v)); if (v !== committedMaxSeconds) commit({ tailMaxSeconds: v }) }}
            />
          </Row>
        </div>
      )}

      <Row
        label="Start processing from"
        note={renderOrigin === 'normalized' ? 'Region start processing is reserved in this build, so exports still use project-start warmup.' : undefined}
      >
        <ExportSelect label="Start processing from" value={renderOrigin} options={originOptions} disabled={disabled} onChange={(v) => commit({ renderOrigin: v })} />
      </Row>
    </div>
  )
}
