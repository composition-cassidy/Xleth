import React, { useEffect, useState } from 'react'
import { useDynamicsVizSubscription } from '../../plugin-ui/runtime/useDynamicsVizSubscription.js'
import { VIZ_TYPE } from '../../constants/dynamicsViz.js'
import styles from './UniFlangeScope.module.css'

// The UniFlange display: the dry and wet signals as scrolling traces.
//
// Backed by the same per-effect dynamics-visualization pipeline as the
// Compressor and Limiter (engine DynamicsVizCollector, the UniFlangeBucket
// consumer). Dry is the raw pre-effect mono input tap; wet is the post
// cross-mix ensemble tap (before the dry/wet gain blend): literally the two
// signals the Dry and Wet knobs blend. Each bucket carries signed linear
// min/max excursion over ~64 samples; the larger-magnitude of the two is drawn
// per bucket. Refreshed from the shared 30 Hz drain loop.
//
// Until the first live bucket arrives (or if the viz API is unavailable) the
// traces are EMPTY: a flat centre rule, never a placeholder waveform.

const WAVE_W = 120
const WAVE_H = 84
const WAVE_POINTS = 96
// Linear headroom above unity for the wet tap (Cross can add up to +6 dB / 2x).
const AMP_HEADROOM = 1.5

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const dominantSigned = (minV, maxV) => (Math.abs(maxV) >= Math.abs(minV) ? maxV : minV)

function buildLiveWavePath(buckets, minKey, maxKey) {
  const n = buckets.length
  if (n === 0) return ''
  const cy = WAVE_H / 2
  const scale = (WAVE_H * 0.42) / AMP_HEADROOM
  return buckets.map((b, i) => {
    const v = clamp(dominantSigned(b[minKey], b[maxKey]), -AMP_HEADROOM, AMP_HEADROOM)
    const x = n > 1 ? (i / (n - 1)) * WAVE_W : WAVE_W / 2
    const y = cy - v * scale
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
}

function Lane({ name, path, hidden }) {
  if (hidden) return null
  return (
    <div className={styles.lane} data-lane={name.toLowerCase()}>
      <span className={styles.laneName}>{name}</span>
      <svg className={styles.wave} viewBox={`0 0 ${WAVE_W} ${WAVE_H}`} preserveAspectRatio="none" aria-hidden="true">
        <line className={styles.rule} x1="0" y1={WAVE_H / 2} x2={WAVE_W} y2={WAVE_H / 2} vectorEffect="non-scaling-stroke" />
        {path ? <path className={styles.trace} d={path} vectorEffect="non-scaling-stroke" /> : null}
      </svg>
    </div>
  )
}

export default function UniFlangeScope({ target, view }) {
  const vizHandle = useDynamicsVizSubscription(target?.trackId ?? null, target?.nodeId ?? null, VIZ_TYPE.UNIFLANGE)
  const [dryPath, setDryPath] = useState('')
  const [wetPath, setWetPath] = useState('')

  useEffect(() => {
    if (!target) return undefined
    // Clear on every (re)target so two UniFlange instances never share a shape.
    setDryPath('')
    setWetPath('')
    let rafId = 0
    let lastEpoch = -1
    const pump = () => {
      const epoch = vizHandle.epochRef.current?.value
      if (epoch !== undefined && epoch !== lastEpoch) {
        lastEpoch = epoch
        const ring = vizHandle.ringRef.current
        if (ring && ring.count > 0) {
          const take = Math.min(ring.count, WAVE_POINTS)
          const skip = ring.count - take
          const buckets = []
          let seen = 0
          ring.forEachInOrder((b) => { if (seen++ >= skip && b) buckets.push(b) })
          if (buckets.length > 0) {
            setDryPath(buildLiveWavePath(buckets, 'dryMin', 'dryMax'))
            setWetPath(buildLiveWavePath(buckets, 'wetMin', 'wetMax'))
          }
        }
      }
      rafId = requestAnimationFrame(pump)
    }
    rafId = requestAnimationFrame(pump)
    return () => cancelAnimationFrame(rafId)
  }, [target, vizHandle])

  return (
    <div className={styles.scope} data-view={view}>
      <Lane name="Dry" path={dryPath} hidden={view === 'wet'} />
      <Lane name="Wet" path={wetPath} hidden={view === 'dry'} />
    </div>
  )
}
