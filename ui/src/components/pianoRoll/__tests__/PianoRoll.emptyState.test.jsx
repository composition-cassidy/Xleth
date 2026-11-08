/* @vitest-environment jsdom */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../PianoRollToolbar.jsx', () => ({ default: () => <div data-testid="toolbar" /> }))
vi.mock('../PianoRollCanvas.jsx', () => ({ default: React.forwardRef(() => <div data-testid="canvas" />) }))
vi.mock('../VelocityLane.jsx', () => ({ default: React.forwardRef(() => <div data-testid="velocity" />) }))
vi.mock('../../Toast.jsx', () => ({ useToast: () => ({ showToast: vi.fn() }) }))

import PianoRoll, { isUsablePatternId } from '../PianoRoll.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('isUsablePatternId', () => {
  it('rejects null, negative and non-integer ids, and ids no longer in the list', () => {
    expect(isUsablePatternId(null, [])).toBe(false)
    expect(isUsablePatternId(undefined)).toBe(false)
    expect(isUsablePatternId(-1)).toBe(false)
    expect(isUsablePatternId(1.5)).toBe(false)
    expect(isUsablePatternId(7, [{ id: 7 }])).toBe(true)
    expect(isUsablePatternId(8, [{ id: 7 }])).toBe(false)
    // List not loaded yet: trust the id.
    expect(isUsablePatternId(8, [])).toBe(true)
  })
})

describe('Piano Roll with no pattern', () => {
  let container
  let root
  let timeline
  beforeEach(() => {
    globalThis.ResizeObserver = class { observe() {} disconnect() {} }
    timeline = {
      getPattern: vi.fn(async () => { throw new Error('timeline_getPattern(id: number)') }),
      getRegions: vi.fn(async () => []),
      getTracks: vi.fn(async () => []),
      getPatternBlocks: vi.fn(async () => []),
    }
    Object.defineProperty(window, 'xleth', { configurable: true, value: { timeline } })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    delete window.xleth
    delete globalThis.ResizeObserver
  })

  it('never calls getPattern with an invalid id and shows the structural empty state', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onNewPattern = vi.fn()
    await act(async () => {
      root.render(<PianoRoll patternId={null} availablePatterns={[{ id: 3, name: 'A' }]} onNewPattern={onNewPattern} />)
      await Promise.resolve()
    })
    await act(async () => {
      root.render(<PianoRoll patternId={99} availablePatterns={[{ id: 3, name: 'A' }]} onNewPattern={onNewPattern} />)
      await Promise.resolve()
    })
    expect(timeline.getPattern).not.toHaveBeenCalled()
    expect(warn.mock.calls.some((c) => String(c[0]).includes('getPattern failed'))).toBe(false)
    expect(container.textContent).toContain('Select a pattern')
    expect(container.querySelector('[data-testid="canvas"]')).toBeNull()
    const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'New pattern')
    act(() => { button.click() })
    expect(onNewPattern).toHaveBeenCalled()
    warn.mockRestore()
  })
})
