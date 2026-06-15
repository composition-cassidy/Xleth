import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ControlsRow from './ControlsRow.jsx'
import MarkedSamplesList from './MarkedSamplesList.jsx'
import { normalizeSelection } from './selection.js'

const noop = vi.fn()

function renderControls(overrides = {}) {
  return renderToStaticMarkup(
    <ControlsRow
      playing={false}
      label="Kick"
      sampleName="Kick 1"
      currentTime={12.25}
      inPoint={1}
      outPoint={2.5}
      duration={60}
      allLabels={['Kick', 'Snare', 'Quote']}
      onPlaySelection={noop}
      onSetIn={noop}
      onSetOut={noop}
      onLabelChange={noop}
      onNameChange={noop}
      onAddSample={noop}
      onAddCustomLabel={noop}
      {...overrides}
    />
  )
}

describe('SamplePicker revamp components', () => {
  it('renders the control strip with the themed select instead of a native select', () => {
    const html = renderControls()

    expect(html).toContain('xleth-select-trigger')
    expect(html).toContain('Sample name')
    expect(html).toContain('Now')
    expect(html).toContain('Total')
    expect(html).not.toContain('<select')
  })

  it('disables Add Sample until the in/out selection is valid', () => {
    const missingSelection = renderControls({ inPoint: null, outPoint: null })
    const tinySelection = renderControls({ inPoint: 1, outPoint: 1.005 })
    const validSelection = renderControls({ inPoint: 1, outPoint: 1.25 })

    expect(missingSelection).toMatch(/picker-add-btn[^>]*disabled/)
    expect(tinySelection).toMatch(/picker-add-btn[^>]*disabled/)
    expect(validSelection).not.toMatch(/picker-add-btn[^>]*disabled/)
  })

  it('renders the right-rail empty, selected, delete, and quote split states', () => {
    const empty = renderToStaticMarkup(
      <MarkedSamplesList
        samples={[]}
        selectedId={null}
        onSelect={noop}
        onDelete={noop}
        onSplit={noop}
      />
    )

    expect(empty).toContain('No samples marked yet')

    const filled = renderToStaticMarkup(
      <MarkedSamplesList
        selectedId="quote-1"
        onSelect={noop}
        onDelete={noop}
        onSplit={noop}
        samples={[
          {
            id: 'quote-1',
            sourceId: 'source-1',
            startTime: 10,
            endTime: 12.25,
            label: 'Quote',
            name: 'Quote 1',
          },
        ]}
      />
    )

    expect(filled).toContain('marked-sample-item selected')
    expect(filled).toContain('aria-pressed="true"')
    expect(filled).toContain('marked-sample-split')
    expect(filled).toContain('marked-sample-delete')
  })

  it('normalizes reversed selections and rejects degenerate ranges', () => {
    expect(normalizeSelection(4, 1)).toEqual({ start: 1, end: 4, duration: 3 })
    expect(normalizeSelection(1, 1)).toBeNull()
    expect(normalizeSelection(null, 1)).toBeNull()
    expect(normalizeSelection(Number.NaN, 1)).toBeNull()
  })
})
