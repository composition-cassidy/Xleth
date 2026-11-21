// @vitest-environment jsdom
//
// A cell's name chip is not parked in the middle of the cell: it appears only
// while the pointer is inside that cell, and follows the pointer there.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import GridEditorOverlay from './GridEditorOverlay.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const LAYOUT = {
  columns: 3, rows: 3, previewFps: 30, gapScale: 0,
  canvasWidth: 1920, canvasHeight: 1080, canvasAspectRatio: '16:9',
  fullscreenLayers: [],
  slots: [
    { trackId: 1, gridX: 0, gridY: 0, spanX: 8, spanY: 8, zOrder: 0, opacity: 1 },
    { trackId: 2, gridX: 8, gridY: 0, spanX: 8, spanY: 8, zOrder: 1, opacity: 1 },
  ],
}
const TRACKS = [{ id: 1, name: 'bass', subdivisionFactor: 1 }, { id: 2, name: 'pitch', subdivisionFactor: 1 }]

let container, root

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
const slot = (i) => container.querySelectorAll('.grid-editor-slot.assigned')[i]
const move = (el, x = 40, y = 30) => act(async () => {
  el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y }))
})

describe('GridEditorOverlay: the name chip follows the pointer', () => {
  beforeEach(async () => {
    container = document.createElement('div'); document.body.appendChild(container)
    root = createRoot(container)
    window.xleth = {
      timeline: {
        getGridLayout: vi.fn().mockResolvedValue(LAYOUT),
        getTracks: vi.fn().mockResolvedValue(TRACKS),
      },
    }
    await act(async () => { root.render(<GridEditorOverlay />) })
    await flush()
  })
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); delete window.xleth })

  it('every cell carries its name, but shows nothing at rest', () => {
    expect(slot(0).getAttribute('aria-label')).toBe('bass')
    expect(slot(0).querySelector('.grid-editor-cell-label').textContent).toBe('bass')
    expect(slot(0).hasAttribute('data-hover')).toBe(false)
    expect(slot(1).hasAttribute('data-hover')).toBe(false)
  })

  it('shows the chip in the cell the pointer is in, and only that cell', async () => {
    await move(slot(0))
    expect(slot(0).hasAttribute('data-hover')).toBe(true)
    expect(slot(1).hasAttribute('data-hover')).toBe(false)
    expect(slot(0).style.getPropertyValue('--label-x')).not.toBe('')
    expect(slot(0).style.getPropertyValue('--label-y')).not.toBe('')
  })

  it('moves the chip with the pointer', async () => {
    // jsdom has no layout (every rect is 0x0), so the chip clamps to the 2px inset.
    // Give the cell a real size so the follow is observable.
    const el = slot(0)
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 })
    await move(el, 50, 40)
    const first = el.style.getPropertyValue('--label-x')
    await move(el, 150, 140)
    expect(el.style.getPropertyValue('--label-x')).not.toBe(first)
    expect(parseFloat(el.style.getPropertyValue('--label-x'))).toBeGreaterThan(parseFloat(first))
  })

  it('hides the chip when the pointer leaves the cell', async () => {
    await move(slot(0))
    await act(async () => {
      slot(0).dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }))
    })
    expect(slot(0).hasAttribute('data-hover')).toBe(false)
  })

  it('draws the chip out of flow and hidden unless the cell is hovered', async () => {
    const { readFileSync } = await import('node:fs')
    const css = readFileSync('src/components/GridEditorOverlay.module.css', 'utf8')
    expect(css).toMatch(/\.label \{[^}]*position:\s*absolute[^}]*visibility:\s*hidden/s)
    expect(css).toMatch(/\.slot\[data-hover\] \.label \{[^}]*visibility:\s*visible/s)
  })
})
