import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useToast } from './Toast.jsx'
import AudioTab from './exportPresets/AudioTab.jsx'
import YouTubeTab from './exportPresets/YouTubeTab.jsx'
import DiscordTab from './exportPresets/DiscordTab.jsx'
import CustomTab, { makeCustomDefaults } from './exportPresets/CustomTab.jsx'
import ProgressPanel from './exportPresets/ProgressPanel.jsx'
import { Button, Dialog, Progress, Tabs, TextField, formatValue } from '../ui-kit'
import { Row, exportStyles as styles } from './exportPresets/exportKit.jsx'
import RenderRangeSection from './RenderRangeSection.jsx'
import { BEATS_PER_BAR } from '../constants/timeline.js'
import { getPickerPath, openFilePicker } from './filePicker/filePickerService.js'
import { PLATFORM_TARGETS, DEFAULT_PLATFORM_TARGET } from '../constants/loudnessTargets.js'
import {
  computeDiscordVideoBitrate,
  computeYoutubeBitrate,
  DISCORD_MIN_VIDEO_BITRATE,
  DISCORD_TIER_LABELS,
  YOUTUBE_RESOLUTIONS,
  YOUTUBE_QUALITY_STOPS,
  formatBitrateMbps,
  formatDuration,
  defaultExportPresets,
  buildExportConfig,
  customAspectMismatch,
  describeExportSummary,
  FIT_MODES,
  DEFAULT_PROJECT_CANVAS,
} from './exportPresets/presets.js'
import { iconComponent } from '../ui-kit/icons'

const IcDiscordLogo = iconComponent('discord-logo')
const IcMusicNotes = iconComponent('music-notes')
const IcSlidersHorizontal = iconComponent('sliders-horizontal')
const IcYoutubeLogo = iconComponent('youtube-logo')

const NO_MEASUREMENT_SENTINEL = -200.0
const VIDEO_DESTINATIONS = ['youtube', 'discord', 'custom']

const DESTINATIONS = [
  { id: 'audio',   label: 'Audio',   glyph: <IcMusicNotes size={14} />, hint: 'WAV, MP3 or FLAC' },
  { id: 'youtube', label: 'YouTube', glyph: <IcYoutubeLogo size={14} />, hint: 'MP4, up to 4K' },
  { id: 'discord', label: 'Discord', glyph: <IcDiscordLogo size={14} />, hint: 'Fits the upload limit' },
  { id: 'custom',  label: 'Custom',  glyph: <IcSlidersHorizontal size={14} />, hint: 'Full control' },
]

function formatLufs(v) { return v <= NO_MEASUREMENT_SENTINEL ? '—' : formatValue(v, 'LUFS') }
function formatDb(v)   { return v <= NO_MEASUREMENT_SENTINEL ? '—' : formatValue(v, 'dB') }
function formatDbtp(v) { return v <= NO_MEASUREMENT_SENTINEL ? '—' : formatValue(v, 'dBTP') }

function makeAudioDefaults() {
  return {
    format: 'wav', sampleRate: 44100, bitDepth: 24, mp3Bitrate: 320, flacLevel: 5,
    platformTarget: DEFAULT_PLATFORM_TARGET, customTargetLufs: -14, customMaxDbtp: -1,
  }
}

// Small, self-contained progress view for the Audio destination — mirrors
// ProgressPanel's layout but carries the loudness-normalization report
// the video pipeline has no equivalent of.
function AudioProgress({ phase, progress, errorMsg, normReport, activeMaxDbtp, outputPath, onCancel, onOpenFolder, onClose }) {
  const running = phase === 'running'
  const peakMeasured = normReport && normReport.finalPredictedTruePeakDbtp > NO_MEASUREMENT_SENTINEL
  const peakPass = peakMeasured && normReport.finalPredictedTruePeakDbtp <= activeMaxDbtp

  let headline = 'Preparing export…'
  if (phase === 'running')   headline = progress < 0.7 ? 'Rendering…' : 'Encoding…'
  if (phase === 'done')      headline = 'Export complete.'
  if (phase === 'cancelled') headline = 'Export cancelled.'
  if (phase === 'error')     headline = errorMsg || 'Export failed.'

  return (
    <div className={styles.progress}>
      <Progress label="Export progress" value={progress} text={`${Math.floor(progress * 100)}\u2009%`} />
      <div className={styles.headline} data-error={phase === 'error' || undefined}>
        <span>{headline}</span>
      </div>

      {phase === 'done' && normReport && (
        <div className={styles.report} role="table" aria-label="Loudness report">
          <div className={styles.reportRow}><span>Measured</span><span>{formatLufs(normReport.measuredIntegratedLufs)}</span></div>
          <div className={styles.reportRow}><span>Loudness gain</span><span>{formatDb(normReport.loudnessGainDb)}</span></div>
          {normReport.peakSafetyGainDb !== 0 && (
            <div className={styles.reportRow}><span>Peak safety gain</span><span>{formatDb(normReport.peakSafetyGainDb)}</span></div>
          )}
          <div className={styles.reportRow}><span>Final integrated</span><span>{formatLufs(normReport.finalPredictedIntegratedLufs)}</span></div>
          <div className={styles.reportRow}>
            <span>Final true peak</span>
            <span>
              {formatDbtp(normReport.finalPredictedTruePeakDbtp)}
              {peakMeasured && <> <span className={styles.verdict} data-pass={peakPass || undefined} data-over={!peakPass || undefined}>{peakPass ? 'Pass' : 'Over'}</span></>}
            </span>
          </div>
        </div>
      )}

      {(phase === 'done' || phase === 'cancelled') && outputPath && (
        <div className={styles.outputPath}>{outputPath}</div>
      )}

      <div className={styles.actions}>
        {running && <Button variant="danger" onClick={onCancel}>Cancel export</Button>}
        {(phase === 'done' || phase === 'cancelled') && (
          <>
            <Button onClick={onOpenFolder}>Open folder</Button>
            <Button variant="primary" onClick={onClose}>Close</Button>
          </>
        )}
        {phase === 'error' && <Button variant="primary" onClick={onClose}>Close</Button>}
      </div>
    </div>
  )
}

// ── Render dialog ─────────────────────────────────────────────────────────────
// Unified destination picker (Audio / YouTube / Discord / Custom) fronting the
// two backend export pipelines: xleth.audio (AudioExporter) for Audio, and
// xleth.videoExport (FFmpegMuxer) for the three video presets. File > Export
// Audio and File > Export Video both open this dialog, steered to the right
// destination via `destinationHint` + `requestNonce`.
export default function RenderDialog({ isOpen, onClose, destinationHint, requestNonce, projectName }) {
  const { showToast } = useToast()

  const [destination, setDestination] = useState('youtube')
  const [outputPath, setOutputPath] = useState('')
  const destCategoryRef = useRef('video')

  const [audioSettings, setAudioSettings] = useState(makeAudioDefaults)
  const [startBar, setStartBar] = useState(1)
  const [endBar, setEndBar] = useState(0) // 0 = auto

  const [youtubeSettings, setYoutubeSettings] = useState(() => defaultExportPresets().youtube)
  const [discordSettings, setDiscordSettings] = useState(() => defaultExportPresets().discord)
  const [customSettings, setCustomSettings]   = useState(() => makeCustomDefaults())
  const [customPresets, setCustomPresets]     = useState([])
  const [presetsLoaded, setPresetsLoaded]     = useState(false)
  const [projectCanvas, setProjectCanvas]     = useState(DEFAULT_PROJECT_CANVAS)
  const [videoModeOverride, setVideoModeOverride] = useState('auto')

  const [durationSec, setDurationSec] = useState(0)
  const [discordDurationSec, setDiscordDurationSec] = useState(0)

  const [phase, setPhase]       = useState('idle') // idle | running | done | error | cancelled
  const [progress, setProgress] = useState(0)
  const [errorMsg, setErrorMsg] = useState('')
  const [normReport, setNormReport] = useState(null)
  const [renderPhase, setRenderPhase]   = useState(0)
  const [currentFrame, setCurrentFrame] = useState(0)
  const [totalFrames, setTotalFrames]   = useState(0)
  const [speed, setSpeed]               = useState(0)
  const [eta, setEta]                   = useState(0)
  const [renderFps, setRenderFps]       = useState(60)

  const saveTimerRef = useRef(null)
  const swEncoderNotifiedRef = useRef(false)

  // ── Load / persist presets (youtube, discord, custom, audio, last destination) ──
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const stored = await window.xleth?.videoExport?.getExportPresets()
        if (cancelled || !stored) return
        if (stored.migrated) showToast('Export presets were reset to defaults after an update.', 'info')
        setYoutubeSettings({ ...defaultExportPresets().youtube, ...(stored.youtube || {}) })
        setDiscordSettings({ ...defaultExportPresets().discord, ...(stored.discord || {}) })
        setCustomPresets(Array.isArray(stored.custom) ? stored.custom : [])
        setAudioSettings((s) => ({ ...s, ...(stored.audio || {}) }))
        if (['audio', 'youtube', 'discord', 'custom'].includes(stored.lastTab)) {
          setDestination(stored.lastTab)
        }
      } finally {
        if (!cancelled) setPresetsLoaded(true)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!presetsLoaded) return
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      window.xleth?.videoExport?.saveExportPresets({
        lastTab:  destination,
        youtube:  youtubeSettings,
        discord:  discordSettings,
        custom:   customPresets,
        audio:    audioSettings,
      })
    }, 500)
    return () => clearTimeout(saveTimerRef.current)
  }, [destination, youtubeSettings, discordSettings, customPresets, audioSettings, presetsLoaded])

  // ── Steer to the right destination when opened from a File menu shortcut ──
  useEffect(() => {
    if (!isOpen || !destinationHint) return
    if (destinationHint === 'audio') {
      setDestination('audio')
    } else if (destinationHint === 'video') {
      setDestination((d) => (VIDEO_DESTINATIONS.includes(d) ? d : 'youtube'))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, requestNonce])

  // Clear a stale output path when hopping between the audio and video
  // destination categories — they never share a file extension.
  useEffect(() => {
    const category = destination === 'audio' ? 'audio' : 'video'
    if (destCategoryRef.current !== category) {
      destCategoryRef.current = category
      setOutputPath('')
    }
  }, [destination])

  // Subscribe to progress from both backends whenever the dialog is open —
  // only the one actually started ever fires.
  useEffect(() => {
    if (!isOpen) return
    const unsub = window.xleth?.audio?.onExportProgress?.((p) => {
      if (!p) return
      setProgress(p.percent ?? 0)
      if (p.running) {
        setPhase('running')
      } else if (p.phase === 'done') {
        setPhase('done'); setProgress(1); setNormReport(p.normalization || null)
      } else if (p.phase === 'cancelled') {
        setPhase('cancelled')
      } else {
        setPhase('error'); setErrorMsg(p.error || 'Export failed')
      }
    })
    return unsub
  }, [isOpen])

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

      const encName = p.videoEncoderName
      if (encName && !swEncoderNotifiedRef.current) {
        const isSoftware = encName === 'mpeg4' || encName.startsWith('lib')
        if (isSoftware) {
          swEncoderNotifiedRef.current = true
          const msg = p.videoEncoderFallback
            ? `No hardware video encoder available — using ${encName} software encode. Export will be slower.`
            : `Using ${encName} software encode. Export will be slower.`
          showToast(msg, 'info')
        }
      }

      if (p.running) setPhase('running')
      else if (p.complete) { setPhase('done'); setProgress(1) }
      else if (p.failed) { setPhase('error'); setErrorMsg(p.error || 'Render failed') }
      else setPhase('cancelled')
    })
    return unsub
  }, [isOpen, showToast])

  // Reset ephemeral state + reload the project canvas whenever the dialog opens.
  useEffect(() => {
    if (!isOpen) return
    setPhase('idle')
    setProgress(0)
    setErrorMsg('')
    setNormReport(null)
    setRenderPhase(0)
    setCurrentFrame(0)
    setTotalFrames(0)
    setSpeed(0)
    setEta(0)

    window.xleth?.settings?.get?.('videoMode').then((v) => {
      setVideoModeOverride(['auto', 'software', 'hardware'].includes(v) ? v : 'auto')
    }).catch(() => setVideoModeOverride('auto'))

    window.xleth?.videoExport?.computeDurationSeconds?.().then((secs) => {
      setDurationSec(Number(secs) || 0)
    }).catch(() => setDurationSec(0))

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
        setYoutubeSettings((s) => ({ ...s, fps: pc.previewFps }))
        setDiscordSettings((s) => ({ ...s, fps: pc.previewFps }))
      } catch { /* keep DEFAULT_PROJECT_CANVAS */ }
    })()
  }, [isOpen])

  useEffect(() => {
    if (destination !== 'discord') return
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
  }, [destination])

  const running  = phase === 'running'
  const finished = phase === 'done' || phase === 'error' || phase === 'cancelled'

  // ── Handlers ───────────────────────────────────────────────────────────────
  const browse = useCallback(async () => {
    if (destination === 'audio') {
      const defName = `export.${audioSettings.format}`
      const picked = await openFilePicker({
        mode: 'saveFile',
        title: 'Export Audio As',
        subtitle: 'Choose the audio render destination.',
        actionLabel: 'Export',
        defaultName: defName,
        defaultExtension: audioSettings.format,
        filters: [{ name: `${audioSettings.format.toUpperCase()} Audio`, extensions: [audioSettings.format] }],
        legacyPicker: () => window.xleth.audio.exportSaveAsDialog(defName, audioSettings.format),
      })
      const p = getPickerPath(picked)
      if (p) setOutputPath(p)
      return
    }
    const picked = await openFilePicker({
      mode: 'saveFile',
      title: 'Export Video As',
      subtitle: 'Choose the video render destination.',
      actionLabel: 'Export',
      defaultName: 'export.mp4',
      defaultExtension: 'mp4',
      filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
      legacyPicker: () => window.xleth?.videoExport?.exportSaveAsDialog('export.mp4'),
    })
    const p = getPickerPath(picked)
    if (p) setOutputPath(p)
  }, [destination, audioSettings.format])

  const mergeAudio   = useCallback((patch) => setAudioSettings((s) => ({ ...s, ...patch })), [])
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

  const discordBelowMin = destination === 'discord'
    && discordDurationSec > 0
    && computeDiscordVideoBitrate(discordSettings.tier, discordDurationSec) < DISCORD_MIN_VIDEO_BITRATE

  const buildVideoCfg = useCallback(() => buildExportConfig({
    activeTab: destination,
    outputPath,
    youtubeSettings,
    discordSettings,
    customSettings,
    videoModeOverride,
    discordDurationSec,
    projectCanvas,
  }), [destination, outputPath, youtubeSettings, discordSettings, discordDurationSec, customSettings, videoModeOverride, projectCanvas])

  const customFitRequired = destination === 'custom'
    && customAspectMismatch(customSettings, projectCanvas)
    && !FIT_MODES.includes(customSettings.fitMode)

  const activeFps = destination === 'youtube' ? youtubeSettings.fps
                   : destination === 'discord' ? discordSettings.fps
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

    setErrorMsg('')
    setPhase('running')
    setProgress(0)

    if (destination === 'audio') {
      const cfg = {
        outputPath,
        format: audioSettings.format,
        sampleRate: Number(audioSettings.sampleRate),
        bitDepth: Number(audioSettings.bitDepth),
        mp3Bitrate: Number(audioSettings.mp3Bitrate),
        flacLevel: Number(audioSettings.flacLevel),
      }
      if (audioSettings.platformTarget !== 'none') {
        const target = PLATFORM_TARGETS[audioSettings.platformTarget]
        cfg.normalizationEnabled = true
        cfg.targetLufs = audioSettings.platformTarget === 'custom' ? Number(audioSettings.customTargetLufs) : target.targetLufs
        cfg.maxDbtp = audioSettings.platformTarget === 'custom' ? Number(audioSettings.customMaxDbtp) : target.maxDbtp
        cfg.allowUpwardGain = target.allowUpwardGain
      }
      // Phase 2: the render scope derives from the project LoopRegion. The manual
      // Start/End Bar inputs are dev-only and sent solely as a debug bounds
      // override (the native side gates them too).
      if (import.meta.env.DEV) {
        const sBar = Math.max(1, Number(startBar) || 1)
        const eBar = Number(endBar) || 0
        cfg.startBeat = (sBar - 1) * BEATS_PER_BAR
        cfg.endBeat   = eBar > 0 ? eBar * BEATS_PER_BAR : 0
      }
      const ok = await window.xleth.audio.exportStart(cfg)
      if (!ok) { setPhase('error'); setErrorMsg('Failed to start export (already running?)') }
      return
    }

    setRenderFps(Number(activeFps) || 60)
    const cfg = buildVideoCfg()
    const ok = await window.xleth?.videoExport?.exportStart(cfg)
    if (!ok) { setPhase('error'); setErrorMsg('Failed to start render (already running?)') }
  }, [outputPath, discordBelowMin, customFitRequired, destination, audioSettings, startBar, endBar, activeFps, buildVideoCfg, showToast])

  const cancel = useCallback(async () => {
    if (destination === 'audio') await window.xleth.audio.exportCancel()
    else await window.xleth?.videoExport?.exportCancel()
  }, [destination])

  const openFile = useCallback(() => {
    if (outputPath) window.xleth?.shell?.openPath?.(outputPath)
  }, [outputPath])

  const openFolder = useCallback(() => {
    if (outputPath) window.xleth?.shell?.showItemInFolder?.(outputPath)
  }, [outputPath])

  // ── Footer chips — quick-glance summary of the active destination's settings ──
  const chips = useMemo(() => {
    if (destination === 'audio') {
      const list = [audioSettings.format.toUpperCase()]
      if (audioSettings.format === 'wav') list.push(`${audioSettings.bitDepth}-bit PCM`)
      if (audioSettings.format === 'mp3') list.push(`${audioSettings.mp3Bitrate} kbps`)
      if (audioSettings.format === 'flac') list.push(`Level ${audioSettings.flacLevel}`)
      list.push(`${(audioSettings.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz`)
      const target = PLATFORM_TARGETS[audioSettings.platformTarget]
      if (target && audioSettings.platformTarget !== 'none') list.push(target.label)
      return list
    }
    if (destination === 'youtube') {
      const res = YOUTUBE_RESOLUTIONS.find((r) => r.id === youtubeSettings.resolution) || YOUTUBE_RESOLUTIONS[0]
      const bps = computeYoutubeBitrate(res.width, res.height, youtubeSettings.fps, youtubeSettings.quality)
      const qualityLabel = YOUTUBE_QUALITY_STOPS.find((s) => s.value === youtubeSettings.quality)?.label || 'Great'
      return [res.label, `${youtubeSettings.fps} fps`, 'H.264', `${qualityLabel} ~${formatBitrateMbps(bps)}`, 'AAC 384 kbps']
    }
    if (destination === 'discord') {
      return [
        DISCORD_TIER_LABELS[discordSettings.tier] || 'Free (10 MB)',
        formatDuration(discordDurationSec || durationSec),
        `${discordSettings.fps} fps`,
      ]
    }
    const summary = describeExportSummary(buildVideoCfg())
    return summary ? summary.split(' · ') : []
  }, [destination, audioSettings, youtubeSettings, discordSettings, discordDurationSec, durationSec, buildVideoCfg])

  if (!isOpen) return null

  const exportDisabled = !outputPath || discordBelowMin || customFitRequired
  const activeMaxDbtp = audioSettings.platformTarget === 'custom'
    ? Number(audioSettings.customMaxDbtp)
    : PLATFORM_TARGETS[audioSettings.platformTarget]?.maxDbtp ?? 0

  const idle = !running && !finished
  const primaryLabel = destination === 'audio' ? 'Export audio' : 'Export video'

  return (
    <Dialog
      title="Render"
      width="lg"
      flush
      dismissable={!running}
      onClose={onClose}
      actions={idle ? (
        <>
          <Button size="lg" onClick={onClose}>Close</Button>
          <Button size="lg" variant="primary" data-autofocus="" onClick={start} disabled={exportDisabled}>{primaryLabel}</Button>
        </>
      ) : undefined}
    >
      <div className={styles.root}>
        <div className={styles.subtitle}>
          {projectName ? `${projectName} · ` : ''}{formatDuration(durationSec)} range
        </div>

        {idle && (
          <Tabs label="Destination" tabs={DESTINATIONS} value={destination} onChange={setDestination} />
        )}

        {(running || finished) ? (
          destination === 'audio' ? (
            <AudioProgress
              phase={phase}
              progress={progress}
              errorMsg={errorMsg}
              normReport={normReport}
              activeMaxDbtp={activeMaxDbtp}
              outputPath={outputPath}
              onCancel={cancel}
              onOpenFolder={openFolder}
              onClose={onClose}
            />
          ) : (
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
          )
        ) : (
          <>
            {destination === 'audio'   && <AudioTab   settings={audioSettings}   onChange={mergeAudio}   running={running} />}
            {destination === 'youtube' && <YouTubeTab settings={youtubeSettings} onChange={mergeYoutube} running={running} />}
            {destination === 'discord' && <DiscordTab settings={discordSettings} onChange={mergeDiscord} running={running} />}
            {destination === 'custom'  && (
              <CustomTab
                settings={customSettings}
                onChange={mergeCustom}
                running={running}
                projectCanvas={projectCanvas}
                presets={customPresets}
                onSavePreset={handleSavePreset}
                onLoadPreset={handleLoadPreset}
                onDeletePreset={handleDeletePreset}
                videoModeOverride={videoModeOverride}
                onVideoModeOverrideChange={setVideoModeOverride}
              />
            )}

            <div className={styles.divider} />
            <Row label="Output file">
              <TextField
                data-fill=""
                data-output-path=""
                label="Output file"
                mono
                value={outputPath}
                onChange={setOutputPath}
                placeholder="Choose a file…"
                disabled={running}
              />
              <Button onClick={browse} disabled={running}>Browse…</Button>
            </Row>

            <RenderRangeSection disabled={running}>
              {destination === 'audio' && import.meta.env.DEV && (
                <div className={styles.grid} role="group" aria-label="Debug range override">
                  <Row label="Start bar (debug)">
                    <TextField
                      label="Start bar (debug)" type="number" min={1} step={1} value={String(startBar)}
                      onChange={setStartBar} disabled={running}
                    />
                  </Row>
                  <Row label="End bar (debug)">
                    <TextField
                      label="End bar (debug)" type="number" min={0} step={1} value={String(endBar)}
                      onChange={setEndBar} disabled={running} placeholder="0 = auto"
                    />
                  </Row>
                </div>
              )}
            </RenderRangeSection>

            <div className={styles.summary} aria-label="What will be rendered">
              {chips.map((c, i) => <span key={c + i}>{c}</span>)}
            </div>
          </>
        )}
      </div>
    </Dialog>
  )
}
