import React from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { XlethButton, XlethIconButton } from './XlethButton.jsx'
import XlethSelect from './XlethSelect.jsx'

// XlethKnob and XlethPanelHeader were removed in Phase 8 (superseded by the
// ui-kit Knob and the kit headers); the kit has its own tests.
describe('Xleth shared primitives', () => {
  it('renders button and icon button primitives', () => {
    const html = renderToStaticMarkup(
      <div>
        <XlethButton active>Button</XlethButton>
        <XlethIconButton aria-label="Icon">I</XlethIconButton>
      </div>
    )

    expect(html).toContain('xleth-button')
    expect(html).toContain('xleth-icon-button')
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
