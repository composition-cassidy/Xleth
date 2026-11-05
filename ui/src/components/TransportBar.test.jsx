import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import TransportBar, { formatBarBeat, formatTime } from './TransportBar.jsx'

describe('Transport cluster', () => {
  it('lays the controls out in transport order', () => {
    const html = renderToStaticMarkup(<TransportBar />)
    const order = ['Rewind', 'Stop', 'Play', 'Forward (not available yet)', 'Time 00:00.000', 'Bar 1, beat 1', 'Tempo 140 BPM, click to edit', 'Tempo lock', 'Auto scroll']
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
    const css = readFileSync(path.resolve(process.cwd(), 'src/components/TransportBar.module.css'), 'utf8')
    expect(css).toMatch(/\.btn,\s*\.readout,\s*\.bpm,\s*\.bpmInput\s*\{\s*-webkit-app-region:\s*no-drag/)
  })
})
