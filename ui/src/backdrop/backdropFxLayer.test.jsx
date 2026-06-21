/* @vitest-environment jsdom */
import React, { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BackdropLayer, {
  collectBackdropFxPanelRects,
  createBackdropFxPanelLayoutKey,
  installBackdropVideoLifecycle,
  isEmptyBackdropClickTarget,
} from './BackdropLayer.jsx'
import {
  clientPointToShaderPoint,
  clientRectToShaderRect,
  createBackdropFxRenderer,
} from './backdropFxRenderer.js'
import {
  DEFAULT_BACKDROP_FX_SETTINGS,
  useBackdropFxSettingsStore,
} from './backdropFxSettings.js'
import {
  useBackdropMediaSettingsStore,
} from './backdropMediaSettings.js'
import {
  beginDrag,
  cancelDrag,
  registerWorkAreaRect,
  updateDrag,
} from '../windowing/managers/DragManager'
import {
  createInitialDockRegionSizes,
  createInitialPanelStates,
  clonePanelStates,
  usePanelRegistry,
} from '../windowing/registry/PanelRegistry'

function installMatchMedia(matches = false) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: query === '(prefers-reduced-motion: reduce)' ? matches : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

function makeRenderer() {
  return {
    update: vi.fn(),
    setTheme: vi.fn(),
    resize: vi.fn(),
    renderOnce: vi.fn(),
    setPanelRects: vi.fn(),
    setCursor: vi.fn(),
    clearCursor: vi.fn(),
    addRipple: vi.fn(),
    dispose: vi.fn(),
  }
}

function makeFakeWebGl2() {
  return {
    VERTEX_SHADER: 0x8B31,
    FRAGMENT_SHADER: 0x8B30,
    COMPILE_STATUS: 0x8B81,
    LINK_STATUS: 0x8B82,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88E4,
    FLOAT: 0x1406,
    TEXTURE_2D: 0x0DE1,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    LINEAR: 0x2601,
    CLAMP_TO_EDGE: 0x812F,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    TEXTURE0: 0x84C0,
    COLOR_BUFFER_BIT: 0x4000,
    TRIANGLES: 0x0004,
    createShader: vi.fn((type) => ({ type })),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => ''),
    deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({})),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    getProgramInfoLog: vi.fn(() => ''),
    deleteProgram: vi.fn(),
    createBuffer: vi.fn(() => ({})),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    getAttribLocation: vi.fn(() => 0),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    createTexture: vi.fn(() => ({})),
    bindTexture: vi.fn(),
    pixelStorei: vi.fn(),
    texParameteri: vi.fn(),
    texImage2D: vi.fn(),
    getUniformLocation: vi.fn((program, name) => name),
    viewport: vi.fn(),
    useProgram: vi.fn(),
    activeTexture: vi.fn(),
    uniform1i: vi.fn(),
    uniform1f: vi.fn(),
    uniform2f: vi.fn(),
    uniform3fv: vi.fn(),
    uniform4f: vi.fn(),
    uniform4fv: vi.fn(),
    clearColor: vi.fn(),
    clear: vi.fn(),
    drawArrays: vi.fn(),
    deleteTexture: vi.fn(),
    deleteBuffer: vi.fn(),
  }
}

function Harness({ rendererFactory = () => makeRenderer(), imageUrl = '', panelMarker = false }) {
  const workAreaRef = useRef(null)
  return (
    <div className="xleth-app-workarea" data-testid="workarea" ref={workAreaRef}>
      <BackdropLayer
        workAreaRef={workAreaRef}
        backdropImageUrl={imageUrl}
        rendererFactory={rendererFactory}
      />
      <div className="xleth-docked-window-layer" data-testid="docked-layer">
        <button type="button" data-testid="child-ui">Child UI</button>
      </div>
      <div className="xleth-floating-work-area" data-testid="empty-surface" data-backdrop-empty-surface="true" />
      <div className="xleth-floating-window-layer" data-testid="floating-layer">
        {panelMarker ? <section data-testid="panel-marker" data-backdrop-fx-panel-rect="true" /> : null}
      </div>
    </div>
  )
}

describe('BackdropLayer', () => {
  beforeEach(() => {
    globalThis.React = React
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    installMatchMedia(false)
    useBackdropFxSettingsStore.getState().resetForTests()
    useBackdropMediaSettingsStore.getState().resetForTests()
    usePanelRegistry.setState({
      panels: createInitialPanelStates(),
      dockRegionSizes: createInitialDockRegionSizes(),
    })
  })

  afterEach(() => {
    cancelDrag()
    delete globalThis.React
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
    vi.restoreAllMocks()
  })

  it('does not create a canvas when Backdrop FX is disabled by default', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(<Harness />)
      })

      expect(container.querySelector('[data-testid="xleth-backdrop-fx-canvas"]')).toBeNull()
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('renders image backdrop media while preserving the plain image behavior', async () => {
    useBackdropMediaSettingsStore.setState({
      settings: {
        sourceType: 'image',
        imagePath: 'C:\\XLETH\\art\\space backdrop.webp',
        videoPath: '',
        lastError: '',
      },
      hydrated: true,
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(<Harness />)
      })

      const image = container.querySelector('[data-testid="xleth-backdrop-image-media"]')
      expect(image).not.toBeNull()
      expect(image.getAttribute('style')).toContain('xleth-media://c/XLETH/art/space%20backdrop.webp')
      expect(container.querySelector('[data-testid="xleth-backdrop-video-media"]')).toBeNull()
      expect(container.querySelector('[data-testid="xleth-backdrop-fx-canvas"]')).toBeNull()
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('renders a muted looping video backdrop without mounting FX when FX is disabled', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    useBackdropMediaSettingsStore.setState({
      settings: {
        sourceType: 'video',
        imagePath: '',
        videoPath: 'C:\\Loops\\soft #1.mp4',
        lastError: '',
      },
      hydrated: true,
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(<Harness />)
      })

      const video = container.querySelector('[data-testid="xleth-backdrop-video-media"]')
      expect(video).not.toBeNull()
      expect(video.muted).toBe(true)
      expect(video.loop).toBe(true)
      expect(video.playsInline).toBe(true)
      expect(video.controls).toBe(false)
      expect(video.src).toContain('xleth-media://c/Loops/soft%20%231.mp4')
      expect(container.querySelector('[data-testid="xleth-backdrop-fx-canvas"]')).toBeNull()
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('passes the video element to the FX renderer for Subtle Glass video sources', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const renderer = makeRenderer()
    useBackdropFxSettingsStore.setState({
      settings: {
        ...DEFAULT_BACKDROP_FX_SETTINGS,
        enabled: true,
        preset: 'subtle-glass',
      },
      hydrated: true,
    })
    useBackdropMediaSettingsStore.setState({
      settings: {
        sourceType: 'video',
        imagePath: '',
        videoPath: 'C:\\Loops\\glass.mp4',
        lastError: '',
      },
      hydrated: true,
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(<Harness rendererFactory={() => renderer} />)
      })

      expect(container.querySelector('[data-testid="xleth-backdrop-fx-canvas"]')).not.toBeNull()
      expect(renderer.update).toHaveBeenCalledWith(expect.objectContaining({
        videoElement: container.querySelector('[data-testid="xleth-backdrop-video-media"]'),
      }))
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('keeps Static Enhanced video cheap by skipping the FX canvas', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const renderer = makeRenderer()
    useBackdropFxSettingsStore.setState({
      settings: {
        ...DEFAULT_BACKDROP_FX_SETTINGS,
        enabled: true,
        preset: 'static-enhanced',
      },
      hydrated: true,
    })
    useBackdropMediaSettingsStore.setState({
      settings: {
        sourceType: 'video',
        imagePath: '',
        videoPath: 'C:\\Loops\\static.mp4',
        lastError: '',
      },
      hydrated: true,
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(<Harness rendererFactory={() => renderer} />)
      })

      expect(container.querySelector('[data-testid="xleth-backdrop-video-media"]')).not.toBeNull()
      expect(container.querySelector('[data-testid="xleth-backdrop-fx-canvas"]')).toBeNull()
      expect(renderer.update).not.toHaveBeenCalled()
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('pauses, resumes, reports errors, and cleans up video lifecycle listeners', () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    const video = document.createElement('video')
    const play = vi.spyOn(video, 'play').mockResolvedValue(undefined)
    const pause = vi.spyOn(video, 'pause').mockImplementation(() => {})
    const onError = vi.fn()

    const cleanup = installBackdropVideoLifecycle(video, { onError })
    expect(play).toHaveBeenCalledTimes(1)

    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(pause).toHaveBeenCalled()

    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(play).toHaveBeenCalledTimes(2)

    video.dispatchEvent(new Event('error'))
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('Video backdrop could not be played'))

    cleanup()
    const pauseCalls = pause.mock.calls.length
    document.dispatchEvent(new Event('visibilitychange'))
    expect(pause.mock.calls.length).toBe(pauseCalls)
  })

  it('mounts the FX underlay before panel layers and keeps pointer events disabled', async () => {
    const renderer = makeRenderer()
    useBackdropFxSettingsStore.setState({
      settings: { ...DEFAULT_BACKDROP_FX_SETTINGS, enabled: true },
      hydrated: true,
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(<Harness rendererFactory={() => renderer} />)
      })

      const workArea = container.querySelector('[data-testid="workarea"]')
      expect(workArea.firstElementChild?.getAttribute('data-testid')).toBe('xleth-backdrop-layer')
      expect(container.querySelector('[data-testid="xleth-backdrop-fx-canvas"]')).not.toBeNull()
      expect(renderer.update).toHaveBeenCalled()

      const css = readFileSync(path.resolve(process.cwd(), 'src/windowing/components/windowing.css'), 'utf8')
      expect(css).toMatch(/\.xleth-backdrop-layer\s*\{[\s\S]*z-index:\s*var\(--xleth-z-backdrop-underlay\)/)
      expect(css).toMatch(/\.xleth-backdrop-fx-canvas\s*\{[\s\S]*pointer-events:\s*none/)
      expect(css).toMatch(/\.xleth-docked-window-layer,[\s\S]*\.xleth-floating-window-layer,[\s\S]*z-index:\s*var\(--xleth-z-workspace-panel-layer\)/)
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('creates ripples only for empty backdrop clicks', async () => {
    const renderer = makeRenderer()
    useBackdropFxSettingsStore.setState({
      settings: {
        ...DEFAULT_BACKDROP_FX_SETTINGS,
        enabled: true,
        preset: 'subtle-glass',
      },
      hydrated: true,
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(<Harness rendererFactory={() => renderer} />)
      })

      container.querySelector('[data-testid="child-ui"]').dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        clientX: 20,
        clientY: 24,
      }))
      expect(renderer.addRipple).not.toHaveBeenCalled()

      container.querySelector('[data-testid="empty-surface"]').dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        clientX: 30,
        clientY: 40,
      }))
      expect(renderer.addRipple).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('routes cursor, click, and panel rect inputs for Subtle Glass with Studio Grid overlay enabled', async () => {
    const renderer = makeRenderer()
    useBackdropFxSettingsStore.setState({
      settings: {
        ...DEFAULT_BACKDROP_FX_SETTINGS,
        enabled: true,
        preset: 'subtle-glass',
        studioGridOverlay: true,
      },
      hydrated: true,
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const workAreaRect = { left: 10, top: 20, width: 400, height: 300, right: 410, bottom: 320 }
    const panelRect = { left: 30, top: 50, width: 100, height: 80, right: 130, bottom: 130 }

    try {
      await act(async () => {
        root.render(<Harness rendererFactory={() => renderer} panelMarker />)
      })

      const workArea = container.querySelector('[data-testid="workarea"]')
      const panel = container.querySelector('[data-testid="panel-marker"]')
      workArea.getBoundingClientRect = () => workAreaRect
      panel.getBoundingClientRect = () => panelRect

      await act(async () => {
        window.dispatchEvent(new Event('resize'))
      })

      container.querySelector('[data-testid="empty-surface"]').dispatchEvent(new MouseEvent('pointermove', {
        bubbles: true,
        clientX: 20,
        clientY: 24,
      }))
      container.querySelector('[data-testid="empty-surface"]').dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        clientX: 30,
        clientY: 40,
      }))

      expect(renderer.setPanelRects).toHaveBeenLastCalledWith([
        { x: 20, y: 30, width: 100, height: 80 },
      ])
      expect(renderer.setCursor).toHaveBeenCalledTimes(1)
      expect(renderer.addRipple).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('collects panel rects from explicit panel markers in shader coordinates', () => {
    const workArea = document.createElement('div')
    const panel = document.createElement('section')
    panel.setAttribute('data-backdrop-fx-panel-rect', 'true')
    workArea.appendChild(panel)
    workArea.getBoundingClientRect = () => ({ left: 10, top: 20, width: 400, height: 300, right: 410, bottom: 320 })
    panel.getBoundingClientRect = () => ({ left: 30, top: 50, width: 100, height: 80, right: 130, bottom: 130 })

    expect(collectBackdropFxPanelRects(workArea)).toEqual([
      { x: 20, y: 30, width: 100, height: 80 },
    ])
  })

  it('maps DOM coordinates to the shader screen coordinate space', () => {
    const workAreaRect = { left: 10, top: 20, width: 400, height: 300, right: 410, bottom: 320 }

    expect(clientPointToShaderPoint(10, 20, workAreaRect)).toEqual({ x: 0, y: 0 })
    expect(clientPointToShaderPoint(10, 320, workAreaRect)).toEqual({ x: 0, y: 300 })
    expect(clientPointToShaderPoint(210, 170, workAreaRect)).toEqual({ x: 200, y: 150 })
    expect(clientPointToShaderPoint(210, 170, workAreaRect, { width: 200, height: 150 })).toEqual({ x: 200, y: 150 })
  })

  it('maps DOM rects without inverting their top and bottom edges', () => {
    const workAreaRect = { left: 10, top: 20, width: 400, height: 300, right: 410, bottom: 320 }
    const rect = { left: 30, top: 50, width: 100, height: 80, right: 130, bottom: 130 }

    expect(clientRectToShaderRect(rect, workAreaRect)).toEqual({
      x: 20,
      y: 30,
      width: 100,
      height: 80,
    })
  })

  it('updates panel rect uniforms during live floating drag changes', async () => {
    const renderer = makeRenderer()
    const frameCallbacks = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frameCallbacks.push(callback)
      return frameCallbacks.length
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    useBackdropFxSettingsStore.setState({
      settings: {
        ...DEFAULT_BACKDROP_FX_SETTINGS,
        enabled: true,
        preset: 'subtle-glass',
      },
      hydrated: true,
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const workAreaRect = { left: 10, top: 20, width: 400, height: 300, right: 410, bottom: 320 }
    let panelRect = { left: 30, top: 50, width: 100, height: 80, right: 130, bottom: 130 }

    try {
      await act(async () => {
        root.render(<Harness rendererFactory={() => renderer} panelMarker />)
      })

      const workArea = container.querySelector('[data-testid="workarea"]')
      const panel = container.querySelector('[data-testid="panel-marker"]')
      workArea.getBoundingClientRect = () => workAreaRect
      panel.getBoundingClientRect = () => panelRect
      registerWorkAreaRect(workAreaRect)

      await act(async () => {
        beginDrag('timeline', 40, 60, 20, 30)
        panelRect = { left: 70, top: 110, width: 100, height: 80, right: 170, bottom: 190 }
        updateDrag(80, 120)
      })

      expect(frameCallbacks.length).toBeGreaterThan(0)
      await act(async () => {
        frameCallbacks.shift()?.(16)
      })

      expect(renderer.setPanelRects).toHaveBeenLastCalledWith([
        { x: 60, y: 90, width: 100, height: 80 },
      ])
    } finally {
      cancelDrag()
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('does not route Static Enhanced pointer movement into reactive renderer inputs', async () => {
    const renderer = makeRenderer()
    useBackdropFxSettingsStore.setState({
      settings: {
        ...DEFAULT_BACKDROP_FX_SETTINGS,
        enabled: true,
        preset: 'static-enhanced',
      },
      hydrated: true,
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(<Harness rendererFactory={() => renderer} />)
      })

      container.querySelector('[data-testid="empty-surface"]').dispatchEvent(new MouseEvent('pointermove', {
        bubbles: true,
        clientX: 20,
        clientY: 24,
      }))
      container.querySelector('[data-testid="empty-surface"]').dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        clientX: 30,
        clientY: 40,
      }))
      expect(renderer.setCursor).not.toHaveBeenCalled()
      expect(renderer.addRipple).not.toHaveBeenCalled()
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('uses stable primitive layout keys for cloned panel maps', () => {
    const panels = createInitialPanelStates()
    const cloned = clonePanelStates(panels)
    const sizes = createInitialDockRegionSizes()

    expect(createBackdropFxPanelLayoutKey(panels, sizes, 320))
      .toBe(createBackdropFxPanelLayoutKey(cloned, { ...sizes }, 320))

    const source = readFileSync(path.resolve(process.cwd(), 'src/backdrop/BackdropLayer.jsx'), 'utf8')
    expect(source).not.toMatch(/usePanelRegistry\(\s*\(state\)\s*=>\s*state\.panels\s*\)/)
  })

  it('identifies empty backdrop click targets without accepting child UI', () => {
    const workArea = document.createElement('div')
    const empty = document.createElement('div')
    const child = document.createElement('button')
    empty.setAttribute('data-backdrop-empty-surface', 'true')
    workArea.appendChild(empty)
    empty.appendChild(child)

    expect(isEmptyBackdropClickTarget(workArea, workArea)).toBe(true)
    expect(isEmptyBackdropClickTarget(empty, workArea)).toBe(true)
    expect(isEmptyBackdropClickTarget(child, workArea)).toBe(false)
  })

  it('does not paint the solid preview placeholder over image or video backdrops', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'src/styles/app.css'), 'utf8')

    expect(source).toMatch(/\.xleth-backdrop-off \.xleth-floating-work-area::before/)
    expect(source).toMatch(/\.xleth-backdrop-off \.xleth-floating-work-area::after/)
    expect(source).not.toMatch(/(?:^|\n)\.xleth-floating-work-area::(?:before|after)\s*\{/)
  })
})

describe('BackdropFxRenderer fallback', () => {
  it('passes the Studio Grid overlay flag to the shader only for Subtle Glass', () => {
    const canvas = document.createElement('canvas')
    const gl = makeFakeWebGl2()
    canvas.getContext = vi.fn().mockReturnValue(gl)
    canvas.getBoundingClientRect = () => ({ width: 320, height: 180 })
    const renderer = createBackdropFxRenderer(canvas, {
      getDevicePixelRatio: () => 1,
      now: () => 1000,
    })

    renderer.update({
      settings: {
        ...DEFAULT_BACKDROP_FX_SETTINGS,
        enabled: true,
        preset: 'subtle-glass',
        studioGridOverlay: true,
      },
      imageUrl: '',
    })

    renderer.update({
      settings: {
        ...DEFAULT_BACKDROP_FX_SETTINGS,
        enabled: true,
        preset: 'static-enhanced',
        studioGridOverlay: true,
      },
      imageUrl: '',
    })

    expect(gl.uniform1i.mock.calls
      .filter(([location]) => location === 'uStudioGridOverlay')
      .map(([, value]) => value)).toEqual([1, 0])
    renderer.dispose()
  })

  it('does not throw when WebGL2 is unavailable', () => {
    const canvas = document.createElement('canvas')
    canvas.getContext = vi.fn().mockReturnValue(null)
    const renderer = createBackdropFxRenderer(canvas)

    expect(() => renderer.update({
      settings: { ...DEFAULT_BACKDROP_FX_SETTINGS, enabled: true },
      imageUrl: '',
    })).not.toThrow()
    expect(canvas.style.display).toBe('none')

    renderer.dispose()
  })

  it('hides the FX canvas without throwing when video texture upload fails', () => {
    const canvas = document.createElement('canvas')
    const gl = makeFakeWebGl2()
    gl.texImage2D
      .mockImplementationOnce(() => {})
      .mockImplementation(() => { throw new Error('video upload failed') })
    canvas.getContext = vi.fn().mockReturnValue(gl)
    canvas.getBoundingClientRect = () => ({ width: 320, height: 180 })
    const video = document.createElement('video')
    Object.defineProperty(video, 'readyState', { configurable: true, value: 2 })
    const renderer = createBackdropFxRenderer(canvas, {
      getDevicePixelRatio: () => 1,
      now: () => 1000,
      requestFrame: () => 1,
      cancelFrame: () => {},
    })

    expect(() => renderer.update({
      settings: {
        ...DEFAULT_BACKDROP_FX_SETTINGS,
        enabled: true,
        preset: 'subtle-glass',
      },
      videoElement: video,
    })).not.toThrow()
    expect(renderer.failed).toBe(true)
    expect(canvas.style.display).toBe('none')

    renderer.dispose()
  })
})
