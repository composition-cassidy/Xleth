import React from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { XlethButton, XlethIconButton } from './XlethButton.jsx'
import XlethKnob from './XlethKnob.jsx'
import XlethPanelHeader from './XlethPanelHeader.jsx'
import XlethSelect from './XlethSelect.jsx'

// NOTE: XlethFader.jsx and XlethMeter.jsx were referenced here but were never
// committed to the repo (f923d3a added this test plus XlethKnob/XlethPanelHeader
// and left the other two untracked on the machine it was made on). If those
// primitives land, restore them to this render list.
describe('Xleth shared primitives', () => {
  it('renders button, icon button, knob, and panel header primitives', () => {
    const html = renderToStaticMarkup(
      <div>
        <XlethButton active>Button</XlethButton>
        <XlethIconButton aria-label="Icon">I</XlethIconButton>
        <XlethKnob value={0.5} label="Gap" />
        <XlethPanelHeader title="Header" meta="Meta" />
      </div>
    )

    expect(html).toContain('xleth-button')
    expect(html).toContain('xleth-icon-button')
    expect(html).toContain('xleth-knob')
    expect(html).toContain('xleth-panel-header')
    expect(html).toContain('data-active="true"')
  })

  it('renders the select trigger primitive without opening the portal', () => {
    const html = renderToStaticMarkup(
      <XlethSelect
        value="a"
        options={[{ value: 'a', label: 'Alpha' }]}
        ariaLabel="Select value"
      />
    )

    expect(html).toContain('xleth-select-trigger')
    expect(html).toContain('Alpha')
  })
})
