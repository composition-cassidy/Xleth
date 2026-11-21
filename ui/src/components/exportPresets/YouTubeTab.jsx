import React, { useEffect, useState } from 'react'
import { SegmentedControl } from '../../ui-kit'
import {
  YOUTUBE_QUALITY_STOPS,
  YOUTUBE_RESOLUTIONS,
  computeYoutubeBitrate,
  formatBitrateMbps,
} from './presets.js'
import { ExportSelect, Row, exportStyles as styles } from './exportKit.jsx'

const FPS_OPTIONS = [
  { value: 60, label: '60 fps' },
  { value: 30, label: '30 fps' },
]

/**
 * YouTube preset — MP4/H.264/AAC 48 kHz 384 kbps, sub-linear bitrate scaling
 * with a 4-stop quality selector (Good / Great / Excellent / Best).
 */
export default function YouTubeTab({
  settings,       // { resolution, fps, quality, hwEncoder }
  onChange,       // (patch) => void
  running,
}) {
  const [availableEncoders, setAvailableEncoders] = useState([])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const encs = await window.xleth?.videoExport?.getAvailableEncoders('h264')
        if (!cancelled) setAvailableEncoders(encs || [])
        if (!settings.hwEncoder) {
          const def = await window.xleth?.videoExport?.getDefaultEncoder('h264')
          if (!cancelled && def) onChange({ hwEncoder: def })
        }
      } catch {
        if (!cancelled) setAvailableEncoders([])
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const res = YOUTUBE_RESOLUTIONS.find((r) => r.id === settings.resolution)
          || YOUTUBE_RESOLUTIONS[0]
  const bitrate = computeYoutubeBitrate(res.width, res.height, settings.fps, settings.quality)
  const qualityLabel = YOUTUBE_QUALITY_STOPS.find((s) => s.value === settings.quality)?.label
                     || 'Great'

  const resolutionOptions = YOUTUBE_RESOLUTIONS.map((r) => ({ value: r.id, label: `${r.label} (${r.width}×${r.height})` }))
  const encoderOptions = availableEncoders.length === 0
    ? [{ value: '', label: 'Auto' }]
    : availableEncoders.map((e) => ({ value: e.name, label: e.displayName || e.name }))

  return (
    <div className={styles.panel}>
      <div className={styles.desc}>MP4 · H.264 · AAC 48 kHz 384 kbps. Tuned for YouTube upload.</div>

      <div className={styles.grid}>
        <Row label="Resolution">
          <ExportSelect label="Resolution" value={settings.resolution} options={resolutionOptions} disabled={running} onChange={(v) => onChange({ resolution: v })} />
        </Row>
        <Row label="Frame rate">
          <ExportSelect label="Frame rate" value={settings.fps} options={FPS_OPTIONS} disabled={running} onChange={(v) => onChange({ fps: Number(v) })} />
        </Row>
      </div>

      <Row label="Encoder">
        <ExportSelect
          label="Encoder"
          value={settings.hwEncoder || ''}
          options={encoderOptions}
          disabled={running || !availableEncoders.length}
          onChange={(v) => onChange({ hwEncoder: v })}
        />
      </Row>

      <Row label="Quality" note={`${qualityLabel}: about ${formatBitrateMbps(bitrate)}`}>
        <SegmentedControl
          label="Quality"
          options={YOUTUBE_QUALITY_STOPS.map((s) => ({ value: s.value, label: s.label }))}
          value={settings.quality}
          disabled={running}
          onChange={(v) => onChange({ quality: v })}
        />
      </Row>
    </div>
  )
}
