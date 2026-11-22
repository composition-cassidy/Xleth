/* @vitest-environment jsdom */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SampleSelectorTab from '../SampleSelectorTab.jsx'
import useSampleHoverStore from '../../stores/sampleHoverStore.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const region = (id, name) => ({ id, name, sourceId: 1, startTime: 0, endTime: 1, label: 'Pitch' })

describe('Sample Selector follows the Piano Roll sample list', () => {
  let container
  let root
  let scrolled
  beforeEach(async () => {
    scrolled = []
    Element.prototype.scrollIntoView = function scrollIntoView(opts) { scrolled.push([this.getAttribute('data-region-id'), opts]) }
    globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} }
    Object.defineProperty(window, 'xleth', {
      configurable: true,
      value: {
        timeline: {
          getRegions: async () => [region(11, 'Kick'), region(12, 'Vox')],
          getSources: async () => [{ id: 1, name: 'src', fileName: 'src.wav', filePath: 'C:/src.wav' }],
        },
        settings: { get: async () => null, set: async () => {} },
      },
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<SampleSelectorTab onOpenPicker={() => {}} activeSampleId={null} setActiveSampleId={() => {}} />)
      await Promise.resolve()
    })
  })
  afterEach(() => {
    act(() => { useSampleHoverStore.getState().setRegionId(null) })
    act(() => root.unmount())
    container.remove()
    delete window.xleth
  })

  it('scrolls to the sample under the pointer and marks only that row', async () => {
    await act(async () => { useSampleHoverStore.getState().setRegionId(12) })
    const rows = [...container.querySelectorAll('[data-region-id]')]
    expect(rows.map((r) => r.getAttribute('data-region-id'))).toEqual(['11', '12'])
    expect(rows.map((r) => r.getAttribute('data-marked'))).toEqual([null, 'true'])
    expect(scrolled).toEqual([['12', { block: 'nearest' }]])
    await act(async () => { useSampleHoverStore.getState().setRegionId(null) })
    expect(container.querySelector('[data-marked]')).toBeNull()
  })
})
