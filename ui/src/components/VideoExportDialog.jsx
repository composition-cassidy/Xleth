import { useEffect, useState, useCallback } from 'react'
import ProgressBar from './ProgressBar.jsx'
import { BEATS_PER_BAR } from '../constants/timeline.js'

// ── Video export dialog ─────────────────────────────────────────────────────
// Drives the C++ OfflineRenderer via the xleth.videoExport bridge. Subscribes
// to 'video-export:progress' events streamed from the main process (100 ms poll).

const PHASE_LABELS = {
  0: 'Preparing…',
  1: 'Preparing…',
  2: 'Rendering…',
  3: 'Finalizing…',
}

function formatEta(seconds) {
  if (!seconds || seconds <= 0) return ''
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return m > 0 ? `${m}m ${s}s left` : `${s}s left`
}

export default function VideoExportDialog({ isOpen, onClose }) {
  // ── Video settings ──────────────────────────────────────────────────
  const [videoCodec, setVideoCodec]     = useState('h264')
  const [resolution, setResolution]     = useState('1920x1080')
  const [customWidth, setCustomWidth]   = useState(1920)
  const [customHeight, setCustomHeight] = useState(1080)
  const [fps, setFps]                   = useState(60)
  const [crf, setCrf]                   = useState(18)
  const [videoBitrate, setVideoBitrate] = useState(20)  // Mbps

  // ── Audio settings ──────────────────────────────────────────────────
  const [audioCodec, setAudioCodec]     = useState('aac')
  const [sampleRate, setSampleRate]     = useState(48000)
  const [audioBitrate, setAudioBitrate] = useState(384)

  // ── Range ───────────────────────────────────────────────────────────
  const [startBar, setStartBar] = useState(1)
  const [endBar, setEndBar]     = useState(0)   // 0 = auto

  // ── Output ──────────────────────────────────────────────────────────
  const [outputPath, setOutputPath] = useState('')

  // ── Encoder detection ───────────────────────────────────────────────
  const [hwEncoder, setHwEncoder]               = useState('')
  const [availableEncoders, setAvailableEncoders] = useState([])

  // ── Progress state ──────────────────────────────────────────────────
  const [phase, setPhase]       = useState('idle') // idle | running | done | error | cancelled
  const [progress, setProgress] = useState(0)
  const [errorMsg, setErrorMsg] = useState('')
  const [currentFrame, setCurrentFrame] = useState(0)
  const [totalFrames, setTotalFrames]   = useState(0)
  const [speed, setSpeed]       = useState(0)
  const [eta, setEta]           = useState(0)
  const [renderPhase, setRenderPhase] = useState(0)

  // ── Fetch encoders when codec changes ───────────────────────────────
  useEffect(() => {
    if (!isOpen) return
    ;(async () => {
      try {
        const encs = await window.xleth?.videoExport?.getAvailableEncoders(videoCodec)
        setAvailableEncoders(encs || [])
        const def = await window.xleth?.videoExport?.getDefaultEncoder(videoCodec)
        setHwEncoder(def || '')
      } catch {
        setAvailableEncoders([])
        setHwEncoder('')
      }
    })()
  }, [videoCodec, isOpen])

  // ── Subscribe to progress updates while dialog is open ──────────────
  useEffect(() => {
    if (!isOpen) return
    const unsub = window.xleth?.videoExport?.onExportProgress?.((p) => {
      if (!p) return
      setProgress(p.percentage != null ? p.percentage / 100 : 0)
      setCurrentFrame(p.currentFrame ?? 0)
      setTotalFrames(p.totalFrames ?? 0)
      setSpeed(p.speed ?? 0)
      setEta(p.eta ?? 0)
      setRenderPhase(p.phase ?? 0)
      if (p.running) {
        setPhase('running')
      } else {
        if (p.complete)     { setPhase('done'); setProgress(1) }
        else if (p.failed)  { setPhase('error'); setErrorMsg(p.error || 'Render failed') }
        else                  setPhase('cancelled')
      }
    })
    return unsub
  }, [isOpen])

  // ── Reset ephemeral state whenever the dialog opens ─────────────────
  useEffect(() => {
    if (isOpen) {
      setPhase('idle')
      setProgress(0)
      setErrorMsg('')
      setCurrentFrame(0)
      setTotalFrames(0)
      setSpeed(0)
      setEta(0)
      setRenderPhase(0)
    }
  }, [isOpen])

  // ── Computed resolution values ──────────────────────────────────────
  const getResolution = useCallback(() => {
    if (resolution === 'custom') return { w: Number(customWidth), h: Number(customHeight) }
    const [w, h] = resolution.split('x').map(Number)
    return { w, h }
  }, [resolution, customWidth, customHeight])

  // ── Handlers ────────────────────────────────────────────────────────
  const browse = useCallback(async () => {
    const p = await window.xleth?.videoExport?.exportSaveAsDialog('export.mp4')
    if (p) setOutputPath(p)
  }, [])

  const start = useCallback(async () => {
    if (!outputPath) {
      setErrorMsg('Choose an output file first')
      setPhase('error')
      return
    }
    setErrorMsg('')
    setPhase('running')
    setProgress(0)

    const sBar = Math.max(1, Number(startBar) || 1)
    const eBar = Number(endBar) || 0
    const { w, h } = getResolution()

    const cfg = {
      outputPath,
      videoCodec,
      hwEncoder,
      width:        w,
      height:       h,
      fpsNum:       Number(fps),
      fpsDen:       1,
      crf:          Number(crf),
      videoBitrate: Number(videoBitrate) * 1000000,   // Mbps → bps
      audioCodec,
      sampleRate:   Number(sampleRate),
      audioBitrate: Number(audioBitrate),
      startBeat:    (sBar - 1) * BEATS_PER_BAR,
      endBeat:      eBar > 0 ? eBar * BEATS_PER_BAR : -1.0,
    }
    console.log('[VideoExport] Starting:', cfg)
    const ok = await window.xleth.videoExport.exportStart(cfg)
    if (!ok) {
      setPhase('error')
      setErrorMsg('Failed to start render (already running?)')
    }
  }, [outputPath, videoCodec, hwEncoder, fps, crf, videoBitrate,
      audioCodec, sampleRate, audioBitrate, startBar, endBar, getResolution])

  const cancel = useCallback(async () => {
    await window.xleth?.videoExport?.exportCancel()
  }, [])

  const openFolder = useCallback(() => {
    if (outputPath) window.xleth.shell.showItemInFolder(outputPath)
  }, [outputPath])

  if (!isOpen) return null

  const running  = phase === 'running'
  const finished = phase === 'done' || phase === 'error' || phase === 'cancelled'

  // Encoder display name
  const encoderDisplay = availableEncoders.find(e => e.name === hwEncoder)?.displayName
    || hwEncoder || 'auto'

  return (
    <div className="export-dialog-backdrop" onClick={() => { if (!running) onClose() }}>
      <div className="export-dialog" onClick={(e) => e.stopPropagation()} style={{ width: 480 }}>
        <div className="export-dialog-header">
          <span>Export Video</span>
          <button
            className="export-dialog-close"
            onClick={onClose}
            disabled={running}
            title={running ? 'Cancel render first' : 'Close'}
          >×</button>
        </div>

        <div className="export-dialog-body">
          {/* ── Video Codec ───────────────────────────────────────────── */}
          <div className="export-row">
            <label>Video Codec</label>
            <select value={videoCodec} onChange={(e) => setVideoCodec(e.target.value)} disabled={running}>
              <option value="h264">H.264 (MP4)</option>
              <option value="h265">H.265 / HEVC</option>
              <option value="av1">AV1</option>
              <option value="prores">ProRes</option>
              <option value="dnxhd">DNxHD</option>
            </select>
          </div>

          {/* ── Encoder (auto-detected) ───────────────────────────────── */}
          <div className="export-row">
            <label>Encoder</label>
            <span className="export-encoder-label">{encoderDisplay}</span>
          </div>

          {/* ── Resolution ────────────────────────────────────────────── */}
          <div className="export-row">
            <label>Resolution</label>
            <select value={resolution} onChange={(e) => setResolution(e.target.value)} disabled={running}>
              <option value="1920x1080">1920 × 1080 (1080p)</option>
              <option value="1280x720">1280 × 720 (720p)</option>
              <option value="3840x2160">3840 × 2160 (4K)</option>
              <option value="custom">Custom…</option>
            </select>
          </div>

          {resolution === 'custom' && (
            <div className="export-row">
              <label>Size</label>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="number" min={128} max={7680} step={2} value={customWidth}
                  onChange={(e) => setCustomWidth(e.target.value)} disabled={running} style={{ width: 80 }} />
                <span style={{ opacity: 0.5 }}>×</span>
                <input type="number" min={128} max={4320} step={2} value={customHeight}
                  onChange={(e) => setCustomHeight(e.target.value)} disabled={running} style={{ width: 80 }} />
              </div>
            </div>
          )}

          {/* ── Frame Rate ────────────────────────────────────────────── */}
          <div className="export-row">
            <label>Frame Rate</label>
            <select value={fps} onChange={(e) => setFps(Number(e.target.value))} disabled={running}>
              <option value={60}>60 fps</option>
              <option value={30}>30 fps</option>
              <option value={24}>24 fps</option>
            </select>
          </div>

          {/* ── Quality (CRF) ─────────────────────────────────────────── */}
          <div className="export-row">
            <label>Quality (CRF)</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="range" min={0} max={51} step={1} value={crf}
                onChange={(e) => setCrf(Number(e.target.value))} disabled={running}
                style={{ flex: 1 }} />
              <span style={{ minWidth: 28, textAlign: 'right', fontSize: 12, opacity: 0.7 }}>{crf}</span>
            </div>
          </div>

          {/* ── Video Bitrate (fallback) ──────────────────────────────── */}
          <div className="export-row">
            <label>Bitrate (Mbps)</label>
            <input type="number" min={1} max={200} step={1} value={videoBitrate}
              onChange={(e) => setVideoBitrate(e.target.value)} disabled={running} />
          </div>

          {/* ── Audio section divider ─────────────────────────────────── */}
          <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0', opacity: 0.3 }} />

          {/* ── Audio Codec ───────────────────────────────────────────── */}
          <div className="export-row">
            <label>Audio Codec</label>
            <select value={audioCodec} onChange={(e) => setAudioCodec(e.target.value)} disabled={running}>
              <option value="aac">AAC</option>
              <option value="opus">Opus</option>
              <option value="flac">FLAC</option>
              <option value="pcm_s16le">PCM (uncompressed)</option>
            </select>
          </div>

          {/* ── Audio Sample Rate ─────────────────────────────────────── */}
          <div className="export-row">
            <label>Sample Rate</label>
            <select value={sampleRate} onChange={(e) => setSampleRate(Number(e.target.value))} disabled={running}>
              <option value={48000}>48000 Hz</option>
              <option value={44100}>44100 Hz</option>
            </select>
          </div>

          {/* ── Audio Bitrate ─────────────────────────────────────────── */}
          {(audioCodec === 'aac' || audioCodec === 'opus') && (
            <div className="export-row">
              <label>Audio Bitrate</label>
              <select value={audioBitrate} onChange={(e) => setAudioBitrate(Number(e.target.value))} disabled={running}>
                <option value={128}>128 kbps</option>
                <option value={192}>192 kbps</option>
                <option value={256}>256 kbps</option>
                <option value={384}>384 kbps</option>
              </select>
            </div>
          )}

          {/* ── Range divider ─────────────────────────────────────────── */}
          <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0', opacity: 0.3 }} />

          {/* ── Range ─────────────────────────────────────────────────── */}
          <div className="export-row">
            <label>Start Bar</label>
            <input type="number" min={1} step={1} value={startBar}
              onChange={(e) => setStartBar(e.target.value)} disabled={running} />
          </div>

          <div className="export-row">
            <label>End Bar</label>
            <input type="number" min={0} step={1} value={endBar}
              onChange={(e) => setEndBar(e.target.value)} disabled={running}
              placeholder="0 = auto" />
          </div>

          {/* ── Output path ───────────────────────────────────────────── */}
          <div className="export-row export-row-path">
            <label>Output File</label>
            <div className="export-path-group">
              <input type="text" value={outputPath}
                onChange={(e) => setOutputPath(e.target.value)}
                placeholder="Click Browse…" disabled={running} readOnly />
              <button onClick={browse} disabled={running}>Browse…</button>
            </div>
          </div>

          {/* ── Progress ──────────────────────────────────────────────── */}
          {(running || finished) && (
            <div className="export-progress">
              <ProgressBar progress={progress} />
              <div className="export-progress-label">
                {phase === 'running' && (PHASE_LABELS[renderPhase] || 'Rendering…')}
                {phase === 'done' && 'Render complete.'}
                {phase === 'cancelled' && 'Render cancelled.'}
                {phase === 'error' && (errorMsg || 'Render failed.')}
                {' '}
                {running && `${Math.floor(progress * 100)}%`}
              </div>
              {running && (
                <div className="export-progress-stats">
                  <span>Frame {currentFrame} / {totalFrames}</span>
                  <span>{speed > 0 ? `${speed.toFixed(1)}× realtime` : ''}</span>
                  <span>{formatEta(eta)}</span>
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
