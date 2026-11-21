import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import PickerToolbar from './PickerToolbar.jsx'
import MarkedSamplesList from './MarkedSamplesList.jsx'
import { normalizeSelection } from './selection.js'

const noop = vi.fn()

function renderControls(overrides = {}) {
  return renderToStaticMarkup(
    <PickerToolbar
      playing={false}
      loop={false}
      label="Kick"
      sampleName="Kick 1"
      inPoint={1}
      outPoint={2.5}
      duration={60}
      allLabels={['Kick', 'Snare', 'Quote']}
      viewInfo={{ start: 0, end: 60, dur: 60, zoomed: false, width: 600 }}
      onTogglePlay={noop}
      onToggleLoop={noop}
      onSetIn={noop}
      onSetOut={noop}
      onInChange={noop}
      onOutChange={noop}
      onZoomToSelection={noop}
      onFit={noop}
      onLabelChange={noop}
      onNameChange={noop}
      onAddSample={noop}
      onAddCustomLabel={noop}
      {...overrides}
    />
  )
}

const tagWith = (html, testId) => html.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? ''

describe('sample editor components', () => {
  it('shows In, Out and length as values with units, on kit controls', () => {
    const html = renderControls()

    expect(html).toContain('aria-label="Sample name"')
    expect(html).toContain('aria-label="Sample label"')
    expect(html).not.toContain('<select')
    // In and Out are value fields: draggable, typeable, and named for a screen reader.
    expect(html).toContain('aria-valuetext="In, 0:01.000"')
    expect(html).toContain('aria-valuetext="Out, 0:02.500"')
    expect(html).toContain('1.500 s')
  })

  it('shows an unset point as a dash, never as a fake time', () => {
    const html = renderControls({ inPoint: null, outPoint: null })
    expect(html).toContain('aria-valuetext="In, —"')
    expect(html).toContain('aria-valuetext="Out, —"')
  })

  it('disables Add sample until the in/out selection is valid', () => {
    const disabled = (html) => /\sdisabled(=""|\s|>)/.test(tagWith(html, 'picker-add'))
    expect(disabled(renderControls({ inPoint: null, outPoint: null }))).toBe(true)
    expect(disabled(renderControls({ inPoint: 1, outPoint: 1.005 }))).toBe(true)
    expect(disabled(renderControls({ inPoint: 1, outPoint: 1.25 }))).toBe(false)
  })

  it('shows play and loop state at rest, not by colour alone', () => {
    expect(tagWith(renderControls({ playing: true }), 'picker-play')).toContain('aria-label="Pause"')
    expect(tagWith(renderControls({ playing: true }), 'picker-play')).toContain('aria-pressed="true"')
    expect(tagWith(renderControls({ loop: true }), 'picker-loop')).toContain('aria-pressed="true"')
    expect(tagWith(renderControls(), 'picker-loop')).toContain('aria-pressed="false"')
  })

  it('reports a name collision next to the name field', () => {
    const html = renderControls({ error: 'A Kick sample named "Kick 1" already exists.' })
    expect(html).toContain('role="alert"')
    expect(tagWith(html, 'picker-name')).toContain('aria-invalid="true"')
  })

  it('renders the marked list: empty, selected, remove and quote split, all visible at rest', () => {
    const empty = renderToStaticMarkup(
      <MarkedSamplesList samples={[]} selectedId={null} onSelect={noop} onDelete={noop} onSplit={noop} />
    )
    expect(empty).toContain('No samples marked yet')

    const filled = renderToStaticMarkup(
      <MarkedSamplesList
        selectedId="quote-1"
        onSelect={noop}
        onDelete={noop}
        onSplit={noop}
        showMarks
        onToggleShowMarks={noop}
        samples={[
          { id: 'quote-1', sourceId: 'source-1', startTime: 10, endTime: 12.25, label: 'Quote', name: 'Quote 1' },
          { id: 'kick-1', sourceId: 'source-1', startTime: 1, endTime: 1.2, label: 'Kick', name: 'Kick 1', hasSwappedAudio: true },
        ]}
      />
    )

    expect(filled).toContain('data-selected="true"')
    expect(filled).toContain('aria-pressed="true"')
    expect(filled).toContain('2.250 s')
    expect(filled).toContain('Swapped')
    // One split button (the Quote), one remove per row, each with its own name.
    expect(filled.match(/data-testid="picker-marked-split"/g)).toHaveLength(1)
    expect(filled).toContain('aria-label="Split syllables of Quote 1"')
    expect(filled).toContain('aria-label="Remove Quote 1"')
    expect(filled).toContain('aria-label="Remove Kick 1"')
    expect(tagWith(filled, 'picker-show-marks')).toContain('aria-pressed="true"')
  })

  it('normalizes reversed selections and rejects degenerate ranges', () => {
    expect(normalizeSelection(4, 1)).toEqual({ start: 1, end: 4, duration: 3 })
    expect(normalizeSelection(1, 1)).toBeNull()
    expect(normalizeSelection(null, 1)).toBeNull()
    expect(normalizeSelection(Number.NaN, 1)).toBeNull()
  })

  it('is off the legacy stylesheet: no global picker classes, no inline colours', () => {
    const dir = __dirname
    const sources = readdirSync(dir)
      .filter((f) => /\.jsx$/.test(f) && !/\.test\./.test(f) && f !== 'PickerGalleryFixture.jsx')
      .map((f) => readFileSync(path.join(dir, f), 'utf8'))
      .join('\n')
    expect(sources).not.toMatch(/className="(picker-|marked-sample|waveform-|tab-)/)
    expect(sources).not.toMatch(/#[0-9a-fA-F]{6}\b/)
    const legacy = readFileSync(path.resolve(dir, '../../styles/app.css'), 'utf8')
    expect(legacy).not.toMatch(/\.picker-|\.marked-sample|\.waveform-scrub/)
  })
})
