import React from 'react'
import styles from './MidiImport.module.css'

// Must match kThumbBucketCount in engine/src/midi/MidiImporter.cpp.
const THUMB_BUCKET_COUNT = 96
const VIEWBOX_HEIGHT = 24
const BAR_MAX_HEIGHT = 20

// Renders a source track's note-density strip from parseSummary's per-track
// `thumb.buckets` (note-on count per equal time division). Purely a density
// sparkline -- bar height is the only encoded signal, so a sparse kick track
// reads visibly differently from a dense hat track without importing blind.
// Colors come from CSS (the thumb rule in MidiImport.module.css) so it stays token-only.
export default function MidiTrackThumbnail({ thumb }) {
  const buckets = thumb?.buckets
  if (!Array.isArray(buckets) || buckets.length !== THUMB_BUCKET_COUNT) return null

  const maxCount = Math.max(1, ...buckets)

  return (
    <svg
      className={styles.thumb}
      data-midi-thumbnail=""
      viewBox={`0 0 ${THUMB_BUCKET_COUNT} ${VIEWBOX_HEIGHT}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {buckets.map((count, i) => {
        if (count <= 0) return null
        const h = Math.max(1, (count / maxCount) * BAR_MAX_HEIGHT)
        return (
          <rect key={i} x={i + 0.1} y={VIEWBOX_HEIGHT - h} width={0.8} height={h} />
        )
      })}
    </svg>
  )
}
