// @vitest-environment jsdom
//
// Round 2 step 19.4: the track colour popover, the timeline display popover and the Quantize
// dialog on the kit (Menu, SegmentedControl, Dialog).
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import TrackColorPopover from './TrackColorPopover.jsx'
import TimelineDisplayPopover from './TimelineDisplayPopover.jsx'
import QuantizeDialog from './QuantizeDialog.jsx'
import { trackColorName, trackColorSlotLabel } from './trackColorNames.js'
import { TRACK_PALETTE_FALLBACK } from './trackColorResolver.js'
import { TIMELINE_DISPLAY_DEFAULTS } from '../../stores/timelineDisplayStore.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container, root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const q = (sel) => document.body.querySelector(sel)
const qa = (sel) => Array.from(document.body.querySelectorAll(sel))

describe('identity colour names', () => {
  it('reads a name off the colour, and the slot number always rides along', () => {
    expect(trackColorName('#8D72E3')).toBe('Violet')
    expect(trackColorName('#4EB7A4')).toBe('Teal')
    expect(trackColorName('#DB6E3B')).toBe('Orange')
    expect(trackColorName('#D76A8F')).toBe('Pink')
    expect(trackColorName('#808080')).toBe('Grey')
    expect(trackColorName('nope')).toBe('Custom')
    expect(trackColorSlotLabel(9, '#DB6E3B')).toBe('Slot 9: Orange')
  })
})

describe('track colour popover', () => {
  const renderPopover = (track, handlers = {}) => act(() => {
    root.render(
      <TrackColorPopover
        anchorRect={{ left: 300, bottom: 100 }}
        track={track}
        palette={TRACK_PALETTE_FALLBACK}
        resolvedTrackColor="#58B2CE"
        onChooseAuto={vi.fn()} onChooseSlot={vi.fn()} onChooseCustom={vi.fn()} onClose={vi.fn()}
        {...handlers}
      />,
    )
  })

  it('is a menu with Auto, 16 named swatches and a custom colour', () => {
    renderPopover({ trackColorMode: 'paletteSlot', trackColorSlot: 4 })
    expect(q('[role="menu"][aria-label="Track color"]')).toBeTruthy()
    const swatches = qa('[role="menuitemradio"]')
    expect(swatches).toHaveLength(16)
    expect(swatches[3].getAttribute('aria-label')).toBe('Use track color 4: Violet')
    expect(swatches[3].getAttribute('data-hint')).toBe('Slot 4: Violet')
    expect(swatches.map((s) => s.getAttribute('aria-checked')).filter((v) => v === 'true')).toHaveLength(1)
    expect(swatches[3].getAttribute('aria-checked')).toBe('true')
    expect(qa('[role="menuitemcheckbox"]')[0].getAttribute('aria-checked')).toBe('false') // Auto is off
    expect(q('input[aria-label="Custom track color hex"]')).toBeTruthy()
  })

  it('marks Auto as checked in auto mode and picks a slot on click', () => {
    const onChooseSlot = vi.fn()
    renderPopover({ trackColorMode: 'auto' }, { onChooseSlot })
    expect(qa('[role="menuitemcheckbox"]')[0].getAttribute('aria-checked')).toBe('true')
    act(() => { qa('[role="menuitemradio"]')[8].click() })
    expect(onChooseSlot).toHaveBeenCalledWith(9)
  })

  it('walks the swatches with the arrow keys', () => {
    renderPopover({ trackColorMode: 'auto' })
    const swatches = qa('[role="menuitemradio"]')
    act(() => { swatches[0].focus() })
    act(() => { swatches[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })) })
    expect(document.activeElement).toBe(swatches[1])
    act(() => { swatches[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
    expect(document.activeElement).toBe(swatches[9])
  })
})

describe('timeline display popover', () => {
  it('has the eight settings as labelled segmented controls in sentence case, and writes the same setting keys', () => {
    const onSet = vi.fn()
    act(() => {
      root.render(
        <TimelineDisplayPopover settings={{ ...TIMELINE_DISPLAY_DEFAULTS }} onSet={onSet} onClose={vi.fn()} triggerRef={{ current: null }} />,
      )
    })
    const groups = qa('[role="radiogroup"]')
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual([
      'Clip body', 'Pattern body', 'Gradient', 'Contrast', 'Names', 'Metadata', 'Waveforms', 'Pattern preview',
    ])
    const text = q('[role="menu"]').textContent
    for (const word of ['Minimal', 'Gradient', 'Medium', 'Always']) expect(text).toContain(word)
    const labels = qa('[role="radio"]').map((r) => r.textContent)
    for (const abbreviated of ['Min', 'Grad', 'Med']) expect(labels).not.toContain(abbreviated)
    act(() => { groups[0].querySelector('[role="radio"][aria-checked="false"]').click() })
    expect(onSet).toHaveBeenCalledWith('timelineClipBodyMode', expect.any(String))
  })

  it('disables the gradient direction until a gradient body is on', () => {
    act(() => {
      root.render(
        <TimelineDisplayPopover settings={{ ...TIMELINE_DISPLAY_DEFAULTS }} onSet={vi.fn()} onClose={vi.fn()} triggerRef={{ current: null }} />,
      )
    })
    expect(qa('[role="radiogroup"]')[2].getAttribute('aria-disabled')).toBe('true')
    act(() => {
      root.render(
        <TimelineDisplayPopover settings={{ ...TIMELINE_DISPLAY_DEFAULTS, timelineClipBodyMode: 'gradient' }} onSet={vi.fn()} onClose={vi.fn()} triggerRef={{ current: null }} />,
      )
    })
    expect(qa('[role="radiogroup"]')[2].getAttribute('aria-disabled')).toBeNull()
  })
})

describe('Quantize dialog', () => {
  const renderDialog = (props = {}) => act(() => {
    root.render(
      <QuantizeDialog
        isOpen onClose={vi.fn()} onApply={vi.fn()}
        snapGranularity="1/16" selectionCount={3} hasClip hasPatternBlock={false}
        {...props}
      />,
    )
  })

  it('is a kit dialog named Quantize with the selection, the snap and two edge pickers', () => {
    renderDialog()
    const dialog = q('[role="dialog"]')
    expect(dialog).toBeTruthy()
    expect(dialog.textContent).toContain('Quantize')
    expect(dialog.textContent).toContain('3')
    expect(dialog.textContent).toContain('1/16')
    expect(dialog.textContent).not.toMatch(/START EDGE|END EDGE/)
    const groups = qa('[role="radiogroup"]')
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Start edge', 'End edge'])
  })

  it('applies the chosen actions once, with the same payload shape', () => {
    const onApply = vi.fn()
    renderDialog({ onApply })
    const [start] = qa('[role="radiogroup"]')
    act(() => { Array.from(start.querySelectorAll('[role="radio"]')).find((r) => r.textContent === 'Move').click() })
    const apply = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === 'Apply')
    act(() => { apply.click() })
    expect(onApply).toHaveBeenCalledOnce()
    expect(onApply).toHaveBeenCalledWith({ startAction: 'move', endAction: 'trim' })
  })

  it('disables Stretch for pattern blocks and Apply with nothing selected', () => {
    renderDialog({ hasPatternBlock: true, selectionCount: 0 })
    const stretch = qa('[role="radio"]').filter((r) => r.textContent === 'Stretch')
    expect(stretch).toHaveLength(2)
    for (const r of stretch) expect(r.disabled || r.getAttribute('aria-disabled') === 'true').toBe(true)
    const apply = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === 'Apply')
    expect(apply.disabled).toBe(true)
  })

  it('renders nothing when closed and closes on Cancel', () => {
    renderDialog({ isOpen: false })
    expect(q('[role="dialog"]')).toBeNull()
    const onClose = vi.fn()
    renderDialog({ onClose })
    act(() => { Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === 'Cancel').click() })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
