import { useEffect, useState, useCallback } from 'react'
import ProgressBar from './ProgressBar.jsx'
import TailRenderControls from './TailRenderControls.jsx'
import { BEATS_PER_BAR } from '../constants/timeline.js'
import { getPickerPath, openFilePicker } from './filePicker/filePickerService.js'
import { PLATFORM_TARGETS, DEFAULT_PLATFORM_TARGET } from '../constants/loudnessTargets.js'

const LOUDNESS_TARGET_STORAGE_KEY = 'xleth.export.loudnessTarget'
const NO_MEASUREMENT_SENTINEL = -200.0

function formatLufs(v) {
  return v <= NO_MEASUREMENT_SENTINEL ? '—' : `${v.toFixed(1)} LUFS`
}

function formatDb(v) {
  return v <= NO_MEASUREMENT_SENTINEL ? '—' : `${v.toFixed(1)} dB`
}

function formatDbtp(v) {
  return v <= NO_MEASUREMENT_SENTINEL ? '—' : `${v.toFixed(1)} dBTP`
}

// ── Audio export dialog ──────────────────────────────────────────────────────
// Drives the C++ AudioExporter via the xleth.audio bridge. Subscribes to
// 'export:progress' events streamed from the main process (100 ms poll).

export default function ExportDialog({ isOpen, onClose }) {
  const [format, setFormat] = useState('wav')
  const [sampleRate, setSampleRate] = useState(44100)
  const [bitDepth, setBitDepth] = useState(24)
  const [mp3Bitrate, setMp3Bitrate] = useState(320)
  const [flacLevel, setFlacLevel] = useState(5)
  const [startBar, setStartBar] = useState(1)
  const [endBar, setEndBar] = useState(0) // 0 = auto
  const [outputPath, setOutputPath] = useState('')

  const [platformTarget, setPlatformTarget] = useState(DEFAULT_PLATFORM_TARGET)
  const [customTargetLufs, setCustomTargetLufs] = useState(-14)
  const [customMaxDbtp, setCustomMaxDbtp] = useState(-1)

  const [phase, setPhase] = useState('idle') // idle | running | done | error | cancelled
  const [progress, setProgress] = useState(0)
  const [errorMsg, setErrorMsg] = useState('')
  const [normReport, setNormReport] = useState(null)

  // Subscribe to progress updates while dialog is open
  useEffect(() => {
    if (!isOpen) return
    const unsub = window.xleth?.audio?.onExportProgress?.((p) => {
      if (!p) return
      setProgress(p.percent ?? 0)
      if (p.running) {
        setPhase('running')
      } else {
        if (p.phase === 'done')            { setPhase('done'); setProgress(1); setNormReport(p.normalization || null) }
        else if (p.phase === 'cancelled')  setPhase('cancelled')
        else                               { setPhase('error'); setErrorMsg(p.error || 'Export failed') }
      }
    })
    return unsub
  }, [isOpen])

  // Reset ephemeral state whenever the dialog opens, and restore the last
  // selected loudness platform target.
  useEffect(() => {
    if (isOpen) {
      setPhase('idle')
      setProgress(0)
      setErrorMsg('')
      setNormReport(null)
      const saved = localStorage.getItem(LOUDNESS_TARGET_STORAGE_KEY)
      if (saved && PLATFORM_TARGETS[saved]) setPlatformTarget(saved)
    }
  }, [isOpen])

  const selectPlatformTarget = useCallback((key) => {
    setPlatformTarget(key)
    localStorage.setItem(LOUDNESS_TARGET_STORAGE_KEY, key)
  }, [])

  const browse = useCallback(async () => {
    const defName = `export.${format}`
    const picked = await openFilePicker({
      mode: 'saveFile',
      title: 'Export Audio As',
      subtitle: 'Choose the audio render destination.',
      actionLabel: 'Export',
      defaultName: defName,
      defaultExtension: format,
      filters: [{ name: `${format.toUpperCase()} Audio`, extensions: [format] }],
      legacyPicker: () => window.xleth.audio.exportSaveAsDialog(defName, format),
    })
    const p = getPickerPath(picked)
    if (p) setOutputPath(p)
  }, [format])

  const start = useCallback(async () => {
    if (!outputPath) {
      setErrorMsg('Choose an output file first')
      setPhase('error')
      return
    }
    setErrorMsg('')
    setPhase('running')
    setProgress(0)
    const cfg = {
      outputPath,
      format,
      sampleRate: Number(sampleRate),
      bitDepth: Number(bitDepth),
      mp3Bitrate: Number(mp3Bitrate),
      flacLevel: Number(flacLevel),
    }
    if (platformTarget !== 'none') {
      const target = PLATFORM_TARGETS[platformTarget]
      cfg.normalizationEnabled = true
      cfg.targetLufs = platformTarget === 'custom' ? Number(customTargetLufs) : target.targetLufs
      cfg.maxDbtp = platformTarget === 'custom' ? Number(customMaxDbtp) : target.maxDbtp
      cfg.allowUpwardGain = target.allowUpwardGain
    }
    // Phase 2: the render scope derives from the project LoopRegion. The manual
    // Start/End Bar inputs are dev-only and sent solely as a debug bounds
    // override (the native side gates them too).
    if (import.meta.env.DEV) {
      const sBar = Math.max(1, Number(startBar) || 1)
      const eBar = Number(endBar) || 0
      cfg.startBeat = (sBar - 1) * BEATS_PER_BAR               // Bar 1 → beat 0
      cfg.endBeat   = eBar > 0 ? eBar * BEATS_PER_BAR : 0      // End Bar 8 → beat 32 (8 bars)
    }
    console.log('[Export] Starting:', cfg)
    const ok = await window.xleth.audio.exportStart(cfg)
    if (!ok) {
      setPhase('error')
      setErrorMsg('Failed to start export (already running?)')
    }
  }, [outputPath, format, sampleRate, bitDepth, mp3Bitrate, flacLevel, startBar, endBar,
      platformTarget, customTargetLufs, customMaxDbtp])

  const cancel = useCallback(async () => {
    await window.xleth.audio.exportCancel()
  }, [])

  const openFolder = useCallback(() => {
    if (outputPath) window.xleth.shell.showItemInFolder(outputPath)
  }, [outputPath])

  if (!isOpen) return null

  const running = phase === 'running'
  const finished = phase === 'done' || phase === 'error' || phase === 'cancelled'

  // The select is disabled while running, so platformTarget still reflects
  // whatever ceiling was actually sent to the engine for this render.
  const activeMaxDbtp = platformTarget === 'custom'
    ? Number(customMaxDbtp)
    : PLATFORM_TARGETS[platformTarget]?.maxDbtp ?? 0
  const peakMeasured = normReport && normReport.finalPredictedTruePeakDbtp > NO_MEASUREMENT_SENTINEL
  const peakPass = peakMeasured && normReport.finalPredictedTruePeakDbtp <= activeMaxDbtp

  return (
    <div className="export-dialog-backdrop" onClick={() => { if (!running) onClose() }}>
      <div className="export-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="export-dialog-header">
          <span>Export Audio</span>
          <button
            className="export-dialog-close"
            onClick={onClose}
            disabled={running}
            title={running ? 'Cancel export first' : 'Close'}
          >×</button>
        </div>

        <div className="export-dialog-body">
          {/* ── Format ─────────────────────────────────────────────────── */}
          <div className="export-row">
            <label>Format</label>
            <select value={format} onChange={(e) => setFormat(e.target.value)} disabled={running}>
              <option value="wav">WAV</option>
              <option value="mp3">MP3</option>
              <option value="flac">FLAC</option>
            </select>
          </div>

          {/* ── Sample rate ────────────────────────────────────────────── */}
          <div className="export-row">
            <label>Sample Rate</label>
            <select value={sampleRate} onChange={(e) => setSampleRate(Number(e.target.value))} disabled={running}>
              <option value={44100}>44100 Hz</option>
              <option value={48000}>48000 Hz</option>
            </select>
          </div>

          {/* ── Format-specific options ────────────────────────────────── */}
          {format === 'wav' && (
            <div className="export-row">
              <label>Bit Depth</label>
              <select value={bitDepth} onChange={(e) => setBitDepth(Number(e.target.value))} disabled={running}>
                <option value={16}>16-bit PCM</option>
                <option value={24}>24-bit PCM</option>
                <option value={32}>32-bit Float</option>
              </select>
            </div>
          )}

          {format === 'mp3' && (
            <div className="export-row">
              <label>Bitrate</label>
              <select value={mp3Bitrate} onChange={(e) => setMp3Bitrate(Number(e.target.value))} disabled={running}>
                <option value={128}>128 kbps</option>
                <option value={192}>192 kbps</option>
                <option value={256}>256 kbps</option>
                <option value={320}>320 kbps</option>
              </select>
            </div>
          )}

          {format === 'flac' && (
            <div className="export-row">
              <label>Compression</label>
              <select value={flacLevel} onChange={(e) => setFlacLevel(Number(e.target.value))} disabled={running}>
                {Array.from({ length: 9 }, (_, i) => (
                  <option key={i} value={i}>Level {i}{i === 0 ? ' (fastest)' : i === 8 ? ' (smallest)' : ''}</option>
                ))}
              </select>
            </div>
          )}

          {/* ── Range (dev-only debug override) ────────────────────────────
              Normal exports scope to the project LoopRegion. These manual bars
              are a developer-only bounds override, hidden in production builds. */}
          {import.meta.env.DEV && (
            <>
              <div className="export-row">
                <label>Start Bar (debug)</label>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={startBar}
                  onChange={(e) => setStartBar(e.target.value)}
                  disabled={running}
                />
              </div>

              <div className="export-row">
                <label>End Bar (debug)</label>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={endBar}
                  onChange={(e) => setEndBar(e.target.value)}
                  disabled={running}
                  placeholder="0 = auto"
                />
              </div>
            </>
          )}

          {/* ── Loop render tail policy (Phase 3A) ─────────────────────── */}
          <div className="export-section-divider" />
          <TailRenderControls disabled={running} />

          {/* ── Loudness normalization ────────────────────────────────── */}
          <div className="export-section-divider" />
          <div className="loudness-normalization-controls">
            <div className="export-row">
              <label>Loudness Normalization</label>
              <select
                value={platformTarget}
                onChange={(e) => selectPlatformTarget(e.target.value)}
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
                    onChange={(e) => setCustomTargetLufs(e.target.value)}
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
                    onChange={(e) => setCustomMaxDbtp(e.target.value)}
                  />
                </div>
              </div>
            )}

            {platformTarget !== 'none' && (
              <div className="tail-help">
                Static gain only — no limiter. Protects against codec clipping on upload.
              </div>
            )}
          </div>

          {/* ── Output path ────────────────────────────────────────────── */}
          <div className="export-row export-row-path">
            <label>Output File</label>
            <div className="export-path-group">
              <input
                type="text"
                value={outputPath}
                onChange={(e) => setOutputPath(e.target.value)}
                placeholder="Click Browse…"
                disabled={running}
              />
              <button onClick={browse} disabled={running}>Browse…</button>
            </div>
          </div>

          {/* ── Progress ───────────────────────────────────────────────── */}
          {(running || finished) && (
            <div className="export-progress">
              <ProgressBar progress={progress} />
              <div className="export-progress-label">
                {phase === 'running' && (progress < 0.7 ? 'Rendering…' : 'Encoding…')}
                {phase === 'done' && 'Export complete.'}
                {phase === 'cancelled' && 'Export cancelled.'}
                {phase === 'error' && (errorMsg || 'Export failed.')}
                {' '}
                {running && `${Math.floor(progress * 100)}%`}
              </div>
              {phase === 'done' && normReport && (
                <div className="loudness-report">
                  <div className="loudness-report-row">
                    <span>Measured</span>
                    <span>{formatLufs(normReport.measuredIntegratedLufs)}</span>
                  </div>
                  <div className="loudness-report-row">
                    <span>Loudness gain</span>
                    <span>{formatDb(normReport.loudnessGainDb)}</span>
                  </div>
                  {normReport.peakSafetyGainDb !== 0 && (
                    <div className="loudness-report-row">
                      <span>Peak safety gain</span>
                      <span>{formatDb(normReport.peakSafetyGainDb)}</span>
                    </div>
                  )}
                  <div className="loudness-report-row">
                    <span>Final integrated</span>
                    <span>{formatLufs(normReport.finalPredictedIntegratedLufs)}</span>
                  </div>
                  <div className="loudness-report-row">
                    <span>Final true peak</span>
                    <span>
                      {formatDbtp(normReport.finalPredictedTruePeakDbtp)}
                      {peakMeasured && (
                        <>
                          {' '}
                          <span className={peakPass ? 'loudness-report-pass' : 'loudness-report-over'}>
                            {peakPass ? 'PASS' : 'OVER'}
                          </span>
                        </>
                      )}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="export-dialog-footer">
          {running ? (
            <button className="export-btn-danger" onClick={cancel}>Cancel</button>
          ) : phase === 'done' ? (
            <>
              <button onClick={openFolder}>Open Folder</button>
              <button className="export-btn-primary" onClick={onClose}>Close</button>
            </>
          ) : (
            <>
              <button onClick={onClose}>Close</button>
              <button className="export-btn-primary" onClick={start} disabled={!outputPath}>Export</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
