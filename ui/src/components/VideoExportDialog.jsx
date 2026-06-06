import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BEATS_PER_BAR } from '../constants/timeline.js'
import { useToast } from './Toast.jsx'
import YouTubeTab from './exportPresets/YouTubeTab.jsx'
import DiscordTab from './exportPresets/DiscordTab.jsx'
import CustomTab, { makeCustomDefaults } from './exportPresets/CustomTab.jsx'
import ProgressPanel from './exportPresets/ProgressPanel.jsx'
import {
  YOUTUBE_RESOLUTIONS,
  computeYoutubeBitrate,
  computeDiscordVideoBitrate,
  DISCORD_MIN_VIDEO_BITRATE,
  defaultExportPresets,
} from './exportPresets/presets.js'

// Parses "1920x1080" or "custom" with width/height fields into pixel dims.
function customResolutionPx(settings) {
  if (settings.resolution === 'custom') {
    return { w: Number(settings.customWidth) || 1920, h: Number(settings.customHeight) || 1080 }
  }
  const [w, h] = String(settings.resolution).split('x').map(Number)
  return { w: w || 1920, h: h || 1080 }
}

const DISCORD_WIDTH  = 1280
const DISCORD_HEIGHT = 720

export default function VideoExportDialog({ isOpen, onClose }) {
  const { showToast } = useToast()

  // ── Range ───────────────────────────────────────────────────────────
  const [startBar, setStartBar] = useState(1)
  const [endBar, setEndBar]     = useState(0)

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
        const s = Math.max(0, (Number(startBar) - 1) * BEATS_PER_BAR)
        const e = Number(endBar) > 0 ? Number(endBar) * BEATS_PER_BAR : -1
        const secs = await window.xleth?.videoExport?.computeDurationSeconds?.(s, e)
        if (!cancelled) setDiscordDurationSec(Number(secs) || 0)
      } catch {
        if (!cancelled) setDiscordDurationSec(0)
      }
    })()
    return () => { cancelled = true }
  }, [activeTab, startBar, endBar])

  const discordBelowMin = activeTab === 'discord'
    && discordDurationSec > 0
    && computeDiscordVideoBitrate(discordSettings.tier, discordDurationSec) < DISCORD_MIN_VIDEO_BITRATE

  const buildCfg = useCallback(() => {
    // Phase 2: the render scope derives from the project LoopRegion. The manual
    // Start/End Bar inputs are dev-only and forwarded solely as a debug bounds
    // override (the native side gates them too). In production builds no
    // start/end beats are sent, so the bridge uses the LoopRegion.
    const debugRange = {}
    if (import.meta.env.DEV) {
      const sBar = Math.max(1, Number(startBar) || 1)
      const eBar = Number(endBar) || 0
      debugRange.startBeat = (sBar - 1) * BEATS_PER_BAR
      debugRange.endBeat   = eBar > 0 ? eBar * BEATS_PER_BAR : -1.0
    }

    if (activeTab === 'youtube') {
      const res = YOUTUBE_RESOLUTIONS.find((r) => r.id === youtubeSettings.resolution)
                || YOUTUBE_RESOLUTIONS[0]
      const bps = computeYoutubeBitrate(res.width, res.height, youtubeSettings.fps, youtubeSettings.quality)
      return {
        outputPath,
        videoCodec:   'h264',
        hwEncoder:    youtubeSettings.hwEncoder || '',
        videoMode:    videoModeOverride || 'auto',
        width:        res.width,
        height:       res.height,
        fpsNum:       Number(youtubeSettings.fps),
        fpsDen:       1,
        videoBitrate: bps,
        audioCodec:   'aac',
        sampleRate:   48000,
        audioBitrate: 384,
        // Final-quality export — bypass DNxHR proxy substitution so the encoder
        // sees original-source pixels (otherwise CRF/bitrate operate on already-
        // degraded preview-grade input).
        useSourceMedia: true,
        ...debugRange,
      }
    }

    if (activeTab === 'discord') {
      const bps = computeDiscordVideoBitrate(discordSettings.tier, discordDurationSec)
      return {
        outputPath,
        videoCodec:   'h264',
        hwEncoder:    discordSettings.hwEncoder || '',
        videoMode:    videoModeOverride || 'auto',
        width:        DISCORD_WIDTH,
        height:       DISCORD_HEIGHT,
        fpsNum:       Number(discordSettings.fps),
        fpsDen:       1,
        videoBitrate: bps,
        audioCodec:   'opus',
        sampleRate:   44100,
        audioBitrate: 256,
        useSourceMedia: true,
        ...debugRange,
      }
    }

    // Custom
    const { w, h } = customResolutionPx(customSettings)
    const cfg = {
      outputPath,
      videoCodec:   customSettings.videoCodec,
      hwEncoder:    customSettings.hwEncoder || '',
      videoMode:    videoModeOverride || 'auto',
      width:        w,
      height:       h,
      fpsNum:       Number(customSettings.fps),
      fpsDen:       1,
      audioCodec:   customSettings.audioCodec,
      sampleRate:   Number(customSettings.sampleRate),
      audioBitrate: Number(customSettings.audioBitrate),
      useSourceMedia: true,
      ...debugRange,
    }
    if (customSettings.useCrf) {
      cfg.crf = Number(customSettings.crf)
    } else {
      cfg.videoBitrate = Number(customSettings.videoBitrate) * 1_000_000
    }
    return cfg
  }, [activeTab, outputPath, startBar, endBar, youtubeSettings,
      discordSettings, discordDurationSec, customSettings, videoModeOverride])

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
  }, [outputPath, discordBelowMin, buildCfg, activeFps, showToast])

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

  const exportDisabled = !outputPath || discordBelowMin

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
              {/* Range row — dev-only debug override. Normal exports scope to
                  the project LoopRegion; these manual bars are hidden in
                  production builds and forwarded only as a debug override. */}
              {import.meta.env.DEV && (
                <>
                  <div className="export-row">
                    <label>Start Bar (debug)</label>
                    <input
                      type="number" min={1} step={1}
                      value={startBar}
                      onChange={(e) => setStartBar(e.target.value)}
                    />
                  </div>
                  <div className="export-row">
                    <label>End Bar (debug)</label>
                    <input
                      type="number" min={0} step={1}
                      value={endBar}
                      onChange={(e) => setEndBar(e.target.value)}
                      placeholder="0 = auto"
                    />
                  </div>
                </>
              )}
              <div style={{ borderTop: '1px solid var(--theme-border-subtle)', margin: '4px 0', opacity: 0.3 }} />

              <div className="export-row">
                <label>Video mode</label>
                <select
                  value={videoModeOverride}
                  onChange={e => setVideoModeOverride(e.target.value)}
                  style={{ fontSize: 12 }}
                >
                  <option value="auto">Auto</option>
                  <option value="software">Software</option>
                  <option value="hardware">Hardware only</option>
                </select>
              </div>

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
                  startBar={startBar}
                  endBar={endBar}
                />
              )}
              {activeTab === 'custom' && (
                <CustomTab
                  settings={customSettings}
                  onChange={mergeCustom}
                  outputPath={outputPath}
                  onBrowse={browse}
                  running={running}
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
