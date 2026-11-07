import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  UI_SCALE_DEFAULT,
  clampUiScalePercent,
  useUiScaleStore,
} from '../uiScaleStore.js'

describe('uiScaleStore', () => {
  let zoomChanged
  let setZoom

  beforeEach(() => {
    zoomChanged = null
    setZoom = vi.fn()
    globalThis.window = globalThis.window || {}
    window.xleth = {
      window: {
        setZoom,
        getZoom: vi.fn(async () => 1.5),
        onZoomChanged: vi.fn((cb) => { zoomChanged = cb; return () => { zoomChanged = null } }),
      },
    }
    useUiScaleStore.setState({ percent: UI_SCALE_DEFAULT, hydrated: false })
  })

  afterEach(() => { delete window.xleth })

  it('clamps and snaps to 100-200 in 10s', () => {
    expect(clampUiScalePercent(0)).toBe(100)
    expect(clampUiScalePercent(999)).toBe(200)
    expect(clampUiScalePercent(144)).toBe(140)
    expect(clampUiScalePercent('x')).toBe(100)
  })

  it('opens at the live zoom factor', async () => {
    useUiScaleStore.getState().hydrate()
    await Promise.resolve(); await Promise.resolve()
    expect(useUiScaleStore.getState().percent).toBe(150)
    expect(useUiScaleStore.getState().hydrated).toBe(true)
  })

  it('follows changes made anywhere (menu, shortcut, Settings) through the one notification', () => {
    useUiScaleStore.getState().hydrate()
    zoomChanged(1.3)
    expect(useUiScaleStore.getState().percent).toBe(130)
    zoomChanged(1)
    expect(useUiScaleStore.getState().percent).toBe(100)
  })

  it('setPercent asks main for an absolute factor and reset goes back to 100 %', () => {
    useUiScaleStore.getState().setPercent(170)
    expect(setZoom).toHaveBeenLastCalledWith(1.7)
    useUiScaleStore.getState().reset()
    expect(setZoom).toHaveBeenLastCalledWith(1)
  })

  it('is harmless without the bridge', () => {
    delete window.xleth
    expect(() => useUiScaleStore.getState().hydrate()).not.toThrow()
    expect(() => useUiScaleStore.getState().setPercent(120)).not.toThrow()
  })
})
