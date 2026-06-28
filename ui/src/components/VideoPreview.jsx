import { useRef, useEffect, useState, useCallback } from 'react'
import { Import, Grid3x3, Image, Film } from 'lucide-react'
import GridEditorOverlay from './GridEditorOverlay.jsx'
import GridEditorDock from './GridEditorDock.jsx'
import { tokenValue } from '../theming/tokenValue.ts'
import useGridEditStore from '../stores/useGridEditStore.js'
import { usePanelVisibility } from '../windowing/contexts/PanelVisibilityContext'
import { uiCanvasFont } from '../styles/typography.js'

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
const FRAG_SRC = `
  precision mediump float;
  varying vec2 v_texCoord;
  uniform sampler2D u_texture;
  void main() {
    gl_FragColor = texture2D(u_texture, v_texCoord);
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
// labelled ('RGBA' here, since shm + readPixels are both RGBA) so first-byte
// comparisons against native BGRA are never made blindly. Heavy (~full-frame
// loop) — callers gate on the diag flag and sample sparingly.
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

export default function VideoPreview() {
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
  const [videoFile, setVideoFile] = useState(null)
  const [importing, setImporting] = useState(false)
  const [fps, setFps] = useState(0)
  const [mode, setMode] = useState('init')
  const [outputDims, setOutputDims] = useState({ w: 0, h: 0 })

  // ── Preview performance controls ─────────────────────────────────────────
  const [resolutionScale, setResolutionScale] = useState(1.0)
  const [effectsBypass, setEffectsBypass] = useState(false)
  // Poster fast-preview mode: grid cells show a single representative frame
  // instead of live video. Default ON. Preview-only — never affects render.
  const [posterMode, setPosterMode] = useState(true)
  const [initReady, setInitReady] = useState(false)

  // Restore persisted settings on mount
  useEffect(() => {
    async function restorePreviewSettings() {
      try {
        // Read from settings store (workstation-local, not project)
        const scale  = await window.xleth?.settings?.get('previewResolutionScale')
        const bypass = await window.xleth?.settings?.get('previewEffectsBypass')
        const poster = await window.xleth?.settings?.get('previewPosterMode')
        const resolvedScale  = (typeof scale  === 'number') ? scale  : 1.0
        const resolvedBypass = (typeof bypass === 'boolean') ? bypass : false
        // Poster mode defaults ON when no preference is stored yet.
        const resolvedPoster = (typeof poster === 'boolean') ? poster : true
        setResolutionScale(resolvedScale)
        setEffectsBypass(resolvedBypass)
        setPosterMode(resolvedPoster)
        // Apply to engine
        await window.xleth?.timeline?.setPreviewResolutionScale(resolvedScale)
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

  const handleResolutionChange = useCallback(async (e) => {
    const scale = parseFloat(e.target.value)
    setResolutionScale(scale)
    await window.xleth?.timeline?.setPreviewResolutionScale(scale)
    await window.xleth?.settings?.set('previewResolutionScale', scale)
  }, [])

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
      const filePath = await window.xleth?.importVideo()
      if (filePath) setVideoFile(filePath.replace(/^.*[\\/]/, ''))
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
              // Stats on the exact RGBA bytes read from shared memory, BEFORE
              // they touch WebGL. Compared against the engine's
              // post-frameoutput-write (also RGBA) this isolates transport vs
              // GPU-upload faults. Sampled sparingly — heavy full-frame loop.
              const sampleThis = pixelDiagEnabled && shouldSamplePixels(pixelDiagFrame)
              if (sampleThis) {
                try {
                  const stats = computeFrameStatsJS(frame, sabWidth, sabHeight, 'RGBA')
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
              // Canvas2D fallback: putImageData needs a Uint8ClampedArray view over
              // the same SAB region. ImageData constructor requires it.
              const clamped = new Uint8ClampedArray(frame.buffer, frame.byteOffset, frame.byteLength)
              ctx2d.putImageData(new ImageData(clamped, sabWidth, sabHeight), 0, 0)
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
  // --xleth-canvas-aspect drives the overlay's aspect-ratio.
  // --xleth-canvas-content-width drives the dock's alignment width.
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
    // Recalculate content width immediately so the dock stays aligned even
    // when a dimension change doesn't trigger a container resize.
    if (canvasArea) {
      const { width, height } = canvasArea.getBoundingClientRect()
      if (width > 0) {
        wrapper.style.setProperty('--xleth-canvas-content-width', `${Math.min(width, height * aspect)}px`)
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
      const w = Math.min(width, height * canvasAspectRef.current)
      wrapper.style.setProperty('--xleth-canvas-content-width', `${w}px`)
    })
    observer.observe(canvasArea)
    return () => observer.disconnect()
  }, [])

  return (
    <div className={`video-preview ${videoFile ? 'has-video' : 'is-empty'}`} ref={containerRef}>
      <div className="video-header">
        <div className="video-header-left">
          {videoFile && <span className="video-filename">{videoFile}</span>}
        </div>
        <div className="video-header-right">
          <span className="video-fps">{fps} FPS</span>
          <span className="video-mode">{mode}</span>

          {/* Current preview output resolution. Shows scale qualifier when
              not at 100% so the user always knows whether the preview is
              running at native resolution or downsampled. */}
          {outputDims.w > 0 && (
            <span className="video-resolution" title="Current preview output resolution">
              {outputDims.w}×{outputDims.h}
              {resolutionScale < 0.999 && ` (${Math.round(resolutionScale * 100)}%)`}
            </span>
          )}

          {/* Resolution scale dropdown */}
          <select
            className="preview-resolution-select"
            value={resolutionScale}
            onChange={handleResolutionChange}
            title="Preview resolution (lower = faster)"
          >
            <option value="1.0">100%</option>
            <option value="0.75">75%</option>
            <option value="0.5">50%</option>
            <option value="0.25">25%</option>
          </select>

          {/* Effects bypass toggle */}
          <button
            className={`preview-fx-btn ${effectsBypass ? 'bypassed' : 'active'}`}
            onClick={handleEffectsBypassToggle}
            title={effectsBypass ? 'Effects bypassed (click to enable)' : 'Effects active (click to bypass)'}
          >
            FX
          </button>

          {/* Poster fast-preview toggle. Poster = grid cells show one static
              representative frame (fast); Live = full per-frame decode. */}
          <button
            className={`preview-poster-btn ${posterMode ? 'poster' : 'live'}`}
            onClick={handlePosterModeToggle}
            title={posterMode
              ? 'Poster preview: grid cells show a static frame (fast). Click for live video.'
              : 'Live preview: grid cells decode every frame. Click for fast poster mode.'}
          >
            {posterMode ? <Image size={13} /> : <Film size={13} />}
            <span>{posterMode ? 'Poster' : 'Live'}</span>
          </button>

          {/* Persistent fidelity warning: poster preview does NOT match the
              rendered output. Render is always frame-accurate regardless. */}
          {posterMode && (
            <span
              className="preview-fidelity-badge"
              title="Poster preview shows static frames for speed. The exported render is always full-fidelity, frame-accurate video — this preview does not match it."
            >
              Preview ≠ Render
            </span>
          )}

          <button
            className={`video-import-btn ${gridEditMode ? 'active' : ''}`}
            onClick={() => setGridEditMode && setGridEditMode(!gridEditMode)}
            title="Toggle grid editor"
          >
            <Grid3x3 size={13} />
            <span>Edit Grid</span>
          </button>
          <button className="video-import-btn" onClick={handleImport} disabled={importing}>
            <Import size={13} />
            <span>{importing ? 'Loading...' : 'Import'}</span>
          </button>
        </div>
      </div>
      <div className={`video-canvas-wrapper ${gridEditMode ? 'grid-editing' : ''}`} ref={wrapperRef}>
        <div className="video-canvas-area" ref={canvasAreaRef}>
          <canvas ref={canvasRef} width={960} height={540} className="video-canvas" />
          {gridEditMode && <GridEditorOverlay />}
        </div>
        {gridEditMode && <GridEditorDock />}
      </div>
    </div>
  )
}
