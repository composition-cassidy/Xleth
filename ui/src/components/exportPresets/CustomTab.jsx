import React, { useEffect, useState } from 'react'
import { customAspectMismatch, buildExportConfig, describeExportSummary } from './presets.js'

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

/**
 * Custom preset tab — exposes only what the FFmpegMuxer backend actually
 * supports (MP4 container, H.264/H.265/AV1/DNxHD/ProRes video, AAC/Opus/FLAC/PCM
 * audio). Save/Load/Delete preset controls live at the bottom.
 */
export default function CustomTab({
  settings,
  onChange,
  outputPath,
  onBrowse,
  running,
  projectCanvas,      // { canvasWidth, canvasHeight, canvasAspectRatio, previewFps }
  presets,            // array of { name, settings }
  onSavePreset,       // (name, settings) => void
  onLoadPreset,       // (name) => void
  onDeletePreset,     // (name) => void
}) {
  const [availableEncoders, setAvailableEncoders] = useState([])
  const [selectedPreset, setSelectedPreset] = useState('')

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

  const handleSavePreset = () => {
    const name = window.prompt('Save preset as:')
    if (!name) return
    onSavePreset(name.trim(), settings)
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

  return (
    <div className="export-tab-panel">
      <div className="export-tab-desc">
        Custom export settings for codec, resolution, frame rate, quality, and audio.
      </div>

      {/* ── Preset row ─────────────────────────────────────────────────────── */}
      <div className="export-row">
        <label>Preset</label>
        <div className="custom-preset-row">
          <select value={selectedPreset}
                  onChange={(e) => loadSelected(e.target.value)}
                  disabled={running}>
            <option value="">— None —</option>
            {presets.map((p) => (
              <option key={p.name} value={p.name}>{p.name}</option>
            ))}
          </select>
          <button onClick={handleSavePreset} disabled={running}>Save…</button>
          <button onClick={handleDeletePreset} disabled={running || !selectedPreset}>Delete</button>
        </div>
      </div>

      <div className="export-row">
        <label>Video Codec</label>
        <select value={settings.videoCodec}
                onChange={(e) => onChange({ videoCodec: e.target.value })}
                disabled={running}>
          <option value="h264">H.264</option>
          <option value="h265">H.265 / HEVC</option>
          <option value="av1">AV1</option>
          <option value="prores">ProRes</option>
          <option value="dnxhd">DNxHD</option>
        </select>
      </div>

      <div className="export-row">
        <label>Encoder Device</label>
        <select value={settings.hwEncoder}
                onChange={(e) => onChange({ hwEncoder: e.target.value })}
                disabled={running || !availableEncoders.length}>
          {availableEncoders.length === 0 && <option value="">Software only</option>}
          {availableEncoders.map((e) => (
            <option key={e.name} value={e.name}>{e.displayName || e.name}</option>
          ))}
        </select>
      </div>

      <div className="export-row">
        <label>Resolution</label>
        <select value={settings.resolution}
                onChange={(e) => onChange({ resolution: e.target.value })}
                disabled={running}>
          <option value="1920x1080">1920 × 1080</option>
          <option value="1280x720">1280 × 720</option>
          <option value="3840x2160">3840 × 2160 (4K)</option>
          <option value="custom">Custom…</option>
        </select>
      </div>

      {settings.resolution === 'custom' && (
        <div className="export-row">
          <label>Size</label>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="number" min={128} max={7680} step={2}
                   value={settings.customWidth}
                   onChange={(e) => onChange({ customWidth: Number(e.target.value) })}
                   disabled={running} style={{ width: 80 }} />
            <span style={{ opacity: 0.5 }}>×</span>
            <input type="number" min={128} max={4320} step={2}
                   value={settings.customHeight}
                   onChange={(e) => onChange({ customHeight: Number(e.target.value) })}
                   disabled={running} style={{ width: 80 }} />
          </div>
        </div>
      )}

      <div className="export-row">
        <label>Frame Rate</label>
        <select value={settings.fps}
                onChange={(e) => onChange({ fps: Number(e.target.value) })}
                disabled={running}>
          {![60, 30, 24].includes(Number(settings.fps)) && (
            <option value={settings.fps}>{settings.fps} fps</option>
          )}
          <option value={60}>60 fps</option>
          <option value={30}>30 fps</option>
          <option value={24}>24 fps</option>
        </select>
      </div>

      {/* ── Fit mode — only when the output aspect differs from the project ──── */}
      {aspectMismatch && (
        <div className="export-row export-row-fit">
          <label>Fit to canvas</label>
          <div className="custom-fit-modes">
            <div className="custom-fit-buttons">
              {[
                { id: 'crop',    label: 'Crop to fill',  hint: 'Preserve proportions, fill output, crop edges.' },
                { id: 'stretch', label: 'Stretch to fit', hint: 'Scale directly into output, allowing distortion.' },
                { id: 'bars',    label: 'Fit with bars',  hint: 'Preserve proportions, letterbox / pillarbox.' },
              ].map((m) => (
                <button key={m.id} type="button"
                        className={`custom-fit-btn ${settings.fitMode === m.id ? 'active' : ''}`}
                        onClick={() => onChange({ fitMode: m.id })}
                        disabled={running}
                        title={m.hint}>
                  {m.label}
                </button>
              ))}
            </div>
            <div className={`custom-fit-hint ${settings.fitMode ? '' : 'required'}`}>
              {settings.fitMode
                ? ({ crop: 'Preserve proportions, fill output, crop edges.',
                     stretch: 'Scale directly into output, allowing distortion.',
                     bars: 'Preserve proportions, letterbox / pillarbox.' }[settings.fitMode])
                : `Output aspect differs from the project (${projectCanvas?.canvasAspectRatio || 'canvas'}). Choose a fit mode to export.`}
            </div>
          </div>
        </div>
      )}

      <div className="export-row">
        <label>Rate Control</label>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <label><input type="radio" checked={settings.useCrf}
                         onChange={() => onChange({ useCrf: true })}
                         disabled={running} /> Quality (CRF)</label>
          <label><input type="radio" checked={!settings.useCrf}
                         onChange={() => onChange({ useCrf: false })}
                         disabled={running} /> Target Bitrate</label>
        </div>
      </div>

      {settings.useCrf ? (
        <div className="export-row">
          <label>Quality (CRF)</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="range" min={0} max={51} step={1} value={settings.crf}
                   onChange={(e) => onChange({ crf: Number(e.target.value) })}
                   disabled={running} style={{ flex: 1 }} />
            <span style={{ minWidth: 28, textAlign: 'right' }}>{settings.crf}</span>
          </div>
        </div>
      ) : (
        <div className="export-row">
          <label>Target Bitrate (Mbps)</label>
          <input type="number" min={1} max={200} step={1}
                 value={settings.videoBitrate}
                 onChange={(e) => onChange({ videoBitrate: Number(e.target.value) })}
                 disabled={running} />
        </div>
      )}

      <div style={{ borderTop: '1px solid var(--theme-border-subtle)', margin: '4px 0', opacity: 0.3 }} />

      <div className="export-row">
        <label>Audio Codec</label>
        <select value={settings.audioCodec}
                onChange={(e) => onChange({ audioCodec: e.target.value })}
                disabled={running}>
          <option value="aac">AAC</option>
          <option value="opus">Opus</option>
          <option value="flac">FLAC</option>
          <option value="pcm_s16le">PCM (uncompressed)</option>
        </select>
      </div>

      <div className="export-row">
        <label>Sample Rate</label>
        <select value={settings.sampleRate}
                onChange={(e) => onChange({ sampleRate: Number(e.target.value) })}
                disabled={running}>
          <option value={48000}>48 000 Hz</option>
          <option value={44100}>44 100 Hz</option>
        </select>
      </div>

      {(settings.audioCodec === 'aac' || settings.audioCodec === 'opus') && (
        <div className="export-row">
          <label>Audio Bitrate</label>
          <select value={settings.audioBitrate}
                  onChange={(e) => onChange({ audioBitrate: Number(e.target.value) })}
                  disabled={running}>
            <option value={128}>128 kbps</option>
            <option value={192}>192 kbps</option>
            <option value={256}>256 kbps</option>
            <option value={384}>384 kbps</option>
          </select>
        </div>
      )}

      <div className="export-row">
        <label></label>
        <div className="export-bitrate-readout" title="Final encoded output">
          {outputSummary}
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
