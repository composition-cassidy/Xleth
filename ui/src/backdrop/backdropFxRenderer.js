import {
  BACKDROP_FX_FRAGMENT_SHADER,
  BACKDROP_FX_MAX_RECTS,
  BACKDROP_FX_MAX_RIPPLES,
  BACKDROP_FX_VERTEX_SHADER,
} from './backdropFxShaders.js'
import {
  backdropFxIntensityUniforms,
  backdropFxPresetToUniform,
  backdropFxPresetNeedsAnimation,
  isBackdropFxReactivePreset,
  qualityToRenderConfig,
  sanitizeBackdropFxSettings,
} from './backdropFxSettings.js'

const RIPPLE_DURATION_SECONDS = 1.4

function clamp01(value) {
  return Math.max(0, Math.min(1, value))
}

function parseColor(value, fallback) {
  if (typeof value !== 'string') return fallback
  const text = value.trim()
  const hex = text.match(/^#([0-9a-f]{6})$/i)
  if (hex) {
    const n = Number.parseInt(hex[1], 16)
    return [
      ((n >> 16) & 255) / 255,
      ((n >> 8) & 255) / 255,
      (n & 255) / 255,
    ]
  }
  const rgb = text.match(/^rgba?\(([^)]+)\)$/i)
  if (rgb) {
    const parts = rgb[1].split(',').map((part) => Number.parseFloat(part))
    if (parts.length >= 3 && parts.every((part, index) => index > 2 || Number.isFinite(part))) {
      return [clamp01(parts[0] / 255), clamp01(parts[1] / 255), clamp01(parts[2] / 255)]
    }
  }
  return fallback
}

export function readBackdropFxThemeUniforms(root = typeof document !== 'undefined' ? document.documentElement : null) {
  if (!root || typeof getComputedStyle === 'undefined') {
    return {
      tint: [0.22, 0.28, 0.33],
      surface: [0.05, 0.06, 0.08],
      accent: [0.25, 0.72, 0.78],
    }
  }
  const styles = getComputedStyle(root)
  return {
    tint: parseColor(styles.getPropertyValue('--theme-bg-secondary'), [0.22, 0.28, 0.33]),
    surface: parseColor(styles.getPropertyValue('--theme-bg-primary'), [0.05, 0.06, 0.08]),
    accent: parseColor(styles.getPropertyValue('--theme-accent'), [0.25, 0.72, 0.78]),
  }
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('createShader returned null')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader) || 'unknown shader compile error'
    gl.deleteShader(shader)
    throw new Error(info)
  }
  return shader
}

function createProgram(gl) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, BACKDROP_FX_VERTEX_SHADER)
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, BACKDROP_FX_FRAGMENT_SHADER)
  const program = gl.createProgram()
  if (!program) throw new Error('createProgram returned null')
  gl.attachShader(program, vertexShader)
  gl.attachShader(program, fragmentShader)
  gl.linkProgram(program)
  gl.deleteShader(vertexShader)
  gl.deleteShader(fragmentShader)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program) || 'unknown shader link error'
    gl.deleteProgram(program)
    throw new Error(info)
  }
  return program
}

function createFullscreenBuffer(gl, program) {
  const buffer = gl.createBuffer()
  if (!buffer) throw new Error('createBuffer returned null')
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW,
  )
  const location = gl.getAttribLocation(program, 'aPosition')
  if (location >= 0) {
    gl.enableVertexAttribArray(location)
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0)
  }
  return buffer
}

function isDocumentHidden() {
  return typeof document !== 'undefined' && document.hidden
}

function rectViewport(rect, fallback = {}) {
  return {
    width: Math.max(1, Number(rect?.width ?? fallback.width ?? 1)),
    height: Math.max(1, Number(rect?.height ?? fallback.height ?? 1)),
  }
}

export function clientPointToShaderPoint(clientX, clientY, workAreaRect, viewport) {
  rectViewport(viewport, workAreaRect)
  const left = Number(workAreaRect?.left) || 0
  const top = Number(workAreaRect?.top) || 0
  const x = Number(clientX) - left
  return {
    x,
    y: Number(clientY) - top,
  }
}

export function clientRectToShaderRect(rect, workAreaRect, viewport) {
  rectViewport(viewport, workAreaRect)
  const left = Number(workAreaRect?.left) || 0
  const top = Number(workAreaRect?.top) || 0
  const width = Math.max(0, Number(rect?.width) || 0)
  const height = Math.max(0, Number(rect?.height) || 0)
  const x = (Number(rect?.left) || 0) - left
  return {
    x,
    y: (Number(rect?.top) || 0) - top,
    width,
    height,
  }
}

export function createBackdropFxRenderer(canvas, options = {}) {
  return new BackdropFxRenderer(canvas, options)
}

export class BackdropFxRenderer {
  constructor(canvas, {
    now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    requestFrame = (cb) => requestAnimationFrame(cb),
    cancelFrame = (id) => cancelAnimationFrame(id),
    getDevicePixelRatio = () => (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1),
  } = {}) {
    this.canvas = canvas
    this.now = now
    this.requestFrame = requestFrame
    this.cancelFrame = cancelFrame
    this.getDevicePixelRatio = getDevicePixelRatio
    this.settings = sanitizeBackdropFxSettings(null)
    this.theme = readBackdropFxThemeUniforms()
    this.imageUrl = ''
    this.imageLoadId = 0
    this.videoElement = null
    this.hasImageTexture = false
    this.failed = false
    this.frameId = null
    this.ripples = []
    this.rects = []
    this.cursor = { x: -1, y: -1 }
    this.size = { cssWidth: 1, cssHeight: 1, width: 1, height: 1 }
    this.gl = null
    this.program = null
    this.buffer = null
    this.texture = null
    this.uniforms = {}
    this.handleVisibilityChange = () => {
      if (isDocumentHidden()) this.stopLoop()
      else if (this.hasActiveRipples() || this.shouldRenderContinuously()) this.startLoop()
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange)
    }
  }

  init() {
    if (this.gl || this.failed) return !this.failed
    let gl = null
    try {
      gl = this.canvas.getContext('webgl2', {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
        powerPreference: 'low-power',
      })
    } catch (err) {
      this.fail(err)
      return false
    }
    if (!gl) {
      this.fail(new Error('WebGL2 unavailable'))
      return false
    }

    try {
      this.gl = gl
      this.program = createProgram(gl)
      this.buffer = createFullscreenBuffer(gl, this.program)
      this.texture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, this.texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]))
      this.uniforms = {
        image: gl.getUniformLocation(this.program, 'uImage'),
        hasImage: gl.getUniformLocation(this.program, 'uHasImage'),
        preset: gl.getUniformLocation(this.program, 'uPreset'),
        intensity: gl.getUniformLocation(this.program, 'uIntensity'),
        intensityChannels: gl.getUniformLocation(this.program, 'uIntensityChannels'),
        time: gl.getUniformLocation(this.program, 'uTime'),
        resolution: gl.getUniformLocation(this.program, 'uResolution'),
        cursor: gl.getUniformLocation(this.program, 'uCursor'),
        rippleCount: gl.getUniformLocation(this.program, 'uRippleCount'),
        ripples: gl.getUniformLocation(this.program, 'uRipples[0]'),
        rectCount: gl.getUniformLocation(this.program, 'uRectCount'),
        rects: gl.getUniformLocation(this.program, 'uRects[0]'),
        tint: gl.getUniformLocation(this.program, 'uTint'),
        surface: gl.getUniformLocation(this.program, 'uSurface'),
        accent: gl.getUniformLocation(this.program, 'uAccent'),
        reactToCursor: gl.getUniformLocation(this.program, 'uReactToCursor'),
        reactToWindows: gl.getUniformLocation(this.program, 'uReactToWindows'),
        reactToClicks: gl.getUniformLocation(this.program, 'uReactToClicks'),
        studioGridOverlay: gl.getUniformLocation(this.program, 'uStudioGridOverlay'),
      }
      this.canvas.style.display = ''
      this.resize()
      return true
    } catch (err) {
      this.fail(err)
      return false
    }
  }

  fail(err) {
    console.warn('[BackdropFX] disabled:', err?.message || err)
    this.failed = true
    this.canvas.style.display = 'none'
    this.disposeGl()
  }

  update({ settings, imageUrl, videoElement, theme } = {}) {
    this.settings = sanitizeBackdropFxSettings(settings ?? this.settings)
    if (theme) this.theme = theme
    if (!this.settings.enabled) {
      this.stopLoop()
      return
    }
    if (!this.init()) return
    this.resize()
    this.setVideoElement(videoElement || null)
    this.setImageUrl(videoElement ? '' : (imageUrl || ''))
    this.renderOnce()
    if (this.shouldRenderContinuously()) this.startLoop()
  }

  setTheme(theme = readBackdropFxThemeUniforms()) {
    this.theme = theme
    if (this.settings.enabled) this.renderOnce()
  }

  setImageUrl(url) {
    const nextUrl = typeof url === 'string' ? url : ''
    if (nextUrl === this.imageUrl) return
    this.imageUrl = nextUrl
    this.hasImageTexture = false
    this.imageLoadId += 1
    if (!nextUrl) {
      this.renderOnce()
      return
    }
    if (typeof Image === 'undefined') {
      this.fail(new Error('Image constructor unavailable'))
      return
    }
    const loadId = this.imageLoadId
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => {
      if (loadId !== this.imageLoadId || this.failed || !this.gl || !this.texture) return
      try {
        const gl = this.gl
        gl.bindTexture(gl.TEXTURE_2D, this.texture)
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
        this.hasImageTexture = true
        this.renderOnce()
      } catch (err) {
        this.fail(err)
      }
    }
    image.onerror = () => {
      if (loadId === this.imageLoadId) this.fail(new Error('Backdrop image texture failed to load'))
    }
    image.src = nextUrl
  }

  setVideoElement(videoElement) {
    const nextElement = videoElement || null
    if (nextElement === this.videoElement) return
    this.videoElement = nextElement
    if (nextElement) {
      this.imageUrl = ''
      this.imageLoadId += 1
      this.hasImageTexture = false
    }
  }

  resize() {
    if (!this.gl || this.failed) return
    const rect = this.canvas.getBoundingClientRect()
    const cssWidth = Math.max(1, Math.round(rect.width || this.canvas.clientWidth || 1))
    const cssHeight = Math.max(1, Math.round(rect.height || this.canvas.clientHeight || 1))
    const config = qualityToRenderConfig(this.settings.quality, this.getDevicePixelRatio())
    const width = Math.max(1, Math.round(cssWidth * config.pixelRatio))
    const height = Math.max(1, Math.round(cssHeight * config.pixelRatio))
    if (this.canvas.width !== width) this.canvas.width = width
    if (this.canvas.height !== height) this.canvas.height = height
    this.size = { cssWidth, cssHeight, width, height }
    this.gl.viewport(0, 0, width, height)
  }

  setCursor(clientX, clientY, workAreaRect) {
    if (!this.settings.enabled || !this.settings.reactToCursor) return
    this.cursor = clientPointToShaderPoint(clientX, clientY, workAreaRect, this.size)
    this.renderOnce()
  }

  clearCursor() {
    this.cursor = { x: -1, y: -1 }
    if (this.settings.enabled) this.renderOnce()
  }

  addRipple(clientX, clientY, workAreaRect) {
    if (!this.settings.enabled || !this.settings.reactToClicks) return
    const point = clientPointToShaderPoint(clientX, clientY, workAreaRect, this.size)
    this.ripples.push({
      x: point.x,
      y: point.y,
      start: this.now() / 1000,
      duration: RIPPLE_DURATION_SECONDS,
    })
    if (this.ripples.length > BACKDROP_FX_MAX_RIPPLES) {
      this.ripples.splice(0, this.ripples.length - BACKDROP_FX_MAX_RIPPLES)
    }
    this.startLoop()
  }

  setPanelRects(rects) {
    this.rects = Array.isArray(rects) ? rects.slice(0, BACKDROP_FX_MAX_RECTS) : []
    if (this.settings.enabled) this.renderOnce()
  }

  hasActiveRipples(time = this.now() / 1000) {
    return this.ripples.some((ripple) => time - ripple.start < ripple.duration)
  }

  startLoop() {
    if (!this.gl || this.failed || this.frameId !== null || isDocumentHidden()) return
    if (!backdropFxPresetNeedsAnimation(this.settings) && !this.shouldRenderContinuously()) return
    this.frameId = this.requestFrame((timestamp) => this.renderFrame(timestamp))
  }

  stopLoop() {
    if (this.frameId !== null) {
      this.cancelFrame(this.frameId)
      this.frameId = null
    }
  }

  renderFrame(timestamp) {
    this.frameId = null
    const seconds = (Number.isFinite(timestamp) ? timestamp : this.now()) / 1000
    this.render(seconds)
    this.ripples = this.ripples.filter((ripple) => seconds - ripple.start < ripple.duration)
    if (this.hasActiveRipples(seconds) || this.shouldRenderContinuously()) this.startLoop()
  }

  renderOnce() {
    if (!this.gl || this.failed || !this.settings.enabled) return
    this.render(this.now() / 1000)
  }

  render(timeSeconds) {
    const gl = this.gl
    if (!gl || !this.program || this.failed) return
    this.resize()
    this.uploadVideoFrameIfReady()
    gl.useProgram(this.program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.uniform1i(this.uniforms.image, 0)
    gl.uniform1i(this.uniforms.hasImage, this.hasImageTexture ? 1 : 0)
    gl.uniform1i(this.uniforms.preset, backdropFxPresetToUniform(this.settings.preset))
    const intensity = backdropFxIntensityUniforms(this.settings.intensity)
    gl.uniform1f(this.uniforms.intensity, intensity.normalized)
    gl.uniform4f(
      this.uniforms.intensityChannels,
      intensity.displacement,
      intensity.glow,
      intensity.ripple,
      intensity.window,
    )
    gl.uniform1f(this.uniforms.time, timeSeconds)
    gl.uniform2f(this.uniforms.resolution, this.size.cssWidth, this.size.cssHeight)
    gl.uniform2f(this.uniforms.cursor, this.cursor.x, this.cursor.y)
    gl.uniform3fv(this.uniforms.tint, this.theme.tint)
    gl.uniform3fv(this.uniforms.surface, this.theme.surface)
    gl.uniform3fv(this.uniforms.accent, this.theme.accent)
    gl.uniform1i(this.uniforms.reactToCursor, this.settings.reactToCursor ? 1 : 0)
    gl.uniform1i(this.uniforms.reactToWindows, this.settings.reactToWindows ? 1 : 0)
    gl.uniform1i(this.uniforms.reactToClicks, this.settings.reactToClicks ? 1 : 0)
    gl.uniform1i(
      this.uniforms.studioGridOverlay,
      this.settings.preset === 'subtle-glass' && this.settings.studioGridOverlay ? 1 : 0,
    )

    const rippleData = new Float32Array(BACKDROP_FX_MAX_RIPPLES * 4)
    this.ripples.slice(0, BACKDROP_FX_MAX_RIPPLES).forEach((ripple, index) => {
      rippleData[index * 4] = ripple.x
      rippleData[index * 4 + 1] = ripple.y
      rippleData[index * 4 + 2] = ripple.start
      rippleData[index * 4 + 3] = ripple.duration
    })
    gl.uniform1i(this.uniforms.rippleCount, Math.min(this.ripples.length, BACKDROP_FX_MAX_RIPPLES))
    gl.uniform4fv(this.uniforms.ripples, rippleData)

    const rectData = new Float32Array(BACKDROP_FX_MAX_RECTS * 4)
    this.rects.slice(0, BACKDROP_FX_MAX_RECTS).forEach((rect, index) => {
      rectData[index * 4] = rect.x
      rectData[index * 4 + 1] = rect.y
      rectData[index * 4 + 2] = rect.width
      rectData[index * 4 + 3] = rect.height
    })
    gl.uniform1i(this.uniforms.rectCount, Math.min(this.rects.length, BACKDROP_FX_MAX_RECTS))
    gl.uniform4fv(this.uniforms.rects, rectData)

    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  shouldRenderContinuously() {
    return !!this.videoElement
      && this.settings.enabled
      && isBackdropFxReactivePreset(this.settings.preset)
  }

  uploadVideoFrameIfReady() {
    if (!this.videoElement || !this.gl || !this.texture || this.failed) return
    const readyState = Number(this.videoElement.readyState) || 0
    const haveCurrentData = typeof HTMLMediaElement !== 'undefined'
      ? HTMLMediaElement.HAVE_CURRENT_DATA
      : 2
    if (readyState < haveCurrentData) return
    try {
      const gl = this.gl
      gl.bindTexture(gl.TEXTURE_2D, this.texture)
      gl.pixelStorei?.(gl.UNPACK_FLIP_Y_WEBGL, true)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.videoElement)
      this.hasImageTexture = true
    } catch (err) {
      this.fail(err)
    }
  }

  disposeGl() {
    const gl = this.gl
    if (!gl) return
    try {
      if (this.texture) gl.deleteTexture(this.texture)
      if (this.buffer) gl.deleteBuffer(this.buffer)
      if (this.program) gl.deleteProgram(this.program)
    } catch {}
    this.gl = null
    this.program = null
    this.buffer = null
    this.texture = null
    this.hasImageTexture = false
  }

  dispose() {
    this.stopLoop()
    this.imageLoadId += 1
    this.videoElement = null
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    }
    this.disposeGl()
  }
}
