import React from 'react'
import InfoTip from '../InfoTip.jsx'
import { PLATFORM_TARGETS } from '../../constants/loudnessTargets.js'

const LOUDNESS_HELP = 'Static gain only — no limiter. Protects against codec clipping on upload.'

/**
 * Audio destination pane — drives the C++ AudioExporter via the xleth.audio
 * bridge. Mirrors the structure of YouTubeTab/DiscordTab/CustomTab: pure
 * presentational, settings/onChange/running only. Output file + render range
 * are shared chrome owned by RenderDialog.
 */
export default function AudioTab({
  settings,       // { format, sampleRate, bitDepth, mp3Bitrate, flacLevel, platformTarget, customTargetLufs, customMaxDbtp }
  onChange,       // (patch) => void
  running,
}) {
  const { format, sampleRate, bitDepth, mp3Bitrate, flacLevel, platformTarget, customTargetLufs, customMaxDbtp } = settings

  return (
    <div className="export-tab-panel">
      <div className="export-field-grid">
        <div className="export-row export-field">
          <label>Format</label>
          <select value={format} onChange={(e) => onChange({ format: e.target.value })} disabled={running}>
            <option value="wav">WAV</option>
            <option value="mp3">MP3</option>
            <option value="flac">FLAC</option>
          </select>
        </div>

        <div className="export-row export-field">
          <label>Sample Rate</label>
          <select value={sampleRate} onChange={(e) => onChange({ sampleRate: Number(e.target.value) })} disabled={running}>
            <option value={44100}>44100 Hz</option>
            <option value={48000}>48000 Hz</option>
          </select>
        </div>

        {format === 'wav' && (
          <div className="export-row export-field">
            <label>Bit Depth</label>
            <select value={bitDepth} onChange={(e) => onChange({ bitDepth: Number(e.target.value) })} disabled={running}>
              <option value={16}>16-bit PCM</option>
              <option value={24}>24-bit PCM</option>
              <option value={32}>32-bit Float</option>
            </select>
          </div>
        )}

        {format === 'mp3' && (
          <div className="export-row export-field">
            <label>Bitrate</label>
            <select value={mp3Bitrate} onChange={(e) => onChange({ mp3Bitrate: Number(e.target.value) })} disabled={running}>
              <option value={128}>128 kbps</option>
              <option value={192}>192 kbps</option>
              <option value={256}>256 kbps</option>
              <option value={320}>320 kbps</option>
            </select>
          </div>
        )}

        {format === 'flac' && (
          <div className="export-row export-field">
            <label>Compression</label>
            <select value={flacLevel} onChange={(e) => onChange({ flacLevel: Number(e.target.value) })} disabled={running}>
              {Array.from({ length: 9 }, (_, i) => (
                <option key={i} value={i}>Level {i}{i === 0 ? ' (fastest)' : i === 8 ? ' (smallest)' : ''}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="export-section-divider" />
      <div className="loudness-normalization-controls">
        <div className="export-row">
          <label>Loudness Normalization <InfoTip text={LOUDNESS_HELP} /></label>
          <select
            value={platformTarget}
            onChange={(e) => onChange({ platformTarget: e.target.value })}
            disabled={running}
          >
            {Object.entries(PLATFORM_TARGETS).map(([key, t]) => (
              <option key={key} value={key}>{t.label}</option>
            ))}
          </select>
        </div>

        {platformTarget === 'custom' && (
          <div className="tail-advanced-fields" aria-label="Custom loudness target">
            <div className="export-row tail-compact-row">
              <label htmlFor="loudness-target-lufs">Target LUFS</label>
              <input
                id="loudness-target-lufs"
                type="number"
                step={0.5}
                value={customTargetLufs}
                disabled={running}
                onChange={(e) => onChange({ customTargetLufs: e.target.value })}
              />
            </div>
            <div className="export-row tail-compact-row">
              <label htmlFor="loudness-max-dbtp">Ceiling (dBTP)</label>
              <input
                id="loudness-max-dbtp"
                type="number"
                step={0.1}
                max={0}
                value={customMaxDbtp}
                disabled={running}
                onChange={(e) => onChange({ customMaxDbtp: e.target.value })}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
