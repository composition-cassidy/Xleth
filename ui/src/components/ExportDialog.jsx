import { useEffect, useState, useCallback } from 'react'
import ProgressBar from './ProgressBar.jsx'
import TailRenderControls from './TailRenderControls.jsx'
import { BEATS_PER_BAR } from '../constants/timeline.js'

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

  const [phase, setPhase] = useState('idle') // idle | running | done | error | cancelled
  const [progress, setProgress] = useState(0)
  const [errorMsg, setErrorMsg] = useState('')

  // Subscribe to progress updates while dialog is open
  useEffect(() => {
    if (!isOpen) return
    const unsub = window.xleth?.audio?.onExportProgress?.((p) => {
      if (!p) return
      setProgress(p.percent ?? 0)
      if (p.running) {
        setPhase('running')
      } else {
        if (p.phase === 'done')            { setPhase('done'); setProgress(1) }
        else if (p.phase === 'cancelled')  setPhase('cancelled')
        else                               { setPhase('error'); setErrorMsg(p.error || 'Export failed') }
      }
    })
    return unsub
  }, [isOpen])

  // Reset ephemeral state whenever the dialog opens
  useEffect(() => {
    if (isOpen) {
      setPhase('idle')
      setProgress(0)
      setErrorMsg('')
    }
  }, [isOpen])

  const browse = useCallback(async () => {
    const defName = `export.${format}`
    const p = await window.xleth.audio.exportSaveAsDialog(defName, format)
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
  }, [outputPath, format, sampleRate, bitDepth, mp3Bitrate, flacLevel, startBar, endBar])

  const cancel = useCallback(async () => {
    await window.xleth.audio.exportCancel()
  }, [])

  const openFolder = useCallback(() => {
    if (outputPath) window.xleth.shell.showItemInFolder(outputPath)
  }, [outputPath])

  if (!isOpen) return null

  const running = phase === 'running'
  const finished = phase === 'done' || phase === 'error' || phase === 'cancelled'

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
                readOnly
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
