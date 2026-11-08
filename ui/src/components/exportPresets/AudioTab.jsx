import React from 'react'
import { NumberBox } from '../../ui-kit'
import { PLATFORM_TARGETS } from '../../constants/loudnessTargets.js'
import { ExportSelect, Row, exportStyles as styles } from './exportKit.jsx'

const LOUDNESS_HELP = 'Static gain only, no limiter. Protects against codec clipping on upload.'

const FORMAT_OPTIONS = [
  { value: 'wav', label: 'WAV' },
  { value: 'mp3', label: 'MP3' },
  { value: 'flac', label: 'FLAC' },
]
const RATE_OPTIONS = [
  { value: 44100, label: '44100 Hz' },
  { value: 48000, label: '48000 Hz' },
]
const DEPTH_OPTIONS = [
  { value: 16, label: '16-bit PCM' },
  { value: 24, label: '24-bit PCM' },
  { value: 32, label: '32-bit float' },
]
const MP3_OPTIONS = [128, 192, 256, 320].map((v) => ({ value: v, label: `${v} kbps` }))
const FLAC_OPTIONS = Array.from({ length: 9 }, (_, i) => ({
  value: i,
  label: `Level ${i}${i === 0 ? ' (fastest)' : i === 8 ? ' (smallest)' : ''}`,
}))
const TARGET_OPTIONS = Object.entries(PLATFORM_TARGETS).map(([key, t]) => ({ value: key, label: t.label }))

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
    <div className={styles.panel}>
      <div className={styles.grid}>
        <Row label="Format">
          <ExportSelect label="Format" value={format} options={FORMAT_OPTIONS} disabled={running} onChange={(v) => onChange({ format: v })} />
        </Row>

        <Row label="Sample rate">
          <ExportSelect label="Sample rate" value={sampleRate} options={RATE_OPTIONS} disabled={running} onChange={(v) => onChange({ sampleRate: Number(v) })} />
        </Row>

        {format === 'wav' && (
          <Row label="Bit depth">
            <ExportSelect label="Bit depth" value={bitDepth} options={DEPTH_OPTIONS} disabled={running} onChange={(v) => onChange({ bitDepth: Number(v) })} />
          </Row>
        )}

        {format === 'mp3' && (
          <Row label="Bitrate">
            <ExportSelect label="Bitrate" value={mp3Bitrate} options={MP3_OPTIONS} disabled={running} onChange={(v) => onChange({ mp3Bitrate: Number(v) })} />
          </Row>
        )}

        {format === 'flac' && (
          <Row label="Compression">
            <ExportSelect label="Compression" value={flacLevel} options={FLAC_OPTIONS} disabled={running} onChange={(v) => onChange({ flacLevel: Number(v) })} />
          </Row>
        )}
      </div>

      <div className={styles.divider} />
      <Row label="Loudness normalization" note={LOUDNESS_HELP}>
        <ExportSelect
          label="Loudness normalization"
          value={platformTarget}
          options={TARGET_OPTIONS}
          disabled={running}
          onChange={(v) => onChange({ platformTarget: v })}
        />
      </Row>

      {platformTarget === 'custom' && (
        <div className={styles.grid} role="group" aria-label="Custom loudness target">
          <Row label="Target">
            <NumberBox
              label="Target loudness" hideLabel width={96} min={-40} max={0} step={0.5} unit="LUFS"
              defaultValue={-14} disabled={running} value={Number(customTargetLufs)}
              onCommit={(v) => onChange({ customTargetLufs: v })}
            />
          </Row>
          <Row label="Ceiling">
            <NumberBox
              label="True-peak ceiling" hideLabel width={96} min={-12} max={0} step={0.1} unit="dBTP"
              defaultValue={-1} disabled={running} value={Number(customMaxDbtp)}
              onCommit={(v) => onChange({ customMaxDbtp: v })}
            />
          </Row>
        </div>
      )}
    </div>
  )
}
