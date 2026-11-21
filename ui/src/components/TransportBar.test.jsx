import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import TransportBar, { formatBarBeat, formatTime } from './TransportBar.jsx'

describe('Transport cluster', () => {
  it('lays the controls out in transport order', () => {
    const html = renderToStaticMarkup(<TransportBar />)
    const order = ['Rewind', 'Stop', 'Play', 'Forward (not available yet)', 'Time 00:00.000', 'Bar 1, beat 1', 'Tempo', 'Tempo lock', 'Metronome', 'Auto scroll']
    const positions = order.map((label) => html.indexOf(`aria-label="${label}"`))
    positions.forEach((position, index) => expect(position, order[index]).toBeGreaterThan(-1))
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('is neutral at rest: the play control is not marked as playing', () => {
    const html = renderToStaticMarkup(<TransportBar />)
    expect(html).toContain('data-playing="false"')
  })

  it('gives the transport controls hint text for the hint bar', () => {
    const html = renderToStaticMarkup(<TransportBar />)
    expect(html).toContain('data-hint="Rewind to the start"')
    expect(html).toContain('data-hint-mods="Home"')
    expect(html).toContain('data-hint-mods="Space: play / pause"')
  })

  it('formats time and BAR.BEAT', () => {
    expect(formatTime(83456)).toBe('01:23.456')
    expect(formatBarBeat(0)).toBe('1.1')
    expect(formatBarBeat(5.75)).toBe('2.2')
  })

  it('keeps every interactive transport element out of the window drag region', () => {
    const read = (f) => readFileSync(path.resolve(process.cwd(), 'src', f), 'utf8')
    // Readout wells are local; the buttons and the tempo field are kit components that opt out themselves.
    expect(read('components/TransportBar.module.css')).toMatch(/\.readout\s*\{[^}]*-webkit-app-region:\s*no-drag/s)
    expect(read('ui-kit/Button.module.css')).toMatch(/\.btn\s*\{[^}]*-webkit-app-region:\s*no-drag/s)
    expect(read('ui-kit/NumberBox.module.css')).toMatch(/\.box\s*\{[^}]*-webkit-app-region:\s*no-drag/s)
  })

  it('is built from kit controls: IconButtons and a NumberBox tempo field', () => {
    const html = renderToStaticMarkup(<TransportBar />)
    expect(html).toContain('role="slider"') // the tempo NumberBox
    expect(html).toContain('aria-label="Tempo"')
    expect(html).toContain('aria-pressed="true"') // tempo lock is on by default
    expect(html).toContain('aria-valuetext="Tempo, 140 BPM"')
    expect(html).not.toContain('class="undefined')
  })
})
