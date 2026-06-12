import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useToast } from './Toast.jsx'
import YouTubeTab from './exportPresets/YouTubeTab.jsx'
import DiscordTab from './exportPresets/DiscordTab.jsx'
import CustomTab, { makeCustomDefaults } from './exportPresets/CustomTab.jsx'
import ProgressPanel from './exportPresets/ProgressPanel.jsx'
import TailRenderControls from './TailRenderControls.jsx'
import {
  computeDiscordVideoBitrate,
  DISCORD_MIN_VIDEO_BITRATE,
  defaultExportPresets,
  buildExportConfig,
  customAspectMismatch,
  FIT_MODES,
  DEFAULT_PROJECT_CANVAS,
} from './exportPresets/presets.js'

export default function VideoExportDialog({ isOpen, onClose }) {
  const { showToast } = useToast()

  // ── Range ───────────────────────────────────────────────────────────
  // ── Output file (shared across all tabs) ───────────────────────────
  const [outputPath, setOutputPath] = useState('')

  // ── Per-tab settings ───────────────────────────────────────────────
  const [activeTab, setActiveTab]             = useState('youtube')
  const [youtubeSettings, setYoutubeSettings] = useState(
    () => defaultExportPresets().youtube
  )
  const [discordSettings, setDiscordSettings] = useState(
    () => defaultExportPresets().discord
  )
  const [customSettings, setCustomSettings]   = useState(() => makeCustomDefaults())
  const [customPresets, setCustomPresets]     = useState([])
  const [presetsLoaded, setPresetsLoaded]     = useState(false)

  // ── Project canvas (Grid Settings) — the export default source of truth ─────
  const [projectCanvas, setProjectCanvas]     = useState(DEFAULT_PROJECT_CANVAS)

  // ── Progress state ─────────────────────────────────────────────────
  const [phase, setPhase]         = useState('idle') // idle | running | done | error | cancelled
  const [progress, setProgress]   = useState(0)
  const [renderPhase, setRenderPhase] = useState(0)
  const [currentFrame, setCurrentFrame] = useState(0)
  const [totalFrames, setTotalFrames]   = useState(0)
  const [speed, setSpeed]               = useState(0)
  const [eta, setEta]                   = useState(0)
  const [errorMsg, setErrorMsg]         = useState('')
  const [renderFps, setRenderFps]       = useState(60)

  const saveTimerRef = useRef(null)
  const swEncoderNotifiedRef = useRef(false)

  // ── Per-export video mode override ───────────────────────────────────
  const [videoModeOverride, setVideoModeOverride] = useState('auto')

  // Load presets on mount (not on every open, so user changes survive close/reopen).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const stored = await window.xleth?.videoExport?.getExportPresets()
        if (cancelled || !stored) return
        if (stored.migrated) {
          showToast('Export presets were reset to defaults after an update.', 'info')
        }
        setYoutubeSettings({ ...defaultExportPresets().youtube, ...(stored.youtube || {}) })
        setDiscordSettings({ ...defaultExportPresets().discord, ...(stored.discord || {}) })
        setCustomPresets(Array.isArray(stored.custom) ? stored.custom : [])
        if (stored.lastTab === 'youtube' || stored.lastTab === 'discord' || stored.lastTab === 'custom') {
          setActiveTab(stored.lastTab)
        }
      } finally {
        if (!cancelled) setPresetsLoaded(true)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Persist YouTube / Discord / lastTab (not custom — that saves explicitly).
  useEffect(() => {
    if (!presetsLoaded) return
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      window.xleth?.videoExport?.saveExportPresets({
        lastTab:  activeTab,
        youtube:  youtubeSettings,
        discord:  discordSettings,
        custom:   customPresets,
      })
    }, 500)
    return () => clearTimeout(saveTimerRef.current)
  }, [activeTab, youtubeSettings, discordSettings, customPresets, presetsLoaded])

  // Subscribe to backend progress updates whenever the dialog is open.
  useEffect(() => {
    if (!isOpen) return
    swEncoderNotifiedRef.current = false
    const unsub = window.xleth?.videoExport?.onExportProgress?.((p) => {
      if (!p) return
      setProgress(p.percentage != null ? p.percentage / 100 : 0)
      setCurrentFrame(p.currentFrame ?? 0)
      setTotalFrames(p.totalFrames ?? 0)
      setSpeed(p.speed ?? 0)
      setEta(p.eta ?? 0)
      setRenderPhase(p.phase ?? 0)

      // Notify once if a software video encoder is active
      const encName = p.videoEncoderName
      if (encName && !swEncoderNotifiedRef.current) {
        const isSoftware = encName === 'mpeg4' || encName.startsWith('lib')
        if (isSoftware) {
          swEncoderNotifiedRef.current = true
          // Distinguish auto-fallback (HW tried and rejected) from explicit user choice
          // (p.videoEncoderFallback will be false when Software Video Mode is active)
          const msg = p.videoEncoderFallback
            ? `No hardware video encoder available — using ${encName} software encode. Export will be slower.`
            : `Using ${encName} software encode. Export will be slower.`
          showToast(msg, 'info')
        }
      }

      if (p.running) {
        setPhase('running')
      } else if (p.complete) {
        setPhase('done'); setProgress(1)
      } else if (p.failed) {
        setPhase('error'); setErrorMsg(p.error || 'Render failed')
      } else {
        setPhase('cancelled')
      }
    })
    return unsub
  }, [isOpen, showToast])

  // Reset progress and load global videoMode default whenever dialog opens.
  useEffect(() => {
    if (!isOpen) return
    setPhase('idle')
    setProgress(0)
    setRenderPhase(0)
    setCurrentFrame(0)
    setTotalFrames(0)
    setSpeed(0)
    setEta(0)
    setErrorMsg('')
    window.xleth?.settings?.get?.('videoMode').then(v => {
      setVideoModeOverride(['auto', 'software', 'hardware'].includes(v) ? v : 'auto')
    }).catch(() => setVideoModeOverride('auto'))

    // Pull the project canvas (Grid Settings) and default the export to it:
    //   • Custom is re-seeded from the project canvas (resolution/aspect/fps).
    //   • YouTube/Discord inherit the project frame rate as their default fps
    //     (they keep their platform-tuned resolutions — see exportPresets).
    ;(async () => {
      try {
        const gl = await window.xleth?.timeline?.getGridLayout()
        if (!gl) return
        const pc = {
          canvasWidth:       Number(gl.canvasWidth)  || DEFAULT_PROJECT_CANVAS.canvasWidth,
          canvasHeight:      Number(gl.canvasHeight) || DEFAULT_PROJECT_CANVAS.canvasHeight,
          canvasAspectRatio: gl.canvasAspectRatio || DEFAULT_PROJECT_CANVAS.canvasAspectRatio,
          previewFps:        Number(gl.previewFps)   || DEFAULT_PROJECT_CANVAS.previewFps,
        }
        setProjectCanvas(pc)
        setCustomSettings(makeCustomDefaults(pc))
        setYoutubeSettings(s => ({ ...s, fps: pc.previewFps }))
        setDiscordSettings(s => ({ ...s, fps: pc.previewFps }))
      } catch { /* keep DEFAULT_PROJECT_CANVAS */ }
    })()
  }, [isOpen])

  const running  = phase === 'running'
  const finished = phase === 'done' || phase === 'error' || phase === 'cancelled'

  // ── Handlers ───────────────────────────────────────────────────────
  const browse = useCallback(async () => {
    const p = await window.xleth?.videoExport?.exportSaveAsDialog('export.mp4')
    if (p) setOutputPath(p)
  }, [])

  const mergeYoutube = useCallback((patch) => setYoutubeSettings((s) => ({ ...s, ...patch })), [])
  const mergeDiscord = useCallback((patch) => setDiscordSettings((s) => ({ ...s, ...patch })), [])
  const mergeCustom  = useCallback((patch) => setCustomSettings((s) => ({ ...s, ...patch })), [])

  const handleSavePreset = useCallback((name, settings) => {
    if (!name) return
    setCustomPresets((list) => {
      const others = list.filter((p) => p.name !== name)
      return [...others, { name, settings: { ...settings } }]
    })
    showToast(`Preset "${name}" saved.`, 'success')
  }, [showToast])

  const handleLoadPreset = useCallback((name) => {
    const p = customPresets.find((x) => x.name === name)
    if (!p) return
    setCustomSettings({ ...makeCustomDefaults(), ...p.settings })
  }, [customPresets])

  const handleDeletePreset = useCallback((name) => {
    setCustomPresets((list) => list.filter((p) => p.name !== name))
  }, [])

  // ── Build backend cfg for the active tab ──────────────────────────
  const discordBitrate = useMemo(() => {
    // Compute once — needed for the Export disabled guard. Duration resolution
    // lives inside DiscordTab; here we recompute using the same helper.
    // For the guard we only care whether it's above MIN, so we need the dur.
    // Handled via state below, not here — leave.
    return 0
  }, [])

  // Track Discord minimum-bitrate block. DiscordTab updates this via onChange
  // (it already computes the bitrate internally for its own banners). We mirror
  // it via a derived computation from duration, kept in a ref so we don't
  // re-render on every duration tick.
  const [discordDurationSec, setDiscordDurationSec] = useState(0)
  useEffect(() => {
    if (activeTab !== 'discord') return
    let cancelled = false
    ;(async () => {
      try {
        const secs = await window.xleth?.videoExport?.computeDurationSeconds?.()
        if (!cancelled) setDiscordDurationSec(Number(secs) || 0)
      } catch {
        if (!cancelled) setDiscordDurationSec(0)
      }
    })()
    return () => { cancelled = true }
  }, [activeTab])

  const discordBelowMin = activeTab === 'discord'
    && discordDurationSec > 0
    && computeDiscordVideoBitrate(discordSettings.tier, discordDurationSec) < DISCORD_MIN_VIDEO_BITRATE

  const buildCfg = useCallback(() => buildExportConfig({
    activeTab,
    outputPath,
    youtubeSettings,
    discordSettings,
    customSettings,
    videoModeOverride,
    discordDurationSec,
    projectCanvas,
  }), [activeTab, outputPath, youtubeSettings,
      discordSettings, discordDurationSec, customSettings, videoModeOverride, projectCanvas])

  // Custom export whose aspect differs from the project must pick a fit mode
  // before it can run (crop / stretch / letterbox actually change the encode).
  const customFitRequired = activeTab === 'custom'
    && customAspectMismatch(customSettings, projectCanvas)
    && !FIT_MODES.includes(customSettings.fitMode)

  const activeFps = activeTab === 'youtube' ? youtubeSettings.fps
                  : activeTab === 'discord' ? discordSettings.fps
                  : customSettings.fps

  const start = useCallback(async () => {
    if (!outputPath) {
      showToast('Choose an output file first.', 'error')
      return
    }
    if (discordBelowMin) {
      showToast('Clip too long for this Discord tier. Trim the range or pick a higher tier.', 'error')
      return
    }
    if (customFitRequired) {
      showToast('Choose a fit mode — the custom output aspect differs from the project canvas.', 'error')
      return
    }
    setPhase('running')
    setProgress(0)
    setErrorMsg('')
    setRenderFps(Number(activeFps) || 60)
    const cfg = buildCfg()
    const ok = await window.xleth?.videoExport?.exportStart(cfg)
    if (!ok) {
      setPhase('error')
      setErrorMsg('Failed to start render (already running?)')
    }
  }, [outputPath, discordBelowMin, customFitRequired, buildCfg, activeFps, showToast])

  const cancel = useCallback(async () => {
    await window.xleth?.videoExport?.exportCancel()
  }, [])

  const openFile = useCallback(() => {
    if (outputPath) window.xleth?.shell?.openPath?.(outputPath)
  }, [outputPath])

  const openFolder = useCallback(() => {
    if (outputPath) window.xleth?.shell?.showItemInFolder?.(outputPath)
  }, [outputPath])

  if (!isOpen) return null

  const exportDisabled = !outputPath || discordBelowMin || customFitRequired

  return (
    <div className="export-dialog-backdrop" onClick={() => { if (!running) onClose() }}>
      <div className="export-dialog" onClick={(e) => e.stopPropagation()} style={{ width: 520 }}>
        <div className="export-dialog-header">
          <span>Export Video</span>
          <button
            className="export-dialog-close"
            onClick={onClose}
            disabled={running}
            title={running ? 'Cancel render first' : 'Close'}
          >×</button>
        </div>

        {/* Tab bar — hidden once export is running to keep the UI focused. */}
        {!running && !finished && (
          <div className="export-tab-bar">
            <button
              className={`export-tab ${activeTab === 'youtube' ? 'active' : ''}`}
              onClick={() => setActiveTab('youtube')}
            >YouTube</button>
            <button
              className={`export-tab ${activeTab === 'discord' ? 'active' : ''}`}
              onClick={() => setActiveTab('discord')}
            >Discord</button>
            <button
              className={`export-tab ${activeTab === 'custom' ? 'active' : ''}`}
              onClick={() => setActiveTab('custom')}
            >Custom</button>
          </div>
        )}

        <div className="export-dialog-body">
          {(running || finished) ? (
            <ProgressPanel
              phase={phase}
              renderPhase={renderPhase}
              progress={progress}
              currentFrame={currentFrame}
              totalFrames={totalFrames}
              speed={speed}
              eta={eta}
              errorMsg={errorMsg}
              outputPath={outputPath}
              fps={renderFps}
              onCancel={cancel}
              onOpenFile={openFile}
              onOpenFolder={openFolder}
              onClose={onClose}
            />
          ) : (
            <>
              <div className="export-row">
                <label>Encoder</label>
                <select
                  value={videoModeOverride}
                  onChange={e => setVideoModeOverride(e.target.value)}
                  style={{ fontSize: 12 }}
                >
                  <option value="auto">Auto</option>
                  <option value="software">Software Encoder</option>
                  <option value="hardware">Hardware Encoder Only</option>
                </select>
              </div>

              {/* Loop render tail policy (Phase 3A) — shared project LoopRegion. */}
              <div className="export-section-divider" />
              <TailRenderControls disabled={running} />
              <div className="export-section-divider" />

              {activeTab === 'youtube' && (
                <YouTubeTab
                  settings={youtubeSettings}
                  onChange={mergeYoutube}
                  outputPath={outputPath}
                  onBrowse={browse}
                  running={running}
                />
              )}
              {activeTab === 'discord' && (
                <DiscordTab
                  settings={discordSettings}
                  onChange={mergeDiscord}
                  outputPath={outputPath}
                  onBrowse={browse}
                  running={running}
                />
              )}
              {activeTab === 'custom' && (
                <CustomTab
                  settings={customSettings}
                  onChange={mergeCustom}
                  outputPath={outputPath}
                  onBrowse={browse}
                  running={running}
                  projectCanvas={projectCanvas}
                  presets={customPresets}
                  onSavePreset={handleSavePreset}
                  onLoadPreset={handleLoadPreset}
                  onDeletePreset={handleDeletePreset}
                />
              )}
            </>
          )}
        </div>

        {/* Footer hidden while ProgressPanel handles its own actions. */}
        {!running && !finished && (
          <div className="export-dialog-footer">
            <button onClick={onClose}>Close</button>
            <button
              className="export-btn-primary"
              onClick={start}
              disabled={exportDisabled}
            >Export</button>
          </div>
        )}
      </div>
    </div>
  )
}
