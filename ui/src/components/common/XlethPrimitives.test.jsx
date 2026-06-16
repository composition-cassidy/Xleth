import React from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { XlethButton, XlethIconButton } from './XlethButton.jsx'
import XlethFader from './XlethFader.jsx'
import XlethKnob from './XlethKnob.jsx'
import XlethMeter from './XlethMeter.jsx'
import XlethPanelHeader from './XlethPanelHeader.jsx'
import XlethSelect from './XlethSelect.jsx'

describe('Xleth shared primitives', () => {
  it('renders button, icon button, knob, fader, meter, and panel header primitives', () => {
    const html = renderToStaticMarkup(
      <div>
        <XlethButton active>Button</XlethButton>
        <XlethIconButton aria-label="Icon">I</XlethIconButton>
        <XlethKnob value={0.5} label="Gap" />
        <XlethFader value={0.5} />
        <XlethMeter value={0.25} />
        <XlethPanelHeader title="Header" meta="Meta" />
      </div>
    )

    expect(html).toContain('xleth-button')
    expect(html).toContain('xleth-icon-button')
    expect(html).toContain('xleth-knob')
    expect(html).toContain('xleth-fader')
    expect(html).toContain('xleth-meter')
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
