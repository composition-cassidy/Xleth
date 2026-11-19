/* @vitest-environment jsdom */
// The hint bar re-reads on window 'xleth-hint-refresh': a canvas with per-row hints
// cannot rely on pointerover (it fires once when the pointer enters the canvas).
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import HintBar, { HINT_REFRESH_EVENT, requestHintRefresh } from './HintBar.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let root
let mount
const bar = () => mount.querySelector('[data-testid="hint-bar"]')

beforeEach(async () => {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  await act(async () => root.render(<HintBar />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  document.body.innerHTML = ''
})

const over = (el) => act(async () => { el.dispatchEvent(new Event('pointerover', { bubbles: true })) })
const refresh = (detail) => act(async () => { requestHintRefresh(detail) })

describe('hint refresh event', () => {
  it('is the documented window event', () => {
    expect(HINT_REFRESH_EVENT).toBe('xleth-hint-refresh')
  })

  it('detail { hint, mods } shows that text at once (a canvas row)', async () => {
    const canvas = document.createElement('canvas')
    canvas.setAttribute('data-hint', 'Key area')
    document.body.appendChild(canvas)
    await over(canvas)
    expect(bar().textContent).toBe('Key area')
    await refresh({ hint: 'Roam · Offset X: 3 keys', mods: 'Shift: add · Ctrl: toggle' })
    expect(bar().textContent).toContain('Roam · Offset X: 3 keys')
    expect(bar().textContent).toContain('Shift: add · Ctrl: toggle')
    await refresh({ hint: 'Scale' })
    expect(bar().textContent).toBe('Scale')
  })

  it('detail null re-reads the hovered element (after it rewrote its data-hint)', async () => {
    const canvas = document.createElement('canvas')
    canvas.setAttribute('data-hint', 'Row 1')
    document.body.appendChild(canvas)
    await over(canvas)
    canvas.setAttribute('data-hint', 'Row 2')
    canvas.setAttribute('data-hint-mods', 'Alt: no snap')
    expect(bar().textContent).toBe('Row 1')       // no pointerover inside one element
    await refresh(null)
    expect(bar().textContent).toBe('Row 2Alt: no snap')
  })

  it('the next pointerover wins over a pushed hint; null with nothing hovered clears', async () => {
    const a = document.createElement('button')
    a.setAttribute('data-hint', 'Play')
    document.body.appendChild(a)
    await refresh({ hint: 'From a canvas' })
    expect(bar().textContent).toBe('From a canvas')
    await over(a)
    expect(bar().textContent).toBe('Play')
    await act(async () => {
      a.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: null }))
    })
    expect(bar().textContent).toBe('')
    await refresh(null)
    expect(bar().textContent).toBe('')
  })
})
