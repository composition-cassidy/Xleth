import React, { useEffect, useState } from 'react'
import { Button, NumberBox, SegmentedControl, TextField } from '../../ui-kit'
import { customAspectMismatch, buildExportConfig, describeExportSummary, resolveAudioCodec } from './presets.js'
import { ExportSelect, Row, exportStyles as styles } from './exportKit.jsx'

const CUSTOM_DEFAULTS = {
  videoCodec:    'h264',
  hwEncoder:     '',
  resolution:    '1920x1080',
  customWidth:   1920,
  customHeight:  1080,
  fps:           60,
  useCrf:        true,
  crf:           18,
  videoBitrate:  20, // Mbps
  audioCodec:    'aac',
  sampleRate:    48000,
  audioBitrate:  384,
  fitMode:       '', // '' until the user picks; only required on aspect mismatch
}

// Resolution presets offered in the dropdown. A project canvas that matches one
// is shown as that preset; anything else falls back to the explicit Custom size.
const RES_PRESETS = ['1920x1080', '1280x720', '3840x2160']

function resolutionIdFor(w, h) {
  const id = `${w}x${h}`
  return RES_PRESETS.includes(id) ? id : 'custom'
}

// Build the Custom-tab defaults, seeded from the project canvas when provided so
// the export defaults to the Grid Settings resolution / aspect / frame rate.
export function makeCustomDefaults(projectCanvas) {
  if (!projectCanvas) return { ...CUSTOM_DEFAULTS }
  const w   = Number(projectCanvas.canvasWidth)  || CUSTOM_DEFAULTS.customWidth
  const h   = Number(projectCanvas.canvasHeight) || CUSTOM_DEFAULTS.customHeight
  const fps = Number(projectCanvas.previewFps)   || CUSTOM_DEFAULTS.fps
  return {
    ...CUSTOM_DEFAULTS,
    resolution:   resolutionIdFor(w, h),
    customWidth:  w,
    customHeight: h,
    fps,
  }
}

const CODEC_OPTIONS = [
  { value: 'h264', label: 'H.264' },
  { value: 'h265', label: 'H.265 / HEVC' },
  { value: 'av1', label: 'AV1' },
  { value: 'prores', label: 'ProRes' },
  { value: 'dnxhd', label: 'DNxHD' },
]
const MODE_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'software', label: 'Software encoder' },
  { value: 'hardware', label: 'Hardware encoder only' },
]
const RESOLUTION_OPTIONS = [
  { value: '1920x1080', label: '1920 × 1080' },
  { value: '1280x720', label: '1280 × 720' },
  { value: '3840x2160', label: '3840 × 2160 (4K)' },
  { value: 'custom', label: 'Custom…' },
]
const AUDIO_CODEC_OPTIONS = [
  { value: 'aac', label: 'AAC' },
  // No Opus: the bundled FFmpeg has no libopus (presets.js, EXPORT_AUDIO_CODECS).
  { value: 'flac', label: 'FLAC' },
  { value: 'pcm_s16le', label: 'PCM (uncompressed)' },
]
const SAMPLE_RATE_OPTIONS = [
  { value: 48000, label: '48 000 Hz' },
  { value: 44100, label: '44 100 Hz' },
]
const AUDIO_BITRATE_OPTIONS = [128, 192, 256, 384].map((v) => ({ value: v, label: `${v} kbps` }))
const FIT_MODES_UI = [
  { id: 'crop',    label: 'Crop to fill',   hint: 'Preserve proportions, fill output, crop edges.' },
  { id: 'stretch', label: 'Stretch to fit', hint: 'Scale directly into output, allowing distortion.' },
  { id: 'bars',    label: 'Fit with bars',  hint: 'Preserve proportions, letterbox / pillarbox.' },
]

/**
 * Custom preset tab — exposes only what the FFmpegMuxer backend actually
 * supports (MP4 container, H.264/H.265/AV1/DNxHD/ProRes video, AAC/FLAC/PCM
 * audio). Save/Load/Delete preset controls live at the top.
 */
export default function CustomTab({
  settings,
  onChange,
  running,
  projectCanvas,      // { canvasWidth, canvasHeight, canvasAspectRatio, previewFps }
  presets,            // array of { name, settings }
  onSavePreset,       // (name, settings) => void
  onLoadPreset,       // (name) => void
  onDeletePreset,     // (name) => void
  videoModeOverride,        // 'auto' | 'software' | 'hardware' — global encode-mode preference
  onVideoModeOverrideChange, // (mode) => void
}) {
  const [availableEncoders, setAvailableEncoders] = useState([])
  const [selectedPreset, setSelectedPreset] = useState('')
  const [naming, setNaming] = useState(false)
  const [presetName, setPresetName] = useState('')

  // Refetch encoders whenever the codec changes.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const encs = await window.xleth?.videoExport?.getAvailableEncoders(settings.videoCodec)
        if (!cancelled) setAvailableEncoders(encs || [])
      } catch {
        if (!cancelled) setAvailableEncoders([])
      }
    })()
    return () => { cancelled = true }
  }, [settings.videoCodec])

  const loadSelected = (name) => {
    setSelectedPreset(name)
    if (name) onLoadPreset(name)
  }

  // An inline name field instead of window.prompt, which Electron does not provide.
  const commitSavePreset = () => {
    const name = presetName.trim()
    if (!name) return
    onSavePreset(name, settings)
    setSelectedPreset(name)
    setNaming(false)
    setPresetName('')
  }

  const handleDeletePreset = () => {
    if (!selectedPreset) return
    onDeletePreset(selectedPreset)
    setSelectedPreset('')
  }

  // When the custom output aspect differs from the project canvas aspect, the
  // user must pick how the canvas maps into it (crop / stretch / letterbox).
  const aspectMismatch = projectCanvas
    ? customAspectMismatch(settings, projectCanvas)
    : false

  // Accurate one-line description of the exact output this tab will encode.
  const outputSummary = describeExportSummary(buildExportConfig({
    activeTab: 'custom', outputPath: '', customSettings: settings,
    videoModeOverride: 'auto', projectCanvas,
  }))

  const presetOptions = [{ value: '', label: 'None' }, ...presets.map((p) => ({ value: p.name, label: p.name }))]
  const encoderOptions = availableEncoders.length === 0
    ? [{ value: '', label: 'Software only' }]
    : availableEncoders.map((e) => ({ value: e.name, label: e.displayName || e.name }))
  const fpsValues = [60, 30, 24]
  const fpsOptions = [
    ...(fpsValues.includes(Number(settings.fps)) ? [] : [{ value: settings.fps, label: `${settings.fps} fps` }]),
    ...fpsValues.map((v) => ({ value: v, label: `${v} fps` })),
  ]
  const activeFit = FIT_MODES_UI.find((m) => m.id === settings.fitMode)

  return (
    <div className={styles.panel}>
      <div className={styles.desc}>
        Custom export settings for codec, resolution, frame rate, quality, and audio.
      </div>

      {/* ── Preset row ─────────────────────────────────────────────────────── */}
      <Row label="Preset">
        <ExportSelect label="Preset" value={selectedPreset} options={presetOptions} disabled={running} onChange={loadSelected} />
        <Button onClick={() => setNaming((v) => !v)} disabled={running}>Save preset…</Button>
        <Button onClick={handleDeletePreset} disabled={running || !selectedPreset}>Delete preset</Button>
      </Row>
      {naming && (
        <Row label="Preset name">
          <TextField
            data-fill=""
            label="Preset name"
            value={presetName}
            placeholder="My preset"
            onChange={setPresetName}
            onKeyDown={(e) => { if (e.key === 'Enter') commitSavePreset() }}
            autoFocus
          />
          <Button variant="primary" onClick={commitSavePreset} disabled={!presetName.trim()}>Save preset</Button>
          <Button onClick={() => { setNaming(false); setPresetName('') }}>Cancel</Button>
        </Row>
      )}

      <div className={styles.columns}>
        {/* ── Video ────────────────────────────────────────────────────── */}
        <div className={styles.column}>
          <h3 className={styles.groupTitle}>Video</h3>

          <Row label="Video codec">
            <ExportSelect label="Video codec" value={settings.videoCodec} options={CODEC_OPTIONS} disabled={running} onChange={(v) => onChange({ videoCodec: v })} />
          </Row>

          {onVideoModeOverrideChange && (
            <Row label="Encoder mode">
              <ExportSelect label="Encoder mode" value={videoModeOverride || 'auto'} options={MODE_OPTIONS} disabled={running} onChange={onVideoModeOverrideChange} />
            </Row>
          )}

          <Row label="Encoder device">
            <ExportSelect
              label="Encoder device"
              value={settings.hwEncoder}
              options={encoderOptions}
              disabled={running || !availableEncoders.length}
              onChange={(v) => onChange({ hwEncoder: v })}
            />
          </Row>

          <Row label="Resolution">
            <ExportSelect label="Resolution" value={settings.resolution} options={RESOLUTION_OPTIONS} disabled={running} onChange={(v) => onChange({ resolution: v })} />
          </Row>

          <Row label="Frame rate">
            <ExportSelect label="Frame rate" value={settings.fps} options={fpsOptions} disabled={running} onChange={(v) => onChange({ fps: Number(v) })} />
          </Row>

          {settings.resolution === 'custom' && (
            <Row label="Size">
              <NumberBox
                label="Width" width={96} min={128} max={7680} step={2} quantize={Math.round}
                format={(v) => `${Math.round(v)} px`} disabled={running} value={settings.customWidth}
                onCommit={(v) => onChange({ customWidth: v })}
              />
              <span aria-hidden="true">×</span>
              <NumberBox
                label="Height" width={96} min={128} max={4320} step={2} quantize={Math.round}
                format={(v) => `${Math.round(v)} px`} disabled={running} value={settings.customHeight}
                onCommit={(v) => onChange({ customHeight: v })}
              />
            </Row>
          )}

          {/* ── Fit mode — only when the output aspect differs from the project ── */}
          {aspectMismatch && (
            <Row label="Fit to canvas">
              <SegmentedControl
                label="Fit to canvas"
                options={FIT_MODES_UI.map((m) => ({ value: m.id, label: m.label, hint: m.label, hintMods: m.hint }))}
                value={settings.fitMode || ''}
                disabled={running}
                onChange={(id) => onChange({ fitMode: id })}
              />
              <div className={styles.fitHint} data-required={settings.fitMode ? undefined : ''}>
                {activeFit
                  ? activeFit.hint
                  : `Output aspect differs from the project (${projectCanvas?.canvasAspectRatio || 'canvas'}). Choose a fit mode to export.`}
              </div>
            </Row>
          )}

          <Row label="Rate control">
            <SegmentedControl
              label="Rate control"
              options={[{ value: 'crf', label: 'Quality (CRF)' }, { value: 'bitrate', label: 'Target bitrate' }]}
              value={settings.useCrf ? 'crf' : 'bitrate'}
              disabled={running}
              onChange={(v) => onChange({ useCrf: v === 'crf' })}
            />
            {settings.useCrf ? (
              <NumberBox
                label="CRF" width={72} min={0} max={51} step={1} quantize={Math.round} defaultValue={18}
                disabled={running} value={settings.crf} onCommit={(v) => onChange({ crf: v })}
              />
            ) : (
              <NumberBox
                label="Video bitrate" width={96} min={1} max={200} step={1} unit="Mbps" quantize={Math.round}
                defaultValue={20} disabled={running} value={settings.videoBitrate}
                onCommit={(v) => onChange({ videoBitrate: v })}
              />
            )}
          </Row>
        </div>

        {/* ── Audio ────────────────────────────────────────────────────── */}
        <div className={styles.column}>
          <h3 className={styles.groupTitle}>Audio</h3>

          <Row label="Audio codec">
            <ExportSelect label="Audio codec" value={resolveAudioCodec(settings.audioCodec)} options={AUDIO_CODEC_OPTIONS} disabled={running} onChange={(v) => onChange({ audioCodec: v })} />
          </Row>

          <Row label="Sample rate">
            <ExportSelect label="Audio sample rate" value={settings.sampleRate} options={SAMPLE_RATE_OPTIONS} disabled={running} onChange={(v) => onChange({ sampleRate: Number(v) })} />
          </Row>

          {resolveAudioCodec(settings.audioCodec) === 'aac' && (
            <Row label="Audio bitrate">
              <ExportSelect label="Audio bitrate" value={settings.audioBitrate} options={AUDIO_BITRATE_OPTIONS} disabled={running} onChange={(v) => onChange({ audioBitrate: Number(v) })} />
            </Row>
          )}
        </div>
      </div>

      <div className={styles.readout} title="Final encoded output">
        {outputSummary}
      </div>
    </div>
  )
}
