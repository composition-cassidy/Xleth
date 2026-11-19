import React, { useEffect, useState } from 'react'
import { SegmentedControl } from '../../ui-kit'
import {
  DISCORD_TIER_LABELS,
  DISCORD_WARN_VIDEO_BITRATE,
  DISCORD_MIN_VIDEO_BITRATE,
  DISCORD_TIER_BYTES,
  computeDiscordVideoBitrate,
  estimateDiscordFileBytes,
  formatBitrateMbps,
  formatBytesMB,
  formatDuration,
} from './presets.js'
import { Banner, ExportSelect, Row, exportStyles as styles } from './exportKit.jsx'

const FPS_OPTIONS = [
  { value: 60, label: '60 fps' },
  { value: 30, label: '30 fps' },
  { value: 24, label: '24 fps' },
]

/**
 * Discord preset — MP4/H.264/AAC 48 kHz 256 kbps, auto bitrate to hit the
 * tier limit with 12% headroom. Warns when quality would be unusable.
 */
export default function DiscordTab({
  settings,       // { tier, fps, hwEncoder }
  onChange,
  running,
}) {
  const [availableEncoders, setAvailableEncoders] = useState([])
  const [durationSeconds, setDurationSeconds] = useState(0)

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

  // Resolve the export range duration in seconds for the bitrate estimate.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const secs = await window.xleth?.videoExport?.computeDurationSeconds?.()
        if (!cancelled) setDurationSeconds(Number(secs) || 0)
      } catch {
        if (!cancelled) setDurationSeconds(0)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const videoBitrate = computeDiscordVideoBitrate(settings.tier, durationSeconds)
  const estimatedBytes = estimateDiscordFileBytes(videoBitrate, durationSeconds)
  const limitBytes = DISCORD_TIER_BYTES[settings.tier] ?? DISCORD_TIER_BYTES.free
  const belowMin = videoBitrate < DISCORD_MIN_VIDEO_BITRATE
  const belowWarn = !belowMin && videoBitrate < DISCORD_WARN_VIDEO_BITRATE

  const encoderOptions = availableEncoders.length === 0
    ? [{ value: '', label: 'Auto' }]
    : availableEncoders.map((e) => ({ value: e.name, label: e.displayName || e.name }))

  return (
    <div className={styles.panel}>
      <div className={styles.desc}>MP4 · H.264 · AAC 48 kHz 256 kbps. Auto-fitted to the chosen tier.</div>

      <Row label="Tier">
        <SegmentedControl
          label="Discord tier"
          options={Object.entries(DISCORD_TIER_LABELS).map(([k, label]) => ({ value: k, label }))}
          value={settings.tier}
          disabled={running}
          onChange={(k) => onChange({ tier: k })}
        />
      </Row>

      <Row label="Frame rate">
        <ExportSelect label="Frame rate" value={settings.fps} options={FPS_OPTIONS} disabled={running} onChange={(v) => onChange({ fps: Number(v) })} />
      </Row>

      <Row label="Encoder">
        <ExportSelect
          label="Encoder"
          value={settings.hwEncoder || ''}
          options={encoderOptions}
          disabled={running || !availableEncoders.length}
          onChange={(v) => onChange({ hwEncoder: v })}
        />
      </Row>

      <div className={styles.readoutList}>
        <div>Range length: {formatDuration(durationSeconds)}</div>
        {videoBitrate > 0 ? (
          <>
            <div>Video bitrate: {formatBitrateMbps(videoBitrate)}</div>
            <div>Estimated size: about {formatBytesMB(estimatedBytes)} of {formatBytesMB(limitBytes)} budget</div>
          </>
        ) : (
          <div>Estimated size: — (set an export range with clips)</div>
        )}
      </div>

      {belowWarn && (
        <Banner tone="warn">Video quality will be low. Consider a higher tier or a shorter clip.</Banner>
      )}
      {belowMin && (
        <Banner tone="error">Clip too long for this tier. Pick a higher tier or trim the range.</Banner>
      )}
    </div>
  )
}
