import { useRef, useEffect, useState, useCallback } from 'react'
import { Loader2 } from 'lucide-react'
import GridEditorOverlay from './GridEditorOverlay.jsx'
import GridEditorDock from './GridEditorDock.jsx'
import GridEditToolbar from './grid/GridEditToolbar.jsx'
import PreviewHeader from './PreviewHeader.jsx'
import ProxyBatchBadge from './ProxyBatchBadge.jsx'
import { tokenValue } from '../theming/tokenValue.ts'
import useGridEditStore from '../stores/useGridEditStore.js'
import { usePanelVisibility } from '../windowing/contexts/PanelVisibilityContext'
import { uiCanvasFont } from '../styles/typography.js'
import { getPickerPath, openFilePicker } from './filePicker/filePickerService.js'
import { VIDEO_EXTENSIONS } from './filePicker/filePickerHelpers.js'
import { subscribe, completePick, cancelPick } from './grid/chromaKeyEyedropper.js'
import styles from './VideoPreview.module.css'

// Mirrors CANVAS_W/CANVAS_H in XlethEngineService.cpp — the shm surface's
// base resolution before previewResolutionScale is applied.
const BASE_CANVAS_W = 960
const BASE_CANVAS_H = 540

// The shm surface size the engine's compositor will be running at for a given
// previewResolutionScale. Must stay in step with
// applyPreviewResolutionScaleInternal (XlethEngineService.cpp) — the engine
// truncates (int)(CANVAS_W * scale) where this rounds, which agree exactly on
// all four bucket values the engine snaps to (0.25/0.5/0.75/1.0) but would NOT
// agree on an arbitrary scale. If the engine ever gains a continuous scale,
// switch this to truncation rather than letting the two drift by a pixel.
function shmDimsForScale(scale) {
  return {
    w: Math.max(1, Math.round(BASE_CANVAS_W * scale)),
    h: Math.max(1, Math.round(BASE_CANVAS_H * scale)),
  }
}

// ── WebGL shaders ────────────────────────────────────────────────────────────
const VERT_SRC = `
  attribute vec2 a_position;
  attribute vec2 a_texCoord;
  varying vec2 v_texCoord;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
    v_texCoord = a_texCoord;
  }
`
// The engine writes the composited frame into shm as raw BGRA (its native
// D3D11 readback order) instead of paying a per-pixel CPU swizzle to RGBA
// first. gl.texImage2D below is told the upload is 'RGBA', so the GPU loads
// each texel's bytes as (R,G,B,A) = (trueB, trueG, trueR, trueA) — the .bgra
// swizzle below reads them back out in the right order for free.
const FRAG_SRC = `
  precision mediump float;
  varying vec2 v_texCoord;
  uniform sampler2D u_texture;
  void main() {
    gl_FragColor = texture2D(u_texture, v_texCoord).bgra;
  }
`

function createShader(gl, type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('[VideoPreview] Shader error:', gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }
  return shader
}

function createProgram(gl, vertSrc, fragSrc) {
  const vert = createShader(gl, gl.VERTEX_SHADER, vertSrc)
  const frag = createShader(gl, gl.FRAGMENT_SHADER, fragSrc)
  if (!vert || !frag) return null
  const program = gl.createProgram()
  gl.attachShader(program, vert)
  gl.attachShader(program, frag)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('[VideoPreview] Link error:', gl.getProgramInfoLog(program))
    gl.deleteProgram(program)
    return null
  }
  return program
}

// ── Pixel-content diagnostics (opt-in) ───────────────────────────────────────
// Mirrors the native FramePixelStats fingerprint so the renderer stages line up
// with the engine stages in the Visual Preview Diagnostic Log. `format` MUST be
// labelled correctly per stage: shm bytes are native BGRA (the engine writes
// them unchanged — see FRAG_SRC's .bgra swizzle above), while readPixels reads
// back the GPU framebuffer AFTER that shader swizzle, which is true RGBA. Heavy
// (~full-frame loop) — callers gate on the diag flag and sample sparingly.
function computeFrameStatsJS(bytes, width, height, format) {
  const rIdx = format === 'BGRA' ? 2 : 0
  const bIdx = format === 'BGRA' ? 0 : 2
  const px = width * height
  const n = px * 4
  let checksum = 0, nonZeroBytes = 0, nonZeroPixels = 0, lumaSum = 0
  for (let i = 0; i < n; i += 4) {
    const c0 = bytes[i], c1 = bytes[i + 1], c2 = bytes[i + 2], c3 = bytes[i + 3]
    checksum += c0 + c1 + c2 + c3
    if (c0) nonZeroBytes++
    if (c1) nonZeroBytes++
    if (c2) nonZeroBytes++
    if (c3) nonZeroBytes++
    if (c0 || c1 || c2) nonZeroPixels++
    lumaSum += 0.299 * bytes[i + rIdx] + 0.587 * c1 + 0.114 * bytes[i + bIdx]
  }
  const first16 = []
  for (let i = 0; i < Math.min(16, n); i++) {
    first16.push(bytes[i].toString(16).padStart(2, '0').toUpperCase())
  }
  const at = (x, y) => {
    const o = (y * width + x) * 4
    return [bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]
  }
  return {
    observed: true, format, width, height, rowPitch: width * 4,
    byteCount: n, checksum64: String(checksum),
    nonZeroBytes, nonZeroPixels,
    averageLuma: px ? lumaSum / px : 0,
    first16Bytes: first16.join(' '),
    centerPixel: at(width >> 1, height >> 1),
    corners: [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)],
    frameIndex: -1, tickIndex: -1, timestamp: 0,
  }
}

function hexToGlColor(hex) {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16) / 255
  const g = parseInt(h.slice(2, 4), 16) / 255
  const b = parseInt(h.slice(4, 6), 16) / 255
  return [r, g, b]
}

// ── Component ────────────────────────────────────────────────────────────────

// headerActions: shell controls for the panel itself (the docked Preview's
// pop-out), appended to the header row. Docked panels have no titlebar.
export default function VideoPreview({ headerActions = null } = {}) {
  const gridEditMode = useGridEditStore((s) => s.gridEditMode)
  const setGridEditMode = useGridEditStore((s) => s.setGridEditMode)
  const { isVisible, useOnVisibilityChange } = usePanelVisibility()
  const runningRef = useRef(true)
  const tickRef = useRef(null)
  const canvasRef = useRef(null)
  const containerRef = useRef(null)
  const canvasAreaRef = useRef(null)
  const wrapperRef = useRef(null)
  // Holds the current canvas aspect so the ResizeObserver closure always
  // reads the latest value without being recreated on every outputDims change.
  const canvasAspectRef = useRef(16 / 9)
  // Populated by the shm effect below; reads one RGBA pixel out of the shared
  // frame at normalized (0..1) coordinates. Null until shm is open.
  const pickPixelRef = useRef(null)
  // Populated by the shm effect below; applies a new shm surface size (canvas,
  // gl viewport, sabWidth/sabHeight closures) after previewResolutionScale
  // changes the compositor's — and therefore the shm's — output dimensions.
  const applyShmResizeRef = useRef(null)
  const [importing, setImporting] = useState(false)
  const [fps, setFps] = useState(0)
  const [mode, setMode] = useState('init')
  const [outputDims, setOutputDims] = useState({ w: 0, h: 0 })

  // ── Preview performance controls ─────────────────────────────────────────
  const [resolutionScale, setResolutionScale] = useState(1.0)
  // Whether the engine's adaptive resolution governor (RENDER_PERF_AUDIT
  // Finding 8) is picking resolutionScale on its own. Picking a specific
  // percentage from the dropdown clears this (engine-side, authoritatively —
  // see Timeline_SetPreviewResolutionScale); only picking "Auto" again sets
  // it back. Mirrored in a ref so the poll effect below always reads the
  // latest resolutionScale without re-subscribing every time it changes.
  const [autoResolution, setAutoResolution] = useState(true)
  const resolutionScaleRef = useRef(1.0)
  useEffect(() => { resolutionScaleRef.current = resolutionScale }, [resolutionScale])
  // The size the shm surface is ACTUALLY at, mirrored for the reconcile poll
  // below. This is the authoritative half of the comparison: resolutionScale is
  // only what the UI believes it asked for, and the whole point of the poll is
  // to catch the case where those two disagree.
  const outputDimsRef = useRef({ w: 0, h: 0 })
  useEffect(() => { outputDimsRef.current = outputDims }, [outputDims])
  const [effectsBypass, setEffectsBypass] = useState(false)
  // Poster fast-preview mode: grid cells show a single representative frame
  // instead of live video. Default ON. Preview-only — never affects render.
  const [posterMode, setPosterMode] = useState(true)
  const [initReady, setInitReady] = useState(false)
  // True once a frame has been drawn to the canvas. Drives the placeholder, which
  // exists only for the time before there is a picture.
  const [hasFrame, setHasFrame] = useState(false)
  // Poster prepass overlay state. holdingVideo === true means the engine is
  // holding the video compositor while the one-poster-per-source cache warms up
  // (audio keeps playing). { active, completed, total, pending, holdingVideo }.
  const [posterLoad, setPosterLoad] = useState({
    active: false, completed: 0, total: 0, pending: 0, holdingVideo: false,
  })

  // On-open proxy codec migration (engine re-encodes legacy all-intra proxies
  // to H.264 in the background). Drives a small non-blocking badge; preview
  // keeps using the old proxies until each replacement is ready.
  // { active, total, completed, failed, progress (0..1) }.
  const [proxyMigration, setProxyMigration] = useState({
    active: false, total: 0, completed: 0, failed: 0, progress: 0,
  })
  // On-open REBUILD of proxies that were missing — purged by "Delete regenerable
  // files when closing a project", never generated, or deleted while the app was
  // closed. Same shape and same non-blocking badge as the migration above.
  const [proxyRebuild, setProxyRebuild] = useState({
    active: false, total: 0, completed: 0, failed: 0, progress: 0,
  })

  // ── Engine preview-enabled sync (RENDER_PERF_AUDIT Finding 1) ────────────
  // The engine idles the whole video thread (composite/decode/readback) when
  // told nobody can see the canvas — one black frame written, then latched
  // idle. Independent of export's own pause flag, so this can never affect a
  // render, and it only touches the video tick — playback audio is untouched.
  // "Visible" is the AND of three independent signals: the panel itself
  // (hidden via F8 / keepAliveWhenHidden, or tabbed behind another panel in
  // the dock — both flow through usePanelVisibility's isVisible, already a
  // dependency here), the document's Page Visibility state (covers OS-level
  // minimize), and window focus (covers the window being fully occluded
  // behind another app). Kept as one effect, not split across several, so
  // there is a single place that ever calls preview.setEnabled.
  const engineDocFocusRef = useRef({ doc: true, focus: true })
  useEffect(() => {
    const syncEngineEnabled = () => {
      const v = engineDocFocusRef.current
      window.xleth?.preview?.setEnabled?.(isVisible && v.doc && v.focus)
    }
    const onVisibilityChange = () => {
      engineDocFocusRef.current.doc = document.visibilityState === 'visible'
      syncEngineEnabled()
    }
    const onFocus = () => { engineDocFocusRef.current.focus = true; syncEngineEnabled() }
    const onBlur  = () => { engineDocFocusRef.current.focus = false; syncEngineEnabled() }
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    engineDocFocusRef.current.doc = document.visibilityState === 'visible'
    engineDocFocusRef.current.focus = document.hasFocus()
    syncEngineEnabled()
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      window.xleth?.preview?.setEnabled?.(false)
    }
  }, [isVisible])

  // Applies a previewResolutionScale to both the engine's compositor (resizes
  // its render target) and the shm surface (resizes frameOutput to match —
  // see Issue 1 in the video-preview audit: the shm used to stay fixed at
  // 960x540 and get CPU-nearest-neighbour-upsampled back up regardless of
  // scale). The two RPCs are sequential, not atomic; XlethEngineService.cpp's
  // swizzle now skips a frame rather than write past either mapping if it
  // observes them mid-transition. Once the shm resize resolves, pushes the
  // new dimensions into the live canvas/gl/sabWidth closures via the ref the
  // mount effect below populates.
  const applyPreviewResolutionScale = useCallback(async (scale) => {
    await window.xleth?.timeline?.setPreviewResolutionScale(scale)
    const { w, h } = shmDimsForScale(scale)
    const meta = await window.xleth?.video?.getFrameShm?.(w, h)
    if (meta) applyShmResizeRef.current?.(meta.width, meta.height)
  }, [])

  // Restore persisted settings on mount
  useEffect(() => {
    async function restorePreviewSettings() {
      try {
        // Read from settings store (workstation-local, not project)
        const scale  = await window.xleth?.settings?.get('previewResolutionScale')
        const auto   = await window.xleth?.settings?.get('previewResolutionAutoMode')
        const bypass = await window.xleth?.settings?.get('previewEffectsBypass')
        const poster = await window.xleth?.settings?.get('previewPosterMode')
        const resolvedScale  = (typeof scale  === 'number') ? scale  : 1.0
        // Governor defaults ON for a fresh install — see RENDER_PERF_AUDIT
        // Finding 8. Only an explicit prior "false" (user picked a manual
        // percentage last session) turns it off on restore.
        const resolvedAuto   = (typeof auto   === 'boolean') ? auto   : true
        const resolvedBypass = (typeof bypass === 'boolean') ? bypass : false
        // Poster mode defaults ON when no preference is stored yet.
        const resolvedPoster = (typeof poster === 'boolean') ? poster : true
        setResolutionScale(resolvedScale)
        setAutoResolution(resolvedAuto)
        setEffectsBypass(resolvedBypass)
        setPosterMode(resolvedPoster)
        // Apply to engine. The shm resize this issues races the mount
        // effect's first openFrameShm() below (harmless either order: if
        // this wins, the shm is created at the restored scale from the
        // start; if openFrameShm() wins, applyShmResizeRef isn't set yet so
        // the resize call below is a no-op, but ensureFrameShm's cache was
        // still primed for whenever the panel next opens).
        //
        // Order matters: applyPreviewResolutionScale goes through the manual
        // setPreviewResolutionScale RPC, which clears auto mode engine-side.
        // Restoring the auto flag AFTER it guarantees the final engine state
        // matches what was actually persisted, regardless of that side effect.
        await applyPreviewResolutionScale(resolvedScale)
        await window.xleth?.timeline?.setPreviewResolutionAutoMode(resolvedAuto)
        await window.xleth?.timeline?.setPreviewEffectsBypass(resolvedBypass)
        await window.xleth?.timeline?.setPreviewPosterMode(resolvedPoster)
      } catch (e) {
        console.error('[VideoPreview] Failed to restore preview settings:', e)
      }
    }
    restorePreviewSettings()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isVisible && !initReady) {
      setInitReady(true)
    }
  }, [isVisible])

  // Note the setResolutionScale calls below run BEFORE the awaits that make
  // them true engine-side, so the dropdown responds immediately. That means a
  // throw anywhere in here leaves the label ahead of the shm — which is how the
  // surface got stuck at 50% while the badge read 75%. Catching keeps it from
  // becoming an unhandled rejection; the reconcile poll above is what actually
  // repairs the divergence, within one 500 ms tick.
  const handleResolutionChange = useCallback(async (raw) => {
    try {
      if (raw === 'auto') {
        setAutoResolution(true)
        await window.xleth?.timeline?.setPreviewResolutionAutoMode(true)
        await window.xleth?.settings?.set('previewResolutionAutoMode', true)
        // Re-enabling auto doesn't itself change the scale — the governor only
        // steps at its own rolling-window cadence — so just pick up whatever
        // the engine is currently applying rather than leaving the dropdown
        // showing a stale manual value.
        const scale = await window.xleth?.timeline?.getPreviewResolutionScale()
        if (typeof scale === 'number') {
          setResolutionScale(scale)
          const { w, h } = shmDimsForScale(scale)
          const meta = await window.xleth?.video?.getFrameShm?.(w, h)
          if (meta) applyShmResizeRef.current?.(meta.width, meta.height)
          await window.xleth?.settings?.set('previewResolutionScale', scale)
        }
        return
      }
      const scale = parseFloat(raw)
      setAutoResolution(false)
      setResolutionScale(scale)
      await applyPreviewResolutionScale(scale) // also clears auto mode engine-side
      await window.xleth?.settings?.set('previewResolutionScale', scale)
      await window.xleth?.settings?.set('previewResolutionAutoMode', false)
    } catch (err) {
      console.error('[VideoPreview] Resolution change failed:', err)
    }
  }, [applyPreviewResolutionScale])

  // [PreviewResGovernor] Poll the engine's current previewResolutionScale and
  // reconcile the UI against it. In auto mode this picks up a governor-driven
  // step so the dropdown/badge stop showing a stale value (and persists it, so
  // the next launch starts near where this one left off).
  //
  // Runs in BOTH auto and manual mode, and reconciles two independent things
  // against the engine's authoritative scale:
  //
  //   1. the dropdown/badge label (auto only — a governor step)
  //   2. the shm surface size (always)
  //
  // (2) is the one that matters for correctness. The engine composites at
  // CANVAS_W/H * scale and copies into the shm only when the two agree
  // exactly (XlethEngineService.cpp shmMatchesCompositor / the rb.width == fw
  // guard); on a mismatch it skips the write. That skip is documented as
  // covering the brief window between the two sequential RPCs a scale change
  // issues, but nothing ever retried the resize — so any failure of the
  // getFrameShm half (a rejected RPC, or applyShmResizeRef still being null
  // because the mount effect had not run yet) latched a PERMANENT mismatch and
  // the preview froze on a stale frame until restart.
  //
  // This used to compare the engine scale against resolutionScaleRef, i.e. two
  // views of the same intent — which is exactly the pair that still agrees when
  // the resize fails, so it could never detect the stuck state. Comparing the
  // engine's expected dims against the shm's real dims closes that hole.
  // getFrameShm is cached by size in main.js, so a matching poll costs one
  // resolved promise and never touches the engine.
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const scale = await window.xleth?.timeline?.getPreviewResolutionScale()
        if (cancelled || typeof scale !== 'number') return

        if (autoResolution && Math.abs(scale - resolutionScaleRef.current) > 0.001) {
          setResolutionScale(scale)
          await window.xleth?.settings?.set('previewResolutionScale', scale)
          if (cancelled) return
        }

        // Skip until the shm is actually open — dims of 0x0 mean the mount
        // effect's openFrameShm() has not published a surface yet, and forcing
        // a resize into that gap would race it.
        const have = outputDimsRef.current
        if (!have.w || !have.h) return

        const want = shmDimsForScale(scale)
        if (have.w === want.w && have.h === want.h) return

        console.warn(
          `[VideoPreview] shm/compositor size mismatch — shm ${have.w}x${have.h}, ` +
          `engine scale ${scale} wants ${want.w}x${want.h}. Re-issuing resize; ` +
          'the preview was frozen until now.'
        )
        const meta = await window.xleth?.video?.getFrameShm?.(want.w, want.h)
        if (!cancelled && meta) applyShmResizeRef.current?.(meta.width, meta.height)
      } catch (e) {
        console.error('[VideoPreview] Resolution reconcile poll failed:', e)
      }
    }
    // 500 ms, not 2 s: a governor step resizes the compositor immediately but
    // the shm only follows when this poll notices, and until then the engine
    // skips the copy — the preview holds a stale frame for up to one interval
    // per step. A matching poll is one cached IPC round-trip.
    const id = setInterval(poll, 500)
    return () => { cancelled = true; clearInterval(id) }
  }, [autoResolution])

  const handleEffectsBypassToggle = useCallback(async () => {
    const next = !effectsBypass
    setEffectsBypass(next)
    await window.xleth?.timeline?.setPreviewEffectsBypass(next)
    await window.xleth?.settings?.set('previewEffectsBypass', next)
  }, [effectsBypass])

  const handlePosterModeToggle = useCallback(async () => {
    const next = !posterMode
    setPosterMode(next)
    await window.xleth?.timeline?.setPreviewPosterMode(next)
    await window.xleth?.settings?.set('previewPosterMode', next)
  }, [posterMode])

  const handleImport = useCallback(async () => {
    setImporting(true)
    try {
      const picked = await openFilePicker({
        mode: 'openFile',
        title: 'Import Video',
        subtitle: 'Choose a video source for the preview timeline.',
        actionLabel: 'Import',
        filters: [
          { name: 'Video Files', extensions: VIDEO_EXTENSIONS },
          { name: 'All Files', extensions: ['*'] },
        ],
        legacyPicker: () => window.xleth?.importVideo?.(),
      })
      const pickedPath = getPickerPath(picked)
      if (!pickedPath) return
      // The engine does the import; nothing here needs the file name any more.
      if (!picked.legacy) await window.xleth?.importVideoFromPath?.(pickedPath)
    } catch (e) {
      console.error('Video import failed:', e)
    } finally {
      setImporting(false)
    }
  }, [])

  useEffect(() => {
    if (!initReady) return

    const canvas = canvasRef.current
    let rafId = null
    let frameCount = 0
    let lastFpsTime = performance.now()

    // ── Visual preview diagnostic publisher ────────────────────────────────
    // The Settings → Graphics → Export Visual Preview Diagnostic Log button
    // reads window.__xlethVisualPreviewDiag to learn the *actual* state of
    // this canvas (WebGL info, texture upload health, frame receipt). Without
    // this, the SettingsPanel can only collect a *probe* WebGL context which
    // may not represent the live preview canvas at all.
    const diag = {
      mode: 'init',
      shm: { opened: false, name: null, error: null,
             lastIndex: -1, framesReceived: 0, lastFrameW: 0, lastFrameH: 0 },
      lastTickAction: 'none',          // 'frame' | 'no-frame' | 'no-shm' | 'init'
      lastTickAt: 0,                   // performance.now()
      texUploadSuccess: 0,
      texUploadFailures: 0,
      lastTexUploadError: null,
      contextLostCount: 0,
      contextRestoredCount: 0,
      clearColorRgb: null,             // [r,g,b] (0..1) used by drawNoVideo
      drawApi: 'none',                 // 'webgl' | 'canvas2d' | 'none'
      webgl: null,                     // populated below if WebGL init succeeds
      // ── Pixel-content verification (opt-in) ──────────────────────────────
      // Populated only when window.xleth.diag.visualPixelDiag.pixels is set.
      // stage -> { observed, sampleCount, latest }
      pixelStats: {},
      glErrorAfterUpload: 0,           // last gl.getError() after texSubImage2D
      glErrorAfterDraw: 0,             // last gl.getError() after drawArrays
      pixelDiagEnabled: false,
    }
    window.__xlethVisualPreviewDiag = diag

    // Opt-in pixel-content instrumentation (mirrors native XLETH_VISUAL_DIAG_PIXELS).
    const pixelDiagEnabled = !!(window.xleth?.diag?.visualPixelDiag?.pixels)
    diag.pixelDiagEnabled = pixelDiagEnabled
    let pixelDiagFrame = 0          // counts successful uploads
    let readPixelsBuf = null        // lazily-sized RGBA scratch for readPixels
    let canvas2dScratch = null      // lazily-sized BGRA→RGBA scratch for the Canvas2D fallback
    const PIXEL_DIAG_FIRST_N = 3    // always sample the first N uploads
    const PIXEL_DIAG_EVERY = 120    // then sample 1-in-N to keep watching
    const shouldSamplePixels = (n) => n < PIXEL_DIAG_FIRST_N || (n % PIXEL_DIAG_EVERY) === 0
    const recordRendererStats = (stage, stats) => {
      const prev = diag.pixelStats[stage]
      diag.pixelStats[stage] = {
        observed: true,
        sampleCount: (prev?.sampleCount || 0) + 1,
        latest: stats,
      }
    }

    // ── Open the named shared-memory region (synchronous handshake) ─────
    // preload.js calls shm_helper.openSharedMemory() which maps the same
    // physical pages the engine writes to. Electron 41's V8 forbids external
    // ArrayBuffers in renderer contexts, so shm_helper keeps the mapping
    // internal and exposes readInt32/readBytes that memcpy into renderer-
    // owned Uint8Arrays (bufA/bufB).
    let shm = null
    let bufA = null, bufB = null
    let sabWidth = 0, sabHeight = 0, bufferSize = 0
    let lastIndex = -1
    let hasFrameLatched = false

    try {
      shm = window.xleth?.video?.openFrameShm?.()
      if (!shm) {
        console.warn('[VideoPreview] openFrameShm returned nothing')
        setMode('no-shm')
        diag.mode = 'no-shm'
      } else {
        bufA = shm.bufA
        bufB = shm.bufB
        sabWidth   = shm.meta.width
        sabHeight  = shm.meta.height
        bufferSize = shm.meta.bufferSize
        canvas.width  = sabWidth
        canvas.height = sabHeight
        setOutputDims({ w: sabWidth, h: sabHeight })
        diag.shm.opened = true
        diag.shm.name = shm.meta.name
        console.log(`[VideoPreview] shm ready: ${shm.meta.name} ${sabWidth}x${sabHeight}`)
      }
    } catch (e) {
      console.error('[VideoPreview] openFrameShm failed:', e)
      setMode('shm-error')
      diag.mode = 'shm-error'
      diag.shm.error = String(e?.message || e)
    }

    // Applied by handleResolutionChange (and the startup settings-restore
    // effect) once the engine's shm surface has been resized to match a new
    // previewResolutionScale. Updates the same sabWidth/sabHeight/canvas
    // closures the tick loop below reads every frame — no effect re-run or
    // WebGL context recreation needed. shm.meta itself was already updated
    // in place by preload's getFrameShm() before this fires.
    if (shm) {
      applyShmResizeRef.current = (w, h) => {
        if (!w || !h) return
        sabWidth = w
        sabHeight = h
        canvas.width  = w
        canvas.height = h
        if (gl) gl.viewport(0, 0, w, h)
        setOutputDims({ w, h })
      }
    }

    // ── Eyedropper pixel read ────────────────────────────────────────────
    // Samples the shared-memory frame directly. This is the ONLY correct
    // source: the WebGL context uses preserveDrawingBuffer:false, so reading
    // the canvas outside its draw call yields garbage. Syncs the freshest
    // frame rather than reusing the tick's copy so a paused preview still
    // picks the pixel currently on screen.
    if (shm) {
      pickPixelRef.current = (nx, ny) => {
        const px = Math.min(sabWidth  - 1, Math.max(0, Math.round(nx * (sabWidth  - 1))))
        const py = Math.min(sabHeight - 1, Math.max(0, Math.round(ny * (sabHeight - 1))))
        const idx = shm.readIndex()
        shm.syncFrame(idx)
        const frame = (idx === 0) ? bufA : bufB
        if (!frame) return null
        const o = (py * sabWidth + px) * 4
        if (o + 2 >= frame.length) return null
        // shm frames are BGRA (see the pixel-diag labelling above).
        return { r: frame[o + 2] / 255, g: frame[o + 1] / 255, b: frame[o] / 255 }
      }
    }

    // ── Set up WebGL (fallback: Canvas2D) ────────────────────────────────
    let gl = null, program = null, texture = null
    let texW = 0, texH = 0, useWebGL = false

    try {
      gl = canvas.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: false })
      if (gl) {
        program = createProgram(gl, VERT_SRC, FRAG_SRC)
        if (program) {
          gl.useProgram(program)

          const posLoc = gl.getAttribLocation(program, 'a_position')
          const texLoc = gl.getAttribLocation(program, 'a_texCoord')

          const posBuf = gl.createBuffer()
          gl.bindBuffer(gl.ARRAY_BUFFER, posBuf)
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1,
          ]), gl.STATIC_DRAW)
          gl.enableVertexAttribArray(posLoc)
          gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0)

          const texBuf = gl.createBuffer()
          gl.bindBuffer(gl.ARRAY_BUFFER, texBuf)
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            0,1, 1,1, 0,0, 0,0, 1,1, 1,0,
          ]), gl.STATIC_DRAW)
          gl.enableVertexAttribArray(texLoc)
          gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0)

          texture = gl.createTexture()
          gl.bindTexture(gl.TEXTURE_2D, texture)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

          if (sabWidth > 0) gl.viewport(0, 0, sabWidth, sabHeight)
          useWebGL = true
          setMode('webgl')
          diag.mode = 'webgl'
          diag.drawApi = 'webgl'
          // Capture WebGL info ONCE so the diagnostic export can compare it
          // against DXGI LUID. This is the *real* live preview canvas — not
          // a probe context.
          try {
            const dbg = gl.getExtension('WEBGL_debug_renderer_info')
            diag.webgl = {
              vendor:           gl.getParameter(gl.VENDOR),
              renderer:         gl.getParameter(gl.RENDERER),
              version:          gl.getParameter(gl.VERSION),
              glsl:             gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
              unmaskedVendor:   dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)   : null,
              unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
              maxTextureSize:   gl.getParameter(gl.MAX_TEXTURE_SIZE),
              extensions:       gl.getSupportedExtensions() || [],
            }
          } catch (e) {
            diag.webgl = { error: String(e?.message || e) }
          }
        }
      }
    } catch {}

    // Track WebGL context loss/restoration — AMD drivers sometimes drop the
    // context under VRAM pressure and the canvas paints clear-color forever.
    function onContextLost(e) {
      e.preventDefault()
      diag.contextLostCount += 1
    }
    function onContextRestored() {
      diag.contextRestoredCount += 1
    }
    canvas.addEventListener('webglcontextlost', onContextLost, false)
    canvas.addEventListener('webglcontextrestored', onContextRestored, false)

    let ctx2d = null
    if (!useWebGL) {
      ctx2d = canvas.getContext('2d')
      setMode('canvas2d')
      diag.mode = 'canvas2d'
      diag.drawApi = 'canvas2d'
    }

    function drawNoVideo() {
      if (useWebGL) {
        const [r, g, b] = hexToGlColor(tokenValue('--theme-bg-primary') || '#0A0A0F')
        diag.clearColorRgb = [r, g, b]
        gl.clearColor(r, g, b, 1.0)
        gl.clear(gl.COLOR_BUFFER_BIT)
      } else if (ctx2d) {
        ctx2d.fillStyle = tokenValue('--theme-preview-loaded-bg')
        ctx2d.fillRect(0, 0, canvas.width, canvas.height)
        ctx2d.fillStyle = tokenValue('--theme-text-placeholder')
        ctx2d.font = uiCanvasFont('500 14px')
        ctx2d.textAlign = 'center'
        ctx2d.textBaseline = 'middle'
        ctx2d.fillText('No video loaded', canvas.width / 2, canvas.height / 2)
      }
    }

    function handleThemeChange() {
      if (useWebGL && gl) {
        const [r, g, b] = hexToGlColor(tokenValue('--theme-bg-primary') || '#0A0A0F')
        gl.clearColor(r, g, b, 1.0)
        gl.clear(gl.COLOR_BUFFER_BIT)
      } else {
        drawNoVideo()
      }
    }

    window.addEventListener('xleth-theme-changed', handleThemeChange)

    function tick() {
      if (!runningRef.current) { return }

      diag.lastTickAt = performance.now()

      if (shm) {
        // Poll the control word via native readInt32 (x86 aligned read is
        // atomic; writer uses std::atomic release store).
        const idx = shm.readIndex()
        if (idx !== lastIndex) {
          lastIndex = idx
          diag.shm.lastIndex = idx
          // memcpy the active half from the mapping into bufA/bufB
          shm.syncFrame(idx)
          const frame = (idx === 0) ? bufA : bufB

          let uploadOk = false
          if (useWebGL) {
            try {
              // ── Diag: renderer-pre-webgl-upload ──────────────────────────
              // Stats on the exact BGRA bytes read from shared memory, BEFORE
              // they touch WebGL. Compared against the engine's
              // post-frameoutput-write (also BGRA) this isolates transport vs
              // GPU-upload faults. Sampled sparingly — heavy full-frame loop.
              const sampleThis = pixelDiagEnabled && shouldSamplePixels(pixelDiagFrame)
              if (sampleThis) {
                try {
                  const stats = computeFrameStatsJS(frame, sabWidth, sabHeight, 'BGRA')
                  stats.shmIndex = idx
                  recordRendererStats('renderer-pre-webgl-upload', stats)
                } catch { /* never let diag break preview */ }
              }

              gl.bindTexture(gl.TEXTURE_2D, texture)
              if (texW !== sabWidth || texH !== sabHeight) {
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, sabWidth, sabHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame)
                texW = sabWidth; texH = sabHeight
              } else {
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, sabWidth, sabHeight, gl.RGBA, gl.UNSIGNED_BYTE, frame)
              }
              const err = gl.getError()
              if (pixelDiagEnabled) diag.glErrorAfterUpload = err
              if (err !== gl.NO_ERROR) {
                throw new Error(`gl.getError = 0x${err.toString(16)}`)
              }
              gl.drawArrays(gl.TRIANGLES, 0, 6)
              uploadOk = true

              // ── Diag: renderer-post-webgl-readpixels ─────────────────────
              // Read back what the GPU actually drew. If pre-upload is non-zero
              // but this is zero, the fault is in WebGL upload/draw/presentation.
              if (sampleThis) {
                try {
                  const need = sabWidth * sabHeight * 4
                  if (!readPixelsBuf || readPixelsBuf.length !== need) {
                    readPixelsBuf = new Uint8Array(need)
                  }
                  gl.readPixels(0, 0, sabWidth, sabHeight, gl.RGBA, gl.UNSIGNED_BYTE, readPixelsBuf)
                  const drawErr = gl.getError()
                  if (pixelDiagEnabled) diag.glErrorAfterDraw = drawErr
                  const stats = computeFrameStatsJS(readPixelsBuf, sabWidth, sabHeight, 'RGBA')
                  recordRendererStats('renderer-post-webgl-readpixels', stats)
                } catch { /* readPixels unsupported / context lost — skip */ }
              }
              if (pixelDiagEnabled) pixelDiagFrame++
            } catch (e) {
              diag.lastTexUploadError = String(e?.message || e)
            }
          } else if (ctx2d) {
            try {
              // Canvas2D fallback: shm is native BGRA (see FRAG_SRC above), but
              // ImageData has no channel-swizzle option — putImageData interprets
              // its bytes as literal RGBA. Unlike the WebGL path, this has to pay
              // for the swap in JS. Only the no-WebGL fallback pays it.
              // Size by the live frame, NOT frame.length — bufA/bufB are
              // allocated at the shm section's capacity and can be larger
              // than the current resolution. ImageData requires its buffer to
              // be exactly sabWidth*sabHeight*4 or it throws IndexSizeError.
              const need = sabWidth * sabHeight * 4
              if (!canvas2dScratch || canvas2dScratch.length !== need) {
                canvas2dScratch = new Uint8ClampedArray(need)
              }
              for (let o = 0; o < need; o += 4) {
                canvas2dScratch[o]     = frame[o + 2]
                canvas2dScratch[o + 1] = frame[o + 1]
                canvas2dScratch[o + 2] = frame[o]
                canvas2dScratch[o + 3] = frame[o + 3]
              }
              ctx2d.putImageData(new ImageData(canvas2dScratch, sabWidth, sabHeight), 0, 0)
              uploadOk = true
            } catch (e) {
              diag.lastTexUploadError = String(e?.message || e)
            }
          }
          if (uploadOk) {
            diag.texUploadSuccess += 1
            diag.shm.framesReceived += 1
            diag.shm.lastFrameW = sabWidth
            diag.shm.lastFrameH = sabHeight
            diag.lastTickAction = 'frame'
            if (!hasFrameLatched) { hasFrameLatched = true; setHasFrame(true) }
          } else {
            diag.texUploadFailures += 1
            diag.lastTickAction = 'upload-failed'
          }
          frameCount++
        } else {
          diag.lastTickAction = 'no-frame'
        }
      } else {
        drawNoVideo()
        diag.lastTickAction = 'no-shm'
      }

      const now = performance.now()
      if (now - lastFpsTime >= 1000) {
        setFps(frameCount)
        frameCount = 0
        lastFpsTime = now
      }

      rafId = requestAnimationFrame(tick)
    }

    tickRef.current = tick
    rafId = requestAnimationFrame(tick)
    return () => {
      runningRef.current = false
      tickRef.current = null
      pickPixelRef.current = null
      applyShmResizeRef.current = null
      window.removeEventListener('xleth-theme-changed', handleThemeChange)
      canvas.removeEventListener('webglcontextlost', onContextLost)
      canvas.removeEventListener('webglcontextrestored', onContextRestored)
      if (window.__xlethVisualPreviewDiag === diag) {
        window.__xlethVisualPreviewDiag = null
      }
      if (rafId) cancelAnimationFrame(rafId)
      if (gl && texture) gl.deleteTexture(texture)
      if (gl && program) gl.deleteProgram(program)
    }
  }, [initReady])

  useOnVisibilityChange((isVisible) => {
    runningRef.current = isVisible
    if (isVisible && tickRef.current) {
      // resume: schedule next frame
      requestAnimationFrame(tickRef.current)
    }
  })

  // Keep CSS vars in sync whenever the canvas output dimensions change.
  // The content bounds match the canvas's object-fit: contain rectangle, so
  // both the grid overlay and dock line up with the visible preview rather
  // than the larger letterboxed canvas area.
  useEffect(() => {
    const wrapper    = wrapperRef.current
    const canvasArea = canvasAreaRef.current
    if (!wrapper) return
    const aspect = (outputDims.w > 0 && outputDims.h > 0)
      ? outputDims.w / outputDims.h
      : 16 / 9
    canvasAspectRef.current = aspect
    wrapper.style.setProperty(
      '--xleth-canvas-aspect',
      outputDims.w > 0 ? `${outputDims.w} / ${outputDims.h}` : '16 / 9'
    )
    // Recalculate content bounds immediately so the overlay and dock stay
    // aligned even when a dimension change doesn't trigger a container resize.
    if (canvasArea) {
      const { width, height } = canvasArea.getBoundingClientRect()
      if (width > 0 && height > 0) {
        wrapper.style.setProperty('--xleth-canvas-content-width', `${Math.min(width, height * aspect)}px`)
        wrapper.style.setProperty('--xleth-canvas-content-height', `${Math.min(height, width / aspect)}px`)
      }
    }
  }, [outputDims])

  // ResizeObserver: keep dock width aligned as the container is resized.
  // The callback reads canvasAspectRef so it always uses the current aspect
  // without needing to be recreated when outputDims changes.
  useEffect(() => {
    const canvasArea = canvasAreaRef.current
    const wrapper    = wrapperRef.current
    if (!canvasArea || !wrapper) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      const aspect = canvasAspectRef.current
      wrapper.style.setProperty('--xleth-canvas-content-width', `${Math.min(width, height * aspect)}px`)
      wrapper.style.setProperty('--xleth-canvas-content-height', `${Math.min(height, width / aspect)}px`)
    })
    observer.observe(canvasArea)
    return () => observer.disconnect()
  }, [])

  // Poll the poster prepass status while poster mode is on so the loading overlay
  // can show progress and clear itself when the cache is warm. Polls slowly when
  // idle and quickly while the engine is actually holding video, then stops once
  // poster mode is off. Cheap: one IPC round-trip per interval reading a few ints.
  useEffect(() => {
    if (!posterMode) {
      setPosterLoad({ active: false, completed: 0, total: 0, pending: 0, holdingVideo: false })
      return
    }
    let cancelled = false
    let timer = null
    const poll = async () => {
      try {
        const st = await window.xleth?.posterPrepass?.getStatus?.()
        if (!cancelled && st) {
          setPosterLoad({
            active:       !!st.active,
            completed:    st.completed | 0,
            total:        st.total | 0,
            pending:      st.pending | 0,
            holdingVideo: !!st.holdingVideo,
          })
          // Poll fast while holding video (responsive progress bar). When idle,
          // still poll a few times a second so the overlay appears promptly after
          // Play engages a hold — the call is just a few ints over IPC.
          timer = setTimeout(poll, st.holdingVideo ? 150 : 250)
        } else if (!cancelled) {
          timer = setTimeout(poll, 250)
        }
      } catch {
        if (!cancelled) timer = setTimeout(poll, 1000)
      }
    }
    poll()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [posterMode])

  const handlePosterSkip = useCallback(async () => {
    try { await window.xleth?.posterPrepass?.skip?.() } catch { /* no-op */ }
    setPosterLoad((p) => ({ ...p, holdingVideo: false, active: false }))
  }, [])

  const posterLoadPct = posterLoad.total > 0
    ? Math.round((posterLoad.completed / posterLoad.total) * 100)
    : 0

  // Poll the proxy-migration batch while the panel is visible: every second
  // while a migration runs, every 3 s otherwise (a project open can start one
  // at any time). One IPC round-trip reading a few ints; silent in the log.
  useEffect(() => {
    if (!isVisible) return
    let cancelled = false
    let timer = null
    const toBatch = (m) => ({
      active:    !!m.active,
      total:     m.total | 0,
      completed: m.completed | 0,
      failed:    m.failed | 0,
      progress:  Number(m.progress) || 0,
    })
    const poll = async () => {
      let active = false
      try {
        const st = await window.xleth?.proxy?.getStatus?.()
        if (!cancelled && st?.migration) {
          active = !!st.migration.active
          setProxyMigration(toBatch(st.migration))
        }
        if (!cancelled && st?.rebuild) {
          active = active || !!st.rebuild.active
          setProxyRebuild(toBatch(st.rebuild))
        }
      } catch { /* engine not ready yet — try again next tick */ }
      if (!cancelled) timer = setTimeout(poll, active ? 1000 : 3000)
    }
    poll()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [isVisible])

  const batchPct = (b) => Math.round(Math.min(1, Math.max(0, b.progress)) * 100)
  const proxyMigrationPct = batchPct(proxyMigration)
  const proxyRebuildPct = batchPct(proxyRebuild)

  // ── Chroma Key eyedropper ──────────────────────────────────────────────────
  // While a pick is in flight the canvas takes a crosshair and the next click
  // resolves the pick with that pixel, read from shared memory (see
  // pickPixelRef). Escape or a right-click cancels.
  const [eyedropperActive, setEyedropperActive] = useState(false)

  useEffect(() => subscribe((s) => setEyedropperActive(s.active)), [])

  useEffect(() => {
    if (!eyedropperActive) return
    const canvas = canvasRef.current
    if (!canvas) return

    const onClick = (e) => {
      e.preventDefault()
      e.stopPropagation()
      const rect = canvas.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) { cancelPick(); return }
      // The shm frame is drawn stretched across the whole canvas, so display
      // coordinates normalize straight onto frame coordinates.
      const nx = (e.clientX - rect.left) / rect.width
      const ny = (e.clientY - rect.top)  / rect.height
      const rgb = pickPixelRef.current?.(nx, ny)
      if (rgb) completePick(rgb)
      else cancelPick()
    }
    const onKey     = (e) => { if (e.key === 'Escape') cancelPick() }
    const onContext = (e) => { e.preventDefault(); cancelPick() }

    const prevCursor = canvas.style.cursor
    canvas.style.cursor = 'crosshair'
    // Capture phase so the grid-editor overlay cannot swallow the pick click.
    canvas.addEventListener('click', onClick, true)
    canvas.addEventListener('contextmenu', onContext, true)
    window.addEventListener('keydown', onKey)

    return () => {
      canvas.style.cursor = prevCursor
      canvas.removeEventListener('click', onClick, true)
      canvas.removeEventListener('contextmenu', onContext, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [eyedropperActive])

  return (
    <div className={styles.root} ref={containerRef}>
      <PreviewHeader
        fps={fps}
        mode={mode}
        outputDims={outputDims}
        resolutionScale={resolutionScale}
        autoResolution={autoResolution}
        onResolutionChange={handleResolutionChange}
        effectsBypass={effectsBypass}
        onEffectsToggle={handleEffectsBypassToggle}
        posterMode={posterMode}
        onPosterToggle={handlePosterModeToggle}
        gridEditMode={gridEditMode}
        onGridEditChange={(next) => setGridEditMode?.(next)}
        importing={importing}
        onImport={handleImport}
        headerActions={headerActions}
      />
      {gridEditMode && <GridEditToolbar />}
      <div className={styles.stage} data-grid-editing={gridEditMode ? 'true' : undefined} ref={wrapperRef}>
        <div className={styles.area} ref={canvasAreaRef}>
          <canvas ref={canvasRef} width={960} height={540} className={styles.canvas} />
          {!hasFrame && (
            <div className={styles.placeholder} role="status">
              {mode === 'no-shm' || mode === 'shm-error' ? 'Preview unavailable' : 'No frame yet'}
            </div>
          )}
          {gridEditMode && <GridEditorOverlay />}

          {/* Poster prepass loading overlay. Shown while the engine holds the
              video compositor to warm the one-poster-per-source cache. Audio
              keeps playing underneath; "Skip to live" drops the hold. */}
          {posterMode && posterLoad.holdingVideo && (
            <div className="poster-load-overlay" role="status" aria-live="polite">
              <div className="poster-load-card">
                <Loader2 size={22} className="poster-load-spin" />
                <div className="poster-load-title">Loading sample previews</div>
                <div className="poster-load-sub">
                  Poster mode is caching one frame per sample on the timeline.
                  Audio is playing — video resumes when loading finishes.
                </div>
                <div className="poster-load-bar">
                  <div
                    className="poster-load-bar-fill"
                    style={{ width: `${posterLoadPct}%` }}
                  />
                </div>
                <div className="poster-load-count">
                  {posterLoad.completed} / {posterLoad.total} samples
                  {posterLoad.total > 0 ? ` · ${posterLoadPct}%` : ''}
                </div>
                <button
                  type="button"
                  className="poster-load-skip"
                  onClick={handlePosterSkip}
                  title="Stop waiting and resume video now. Remaining frames keep loading in the background."
                >
                  Skip to live
                </button>
              </div>
            </div>
          )}

          {/* Background proxy work badges. Informational only — nothing is
              blocked; the project stays fully usable meanwhile. Stacked so a
              rebuild and a codec migration can both be shown. */}
          {(proxyRebuild.active || proxyMigration.active) && (
            <div className="proxy-badge-stack">
              {proxyRebuild.active && (
                <ProxyBatchBadge
                  label="Rebuilding previews"
                  title="Rebuilding preview files that were removed or never generated. Preview and editing work normally meanwhile."
                  batch={proxyRebuild}
                  pct={proxyRebuildPct}
                  testId="proxy-rebuild-badge"
                />
              )}
              {proxyMigration.active && (
                <ProxyBatchBadge
                  label="Optimizing proxies"
                  title="Converting this project's preview proxies to H.264 to save disk space. Preview and editing work normally meanwhile."
                  batch={proxyMigration}
                  pct={proxyMigrationPct}
                  testId="proxy-migration-badge"
                />
              )}
            </div>
          )}
        </div>
        {gridEditMode && <GridEditorDock />}
      </div>
    </div>
  )
}
