import { beforeEach, describe, expect, it } from 'vitest'

import useFxChainDragStore from '../fxChainDragStore.js'

const effects = [{ pluginId: 'reverb' }, { pluginId: 'compressor' }]
const get = () => useFxChainDragStore.getState()

beforeEach(() => {
  get().end()
  get().clearClipboard()
  get().closeMenu()
})

describe('menu state', () => {
  it('holds one open menu at a time', () => {
    get().openMenu('3', 100, 200)
    expect(get().menu).toEqual({ fxKey: '3', x: 100, y: 200 })
    get().openMenu('master', 10, 20)
    expect(get().menu).toEqual({ fxKey: 'master', x: 10, y: 20 })
  })

  it('coerces the key to a string so numeric trackIds match strip keys', () => {
    get().openMenu(7, 0, 0)
    expect(get().menu.fxKey).toBe('7')
  })

  it('closes', () => {
    get().openMenu('3', 1, 1)
    get().closeMenu()
    expect(get().menu).toBeNull()
  })
})

describe('sticky drag', () => {
  it('is idle until a drag begins', () => {
    expect(get().effects).toBeNull()
  })

  it('carries the chain and its source', () => {
    get().begin('1', 'Track 1', effects, 50, 60)
    expect(get().effects).toEqual(effects)
    expect(get().sourceKey).toBe('1')
    expect(get().sourceLabel).toBe('Track 1')
    expect(get().x).toBe(50)
    expect(get().y).toBe(60)
  })

  it('closes the menu it was started from', () => {
    get().openMenu('1', 0, 0)
    get().begin('1', 'Track 1', effects, 0, 0)
    expect(get().menu).toBeNull()
  })

  it('tracks the pointer and the strip under it', () => {
    get().begin('1', 'Track 1', effects, 0, 0)
    get().move(120, 130, '2')
    expect(get().x).toBe(120)
    expect(get().hoverKey).toBe('2')
    get().move(121, 131, null)
    expect(get().hoverKey).toBeNull()
  })

  it('STAYS ACTIVE after a drop — Track 2 AND Track 3 is one gesture', () => {
    get().begin('1', 'Track 1', effects, 0, 0)

    expect(get().countDrop('2')).toBe(true)
    expect(get().effects).toEqual(effects)
    expect(get().drops).toBe(1)

    expect(get().countDrop('3')).toBe(true)
    expect(get().effects).toEqual(effects)
    expect(get().drops).toBe(2)
  })

  it('refuses a drop on the strip the chain came from', () => {
    get().begin('1', 'Track 1', effects, 0, 0)
    expect(get().countDrop('1')).toBe(false)
    expect(get().drops).toBe(0)
  })

  it('refuses a drop when nothing is being dragged', () => {
    expect(get().countDrop('2')).toBe(false)
  })

  it('accepts a numeric target key', () => {
    get().begin('1', 'Track 1', effects, 0, 0)
    expect(get().countDrop(2)).toBe(true)
    expect(get().countDrop(1)).toBe(false)
  })

  it('clears everything on end', () => {
    get().begin('1', 'Track 1', effects, 10, 10)
    get().countDrop('2')
    get().end()
    expect(get().effects).toBeNull()
    expect(get().sourceKey).toBeNull()
    expect(get().hoverKey).toBeNull()
    expect(get().drops).toBe(0)
  })
})

describe('clipboard', () => {
  it('starts empty, so Paste has nothing to offer', () => {
    expect(get().clipboard).toBeNull()
  })

  it('holds one chain with the strip it came from', () => {
    get().copyChain('Track 1', effects)
    expect(get().clipboard).toEqual({ sourceLabel: 'Track 1', effects })
  })

  it('survives a drag ending — the two are independent', () => {
    get().copyChain('Track 1', effects)
    get().begin('1', 'Track 1', effects, 0, 0)
    get().end()
    expect(get().clipboard).not.toBeNull()
  })

  it('clears on request', () => {
    get().copyChain('Track 1', effects)
    get().clearClipboard()
    expect(get().clipboard).toBeNull()
  })
})
