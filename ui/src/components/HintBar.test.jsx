/* @vitest-environment jsdom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import HintBar, { resolveHint } from './HintBar.jsx'

function el(html) {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.appendChild(host)
  return host
}

describe('hint bar', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('prefers data-hint, then aria-label, then title, from the nearest documented ancestor', () => {
    const host = el(`
      <button data-hint="Play" data-hint-mods="Space" aria-label="Play button" title="t"><svg id="a"></svg></button>
      <button aria-label="Stop" title="Stop tooltip"><span id="b"></span></button>
      <div title="Only a title"><span id="c"></span></div>
      <div><span id="d"></span></div>`)
    expect(resolveHint(host.querySelector('#a'))).toEqual({ text: 'Play', mods: 'Space' })
    expect(resolveHint(host.querySelector('#b'))).toEqual({ text: 'Stop', mods: '' })
    expect(resolveHint(host.querySelector('#c'))).toEqual({ text: 'Only a title', mods: '' })
    expect(resolveHint(host.querySelector('#d'))).toEqual({ text: '', mods: '' })
  })

  it('shows the hovered control and its modifiers, and nothing invented', async () => {
    const host = el('<button id="t" data-hint="Rewind to the start" data-hint-mods="Home">x</button>')
    const mount = document.createElement('div')
    document.body.appendChild(mount)
    const root = createRoot(mount)
    await act(async () => root.render(<HintBar />))

    const bar = mount.querySelector('[data-testid="hint-bar"]')
    expect(bar.textContent).toBe('')

    await act(async () => {
      host.querySelector('#t').dispatchEvent(new Event('pointerover', { bubbles: true }))
    })
    expect(bar.textContent).toContain('Rewind to the start')
    expect(bar.textContent).toContain('Home')

    await act(async () => root.unmount())
  })
})
