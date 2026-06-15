import React, { useEffect, useRef, useState } from 'react'
import {
  clientRectToShaderRect,
  createBackdropFxRenderer,
  readBackdropFxThemeUniforms,
} from './backdropFxRenderer.js'
import {
  isBackdropFxReactivePreset,
  resolveBackdropFxRuntime,
  useBackdropFxSettingsStore,
} from './backdropFxSettings.js'
import {
  VIDEO_BACKDROP_ERROR_MESSAGE,
  localMediaPathToXlethMediaUrl,
  useBackdropMediaSettingsStore,
} from './backdropMediaSettings.js'
import { usePanelRegistry } from '../windowing/registry/PanelRegistry'
import { PANEL_IDS } from '../windowing/registry/panelCatalog'
import { getDragState, subscribeDrag } from '../windowing/managers/DragManager'
import { isResizing, subscribeResize } from '../windowing/managers/ResizeManager'
import { isDockRegionResizing, subscribeDockRegionResize } from '../windowing/managers/DockRegionResizeManager'
import { isDockedPanelResizing, subscribeDockedPanelResize } from '../windowing/managers/DockedPanelResizeManager'

export function createBackdropFxPanelLayoutKey(panels, dockRegionSizes, sampleSelectorDockWidth) {
  const panelKey = PANEL_IDS
    .map((id) => {
      const panel = panels[id]
      if (!panel || panel.hidden) return `${id}:hidden`
      if (panel.mode === 'floating' || panel.mode === 'maximized') {
        const f = panel.floating
        return `${id}:${panel.mode}:${Math.round(f.x)}:${Math.round(f.y)}:${Math.round(f.width)}:${Math.round(f.height)}`
      }
      const d = panel.docked
      return `${id}:docked:${d.region}:${d.orderInRegion}:${Math.round(d.sizeInRegion)}`
    })
    .join('|')
  const sizes = dockRegionSizes || {}
  return [
    panelKey,
    Math.round(sizes.left || 0),
    Math.round(sizes.right || 0),
    Math.round(sizes.top || 0),
    Math.round(sizes.bottom || 0),
    Math.round(sampleSelectorDockWidth || 0),
  ].join('|')
}

export function collectBackdropFxPanelRects(workArea) {
  if (!workArea?.getBoundingClientRect) return []
  const workAreaRect = workArea.getBoundingClientRect()
  return Array.from(workArea.querySelectorAll('[data-backdrop-fx-panel-rect="true"]'))
    .map((element) => {
      const rect = element.getBoundingClientRect()
      return clientRectToShaderRect(rect, workAreaRect)
    })
    .filter((rect) => rect.width > 0 && rect.height > 0)
}

export function isBackdropFxLiveWindowingChange() {
  return getDragState().state === 'dragging'
    || isResizing()
    || isDockRegionResizing()
    || isDockedPanelResizing()
}

export function isEmptyBackdropClickTarget(target, workArea) {
  if (!target || !workArea) return false
  if (target === workArea) return true
  return target.nodeType === 1 && target.getAttribute?.('data-backdrop-empty-surface') === 'true'
}

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setPrefersReducedMotion(Boolean(query.matches))
    update()
    query.addEventListener?.('change', update)
    query.addListener?.(update)
    return () => {
      query.removeEventListener?.('change', update)
      query.removeListener?.(update)
    }
  }, [])
  return prefersReducedMotion
}

export function installBackdropVideoLifecycle(video, {
  onError = () => {},
  documentRef = typeof document !== 'undefined' ? document : null,
} = {}) {
  if (!video || !documentRef) return () => {}
  let failed = false

  const pauseVideo = () => {
    try { video.pause?.() } catch {}
  }
  const playVideo = () => {
    if (failed || documentRef.hidden) return
    try {
      const result = video.play?.()
      result?.catch?.(() => {
        failed = true
        onError(VIDEO_BACKDROP_ERROR_MESSAGE)
      })
    } catch {
      failed = true
      onError(VIDEO_BACKDROP_ERROR_MESSAGE)
    }
  }
  const handleVisibilityChange = () => {
    if (documentRef.hidden) pauseVideo()
    else playVideo()
  }
  const handleError = () => {
    failed = true
    pauseVideo()
    onError(VIDEO_BACKDROP_ERROR_MESSAGE)
  }

  video.addEventListener?.('error', handleError)
  documentRef.addEventListener?.('visibilitychange', handleVisibilityChange)
  playVideo()

  return () => {
    documentRef.removeEventListener?.('visibilitychange', handleVisibilityChange)
    video.removeEventListener?.('error', handleError)
    pauseVideo()
    try {
      video.removeAttribute?.('src')
    } catch {}
  }
}

export default function BackdropLayer({
  workAreaRef,
  backdropImageUrl = '',
  rendererFactory = createBackdropFxRenderer,
}) {
  const layerRef = useRef(null)
  const canvasRef = useRef(null)
  const videoRef = useRef(null)
  const rendererRef = useRef(null)
  const settings = useBackdropFxSettingsStore((state) => state.settings)
  const hydrate = useBackdropFxSettingsStore((state) => state.hydrate)
  const mediaSettings = useBackdropMediaSettingsStore((state) => state.settings)
  const hydrateMediaSettings = useBackdropMediaSettingsStore((state) => state.hydrate)
  const syncMediaFromBackdropState = useBackdropMediaSettingsStore((state) => state.syncFromBackdropState)
  const setVideoError = useBackdropMediaSettingsStore((state) => state.setVideoError)
  const prefersReducedMotion = usePrefersReducedMotion()
  const layoutKey = usePanelRegistry((state) => createBackdropFxPanelLayoutKey(
    state.panels,
    state.dockRegionSizes,
    state.sampleSelectorDockWidth,
  ))
  const runtime = resolveBackdropFxRuntime(settings, prefersReducedMotion)
  const reactivePreset = isBackdropFxReactivePreset(settings.preset)
  const mediaSourceType = mediaSettings.sourceType
  const imageUrl = mediaSettings.imagePath
    ? localMediaPathToXlethMediaUrl(mediaSettings.imagePath)
    : backdropImageUrl
  const videoUrl = mediaSettings.videoPath
    ? localMediaPathToXlethMediaUrl(mediaSettings.videoPath)
    : ''
  const hasImageMedia = mediaSourceType === 'image' && Boolean(imageUrl)
  const hasVideoMedia = mediaSourceType === 'video' && Boolean(videoUrl)
  const [videoFailed, setVideoFailed] = useState(false)
  const renderStaticVideoOverlay = runtime.enabled && hasVideoMedia && settings.preset === 'static-enhanced'
  const renderFxCanvas = runtime.enabled && !renderStaticVideoOverlay
  const renderLayer = renderFxCanvas || hasImageMedia || hasVideoMedia || (hasVideoMedia && imageUrl)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  useEffect(() => {
    void hydrateMediaSettings()
  }, [hydrateMediaSettings])

  useEffect(() => {
    const applyState = (state) => {
      if (state) syncMediaFromBackdropState(state)
    }
    applyState(typeof window !== 'undefined' ? window.xleth?.backdrop?.current : null)
    return typeof window !== 'undefined'
      ? window.xleth?.backdrop?.onModeChanged?.(applyState)
      : undefined
  }, [syncMediaFromBackdropState])

  useEffect(() => {
    setVideoFailed(false)
  }, [videoUrl])

  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    if (hasVideoMedia) {
      document.documentElement.setAttribute('data-xleth-backdrop', 'video')
    } else if (hasImageMedia) {
      document.documentElement.setAttribute('data-xleth-backdrop', 'image')
    }
    return undefined
  }, [hasImageMedia, hasVideoMedia])

  useEffect(() => {
    if (renderFxCanvas) return undefined
    rendererRef.current?.dispose()
    rendererRef.current = null
    return undefined
  }, [renderFxCanvas])

  useEffect(() => {
    if (!renderFxCanvas || !canvasRef.current) return undefined
    if (rendererRef.current?.failed) {
      rendererRef.current.dispose()
      rendererRef.current = null
    }
    if (!rendererRef.current) {
      rendererRef.current = rendererFactory(canvasRef.current)
    }
    rendererRef.current.update({
      settings,
      imageUrl: hasImageMedia ? imageUrl : '',
      videoElement: hasVideoMedia ? videoRef.current : null,
      theme: readBackdropFxThemeUniforms(),
    })
    return undefined
  }, [hasImageMedia, hasVideoMedia, imageUrl, renderFxCanvas, rendererFactory, settings, videoUrl])

  useEffect(() => {
    if (!hasVideoMedia || !videoRef.current) return undefined
    return installBackdropVideoLifecycle(videoRef.current, {
      onError: (message) => {
        setVideoFailed(true)
        void setVideoError(message)
      },
    })
  }, [hasVideoMedia, setVideoError, videoUrl])

  useEffect(() => {
    if (!renderFxCanvas) return undefined
    const onThemeChanged = () => {
      rendererRef.current?.setTheme(readBackdropFxThemeUniforms())
    }
    document.addEventListener('xleth-theme-changed', onThemeChanged)
    return () => document.removeEventListener('xleth-theme-changed', onThemeChanged)
  }, [renderFxCanvas])

  useEffect(() => {
    if (!renderFxCanvas || !reactivePreset || !settings.reactToWindows) return undefined
    const workArea = workAreaRef?.current
    if (!workArea) return undefined
    const syncRects = () => {
      rendererRef.current?.setPanelRects(collectBackdropFxPanelRects(workArea))
    }
    syncRects()
    return undefined
  }, [layoutKey, reactivePreset, renderFxCanvas, settings.reactToWindows, workAreaRef])

  useEffect(() => {
    if (!renderFxCanvas) return undefined
    const workArea = workAreaRef?.current
    if (!workArea) return undefined
    const syncSizeAndRects = () => {
      rendererRef.current?.resize()
      if (reactivePreset && settings.reactToWindows) {
        rendererRef.current?.setPanelRects(collectBackdropFxPanelRects(workArea))
      }
      rendererRef.current?.renderOnce()
    }
    const ResizeObserverCtor = typeof ResizeObserver === 'undefined' ? null : ResizeObserver
    const observer = ResizeObserverCtor ? new ResizeObserverCtor(syncSizeAndRects) : null
    observer?.observe(workArea)
    window.addEventListener('resize', syncSizeAndRects)
    syncSizeAndRects()
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', syncSizeAndRects)
    }
  }, [reactivePreset, renderFxCanvas, settings.reactToWindows, workAreaRef])

  useEffect(() => {
    if (!renderFxCanvas || !reactivePreset) return undefined
    const workArea = workAreaRef?.current
    if (!workArea) return undefined
    let frameId = null
    const requestFrame = typeof window !== 'undefined' && window.requestAnimationFrame
      ? window.requestAnimationFrame.bind(window)
      : (callback) => setTimeout(callback, 16)
    const cancelFrame = typeof window !== 'undefined' && window.cancelAnimationFrame
      ? window.cancelAnimationFrame.bind(window)
      : clearTimeout

    const syncLiveRects = () => {
      frameId = null
      rendererRef.current?.setPanelRects(collectBackdropFxPanelRects(workArea))
    }
    const scheduleLiveRectSync = () => {
      if (!isBackdropFxLiveWindowingChange() || frameId !== null) return
      frameId = requestFrame(syncLiveRects)
    }

    const unsubscribers = [
      subscribeDrag(scheduleLiveRectSync),
      subscribeResize(scheduleLiveRectSync),
      subscribeDockRegionResize(scheduleLiveRectSync),
      subscribeDockedPanelResize(scheduleLiveRectSync),
    ]

    return () => {
      if (frameId !== null) cancelFrame(frameId)
      unsubscribers.forEach((unsubscribe) => unsubscribe())
    }
  }, [reactivePreset, renderFxCanvas, workAreaRef])

  useEffect(() => {
    if (
      !renderFxCanvas
      || !reactivePreset
      || (!settings.reactToCursor && !settings.reactToClicks)
    ) return undefined
    const workArea = workAreaRef?.current
    if (!workArea) return undefined

    const onPointerMove = (event) => {
      if (!settings.reactToCursor) return
      rendererRef.current?.setCursor(event.clientX, event.clientY, workArea.getBoundingClientRect())
    }
    const onPointerLeave = () => {
      if (!settings.reactToCursor) return
      rendererRef.current?.clearCursor()
    }
    const onClick = (event) => {
      if (!settings.reactToClicks) return
      if (!isEmptyBackdropClickTarget(event.target, workArea)) return
      rendererRef.current?.addRipple(event.clientX, event.clientY, workArea.getBoundingClientRect())
    }

    workArea.addEventListener('pointermove', onPointerMove)
    workArea.addEventListener('pointerleave', onPointerLeave)
    workArea.addEventListener('click', onClick)
    return () => {
      workArea.removeEventListener('pointermove', onPointerMove)
      workArea.removeEventListener('pointerleave', onPointerLeave)
      workArea.removeEventListener('click', onClick)
    }
  }, [reactivePreset, renderFxCanvas, settings.reactToClicks, settings.reactToCursor, workAreaRef])

  useEffect(() => () => {
    rendererRef.current?.dispose()
    rendererRef.current = null
  }, [])

  if (!renderLayer) return null

  return (
    <div
      ref={layerRef}
      className={[
        'xleth-backdrop-layer',
        renderStaticVideoOverlay ? 'xleth-backdrop-layer--static-video-fx' : '',
      ].filter(Boolean).join(' ')}
      data-testid="xleth-backdrop-layer"
      aria-hidden="true"
    >
      {hasImageMedia || (hasVideoMedia && videoFailed && imageUrl) ? (
        <div
          className="xleth-backdrop-media xleth-backdrop-media--image"
          data-testid="xleth-backdrop-image-media"
          style={{ backgroundImage: `url("${imageUrl.replace(/"/g, '\\"')}")` }}
        />
      ) : null}
      {hasVideoMedia && !videoFailed ? (
        <video
          ref={videoRef}
          className="xleth-backdrop-media xleth-backdrop-media-element xleth-backdrop-media--video"
          data-testid="xleth-backdrop-video-media"
          src={videoUrl}
          muted
          loop
          playsInline
          autoPlay
          preload="auto"
          aria-hidden="true"
        />
      ) : null}
      {renderFxCanvas ? (
        <canvas
          ref={canvasRef}
          className="xleth-backdrop-fx-canvas"
          data-testid="xleth-backdrop-fx-canvas"
        />
      ) : null}
    </div>
  )
}
