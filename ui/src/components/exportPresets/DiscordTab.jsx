import { useEffect, useState } from 'react'
import { BEATS_PER_BAR } from '../../constants/timeline.js'
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

/**
 * Discord preset — MP4/H.264/Opus 44.1 kHz 256 kbps, auto bitrate to hit the
 * tier limit with 12% headroom. Warns when quality would be unusable.
 */
export default function DiscordTab({
  settings,       // { tier, fps, hwEncoder }
  onChange,
  outputPath,
  onBrowse,
  running,
  startBar,
  endBar,
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
        const s = Math.max(0, (Number(startBar) - 1) * BEATS_PER_BAR)
        const e = Number(endBar) > 0 ? Number(endBar) * BEATS_PER_BAR : -1
        const secs = await window.xleth?.videoExport?.computeDurationSeconds?.(s, e)
        if (!cancelled) setDurationSeconds(Number(secs) || 0)
      } catch {
        if (!cancelled) setDurationSeconds(0)
      }
    })()
    return () => { cancelled = true }
  }, [startBar, endBar])

  const videoBitrate = computeDiscordVideoBitrate(settings.tier, durationSeconds)
  const estimatedBytes = estimateDiscordFileBytes(videoBitrate, durationSeconds)
  const limitBytes = DISCORD_TIER_BYTES[settings.tier] ?? DISCORD_TIER_BYTES.free
  const belowMin = videoBitrate < DISCORD_MIN_VIDEO_BITRATE
  const belowWarn = !belowMin && videoBitrate < DISCORD_WARN_VIDEO_BITRATE

  return (
    <div className="export-tab-panel">
      <div className="export-tab-desc">
        MP4 · H.264 · Opus 44.1 kHz 256 kbps. Auto-fitted to the chosen tier.
      </div>

      <div className="export-row">
        <label>Tier</label>
        <div className="tier-radio-group">
          {Object.entries(DISCORD_TIER_LABELS).map(([k, label]) => (
            <label key={k} className={`tier-radio ${settings.tier === k ? 'active' : ''}`}>
              <input type="radio"
                     name="discord-tier"
                     value={k}
                     checked={settings.tier === k}
                     onChange={() => onChange({ tier: k })}
                     disabled={running} />
              {label}
            </label>
          ))}
        </div>
      </div>

      <div className="export-row">
        <label>Frame Rate</label>
        <select value={settings.fps}
                onChange={(e) => onChange({ fps: Number(e.target.value) })}
                disabled={running}>
          <option value={60}>60 fps</option>
          <option value={30}>30 fps</option>
          <option value={24}>24 fps</option>
        </select>
      </div>

      <div className="export-row">
        <label>Encoder</label>
        <select value={settings.hwEncoder || ''}
                onChange={(e) => onChange({ hwEncoder: e.target.value })}
                disabled={running || !availableEncoders.length}>
          {availableEncoders.length === 0 && <option value="">auto</option>}
          {availableEncoders.map((e) => (
            <option key={e.name} value={e.name}>{e.displayName || e.name}</option>
          ))}
        </select>
      </div>

      <div className="export-row export-row-path">
        <label>Output File</label>
        <div className="export-path-group">
          <input type="text" value={outputPath} readOnly placeholder="Click Browse…" disabled={running} />
          <button onClick={onBrowse} disabled={running}>Browse…</button>
        </div>
      </div>

      <div className="discord-readout">
        <div>Range length: {formatDuration(durationSeconds)}</div>
        {videoBitrate > 0 ? (
          <>
            <div>Video bitrate: {formatBitrateMbps(videoBitrate)}</div>
            <div>Estimated size: ~{formatBytesMB(estimatedBytes)} of {formatBytesMB(limitBytes)} budget</div>
          </>
        ) : (
          <div>Estimated size: — (set an export range with clips)</div>
        )}
      </div>

      {belowWarn && (
        <div className="export-banner warn">
          Video quality will be low. Consider a higher tier or a shorter clip.
        </div>
      )}
      {belowMin && (
        <div className="export-banner error">
          Clip too long for this tier. Pick a higher tier or trim the range.
        </div>
      )}
    </div>
  )
}
