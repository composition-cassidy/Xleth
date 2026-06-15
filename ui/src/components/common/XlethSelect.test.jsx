import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import XlethSelect, { getXlethSelectSelectedOption } from './XlethSelect.jsx'

describe('XlethSelect', () => {
  it('renders the selected label in the trigger', () => {
    const html = renderToStaticMarkup(
      <XlethSelect
        id="settings-video-mode"
        value="auto"
        options={[
          { value: 'auto', label: 'Auto (recommended)' },
          { value: 'software', label: 'Software' },
        ]}
        onChange={vi.fn()}
        ariaLabel="Video encode/decode"
      />
    )

    expect(html).toContain('Auto (recommended)')
    expect(html).toContain('aria-haspopup="listbox"')
    expect(html).not.toContain('<select')
  })

  it('renders a clear disabled state', () => {
    const html = renderToStaticMarkup(
      <XlethSelect
        id="settings-disabled"
        value="loading"
        options={[{ value: 'loading', label: 'Loading...' }]}
        onChange={vi.fn()}
        disabled
        ariaLabel="Loading setting"
      />
    )

    expect(html).toContain('disabled=""')
    expect(html).toContain('Loading...')
  })

  it('resolves selected options without stringifying numeric values away', () => {
    const options = [
      { value: 5, label: '5 min' },
      { value: 10, label: '10 min' },
    ]

    expect(getXlethSelectSelectedOption(options, 10)).toEqual(options[1])
    expect(getXlethSelectSelectedOption(options, '10')).toEqual(options[1])
  })
})
