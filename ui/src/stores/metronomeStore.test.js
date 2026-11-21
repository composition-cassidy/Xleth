import { beforeEach, describe, expect, it, vi } from 'vitest'
import useMetronomeStore from './metronomeStore.js'

describe('metronomeStore', () => {
  let setMetronome
  let saved

  beforeEach(() => {
    setMetronome = vi.fn(() => Promise.resolve({}))
    saved = undefined
    globalThis.window = globalThis.window ?? {}
    window.xleth = {
      audio: { setMetronome },
      settings: {
        get: vi.fn(() => Promise.resolve(saved)),
        set: vi.fn(() => Promise.resolve()),
      },
    }
    useMetronomeStore.setState({ enabled: false, volume: 0.8, sound: 0 })
  })

  it('is off by default', () => {
    expect(useMetronomeStore.getState().enabled).toBe(false)
  })

  it('toggle mirrors the new state to the engine', () => {
    useMetronomeStore.getState().toggle()
    expect(useMetronomeStore.getState().enabled).toBe(true)
    expect(setMetronome).toHaveBeenLastCalledWith({ enabled: true })
    useMetronomeStore.getState().toggle()
    expect(setMetronome).toHaveBeenLastCalledWith({ enabled: false })
  })

  it('clamps volume and sound before they reach the engine', () => {
    useMetronomeStore.getState().setVolume(7)
    expect(setMetronome).toHaveBeenLastCalledWith({ volume: 1 })
    useMetronomeStore.getState().setSound(9)
    expect(setMetronome).toHaveBeenLastCalledWith({ sound: 2 })
    useMetronomeStore.getState().setSound(-4)
    expect(setMetronome).toHaveBeenLastCalledWith({ sound: 0 })
  })

  it('hydrate applies the saved preference and pushes it to the engine', async () => {
    saved = { enabled: true, volume: 0.5, sound: 2 }
    await useMetronomeStore.getState().hydrate()
    expect(useMetronomeStore.getState()).toMatchObject({ enabled: true, volume: 0.5, sound: 2 })
    expect(setMetronome).toHaveBeenLastCalledWith({ enabled: true, volume: 0.5, sound: 2 })
  })

  it('hydrate ignores malformed saved values', async () => {
    saved = { enabled: 'yes', volume: 'loud', sound: 99 }
    await useMetronomeStore.getState().hydrate()
    expect(useMetronomeStore.getState()).toMatchObject({ enabled: false, volume: 0.8, sound: 2 })
  })
})
