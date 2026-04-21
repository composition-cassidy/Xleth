import { useRef, useEffect, useState, useCallback } from 'react'
import { Import, Grid3x3 } from 'lucide-react'
import GridEditorOverlay from './GridEditorOverlay.jsx'
import { tokenValue } from '../theming/tokenValue.ts'

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

// ── Component ────────────────────────────────────────────────────────────────

export default function VideoPreview({ gridEditMode, setGridEditMode }) {
  const canvasRef = useRef(null)
  const containerRef = useRef(null)
  const [videoFile, setVideoFile] = useState(null)
  const [importing, setImporting] = useState(false)
  const [fps, setFps] = useState(0)
  const [mode, setMode] = useState('init')
  const [outputDims, setOutputDims] = useState({ w: 0, h: 0 })

  // ── Preview performance controls ─────────────────────────────────────────
  const [resolutionScale, setResolutionScale] = useState(1.0)
  const [effectsBypass, setEffectsBypass] = useState(false)

  // Restore persisted settings on mount
  useEffect(() => {
    async function restorePreviewSettings() {
      try {
        // Read from settings store (workstation-local, not project)
        const scale  = await window.xleth?.settings?.get('previewResolutionScale')
        const bypass = await window.xleth?.settings?.get('previewEffectsBypass')
        const resolvedScale  = (typeof scale  === 'number') ? scale  : 1.0
        const resolvedBypass = (typeof bypass === 'boolean') ? bypass : false
        setResolutionScale(resolvedScale)
        setEffectsBypass(resolvedBypass)
        // Apply to engine
        await window.xleth?.timeline?.setPreviewResolutionScale(resolvedScale)
        await window.xleth?.timeline?.setPreviewEffectsBypass(resolvedBypass)
      } catch (e) {
        console.error('[VideoPreview] Failed to restore preview settings:', e)
      }
    }
    restorePreviewSettings()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
    const canvas = canvasRef.current
    let rafId = null
    let running = true
    let frameCount = 0
    let lastFpsTime = performance.now()

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
      } else {
        bufA = shm.bufA
        bufB = shm.bufB
        sabWidth   = shm.meta.width
        sabHeight  = shm.meta.height
        bufferSize = shm.meta.bufferSize
        canvas.width  = sabWidth
        canvas.height = sabHeight
        setOutputDims({ w: sabWidth, h: sabHeight })
        console.log(`[VideoPreview] shm ready: ${shm.meta.name} ${sabWidth}x${sabHeight}`)
      }
    } catch (e) {
      console.error('[VideoPreview] openFrameShm failed:', e)
      setMode('shm-error')
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
        }
      }
    } catch {}

    let ctx2d = null
    if (!useWebGL) {
      ctx2d = canvas.getContext('2d')
      setMode('canvas2d')
    }

    function drawNoVideo() {
      if (useWebGL) {
        gl.clearColor(0.067, 0.067, 0.094, 1.0)
        gl.clear(gl.COLOR_BUFFER_BIT)
      } else if (ctx2d) {
        ctx2d.fillStyle = tokenValue('--theme-preview-loaded-bg')
        ctx2d.fillRect(0, 0, canvas.width, canvas.height)
        ctx2d.fillStyle = tokenValue('--theme-text-placeholder')
        ctx2d.font = '500 14px "Hanken Grotesk", system-ui'
        ctx2d.textAlign = 'center'
        ctx2d.textBaseline = 'middle'
        ctx2d.fillText('No video loaded', canvas.width / 2, canvas.height / 2)
      }
    }

    function tick() {
      if (!running) return

      if (shm) {
        // Poll the control word via native readInt32 (x86 aligned read is
        // atomic; writer uses std::atomic release store).
        const idx = shm.readIndex()
        if (idx !== lastIndex) {
          lastIndex = idx
          // memcpy the active half from the mapping into bufA/bufB
          shm.syncFrame(idx)
          const frame = (idx === 0) ? bufA : bufB

          if (useWebGL) {
            gl.bindTexture(gl.TEXTURE_2D, texture)
            if (texW !== sabWidth || texH !== sabHeight) {
              gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, sabWidth, sabHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame)
              texW = sabWidth; texH = sabHeight
            } else {
              gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, sabWidth, sabHeight, gl.RGBA, gl.UNSIGNED_BYTE, frame)
            }
            gl.drawArrays(gl.TRIANGLES, 0, 6)
          } else if (ctx2d) {
            // Canvas2D fallback: putImageData needs a Uint8ClampedArray view over
            // the same SAB region. ImageData constructor requires it.
            const clamped = new Uint8ClampedArray(frame.buffer, frame.byteOffset, frame.byteLength)
            ctx2d.putImageData(new ImageData(clamped, sabWidth, sabHeight), 0, 0)
          }
          frameCount++
        }
      } else {
        drawNoVideo()
      }

      const now = performance.now()
      if (now - lastFpsTime >= 1000) {
        setFps(frameCount)
        frameCount = 0
        lastFpsTime = now
      }

      rafId = requestAnimationFrame(tick)
    }

    rafId = requestAnimationFrame(tick)
    return () => {
      running = false
      if (rafId) cancelAnimationFrame(rafId)
      if (gl && texture) gl.deleteTexture(texture)
      if (gl && program) gl.deleteProgram(program)
    }
  }, [])

  return (
    <div className="video-preview" ref={containerRef}>
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
      <div className={`video-canvas-wrapper ${gridEditMode ? 'grid-editing' : ''}`}>
        <canvas ref={canvasRef} width={960} height={540} className="video-canvas" />
        {gridEditMode && <GridEditorOverlay />}
      </div>
    </div>
  )
}
