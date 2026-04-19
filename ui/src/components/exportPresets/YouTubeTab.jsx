import { useEffect, useState } from 'react'
import {
  YOUTUBE_QUALITY_STOPS,
  YOUTUBE_RESOLUTIONS,
  computeYoutubeBitrate,
  formatBitrateMbps,
} from './presets.js'

/**
 * YouTube preset — MP4/H.264/AAC 48 kHz 384 kbps, sub-linear bitrate scaling
 * with a 4-stop quality selector (Good / Great / Excellent / Best).
 */
export default function YouTubeTab({
  settings,       // { resolution, fps, quality, hwEncoder }
  onChange,       // (patch) => void
  outputPath,
  onBrowse,
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

  return (
    <div className="export-tab-panel">
      <div className="export-tab-desc">
        MP4 · H.264 · AAC 48 kHz 384 kbps. Tuned for YouTube upload.
      </div>

      <div className="export-row">
        <label>Resolution</label>
        <select value={settings.resolution}
                onChange={(e) => onChange({ resolution: e.target.value })}
                disabled={running}>
          {YOUTUBE_RESOLUTIONS.map((r) => (
            <option key={r.id} value={r.id}>{r.label} ({r.width}×{r.height})</option>
          ))}
        </select>
      </div>

      <div className="export-row">
        <label>Frame Rate</label>
        <select value={settings.fps}
                onChange={(e) => onChange({ fps: Number(e.target.value) })}
                disabled={running}>
          <option value={60}>60 fps</option>
          <option value={30}>30 fps</option>
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

      <div className="export-row">
        <label>Quality</label>
        <div className="quality-stops">
          {YOUTUBE_QUALITY_STOPS.map((s) => (
            <button key={s.value}
                    className={`quality-stop ${settings.quality === s.value ? 'active' : ''}`}
                    onClick={() => onChange({ quality: s.value })}
                    disabled={running}>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="export-row">
        <label></label>
        <div className="export-bitrate-readout">
          {qualityLabel} — ~{formatBitrateMbps(bitrate)}
        </div>
      </div>

      <div className="export-row export-row-path">
        <label>Output File</label>
        <div className="export-path-group">
          <input type="text" value={outputPath} readOnly placeholder="Click Browse…" disabled={running} />
          <button onClick={onBrowse} disabled={running}>Browse…</button>
        </div>
      </div>
    </div>
  )
}
