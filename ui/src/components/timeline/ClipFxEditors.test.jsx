// @vitest-environment jsdom
//
// Round 2 step 19.5: the Vibrato and Scratch editors are non-modal floating windows of kit
// controls. The curve is one canvas (stubbed here); every other control commits once, through
// the same store action it always used.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'

vi.mock('../common/BreakpointCurveEditor.jsx', () => ({ default: () => <div data-testid="curve-canvas" /> }))

import ClipVibratoEditorPanel from './ClipVibratoEditorPanel.jsx'
import ClipScratchEditorPanel from './ClipScratchEditorPanel.jsx'
import useClipVibratoEditorStore from '../../stores/clipVibratoEditorStore.js'
import useClipScratchEditorStore from '../../stores/clipScratchEditorStore.js'
import { THIN_SPACE } from '../../ui-kit'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container, root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const q = (sel) => container.querySelector(sel)
const qa = (sel) => Array.from(container.querySelectorAll(sel))

async function typeValue(box, text) {
  await act(async () => { box.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })) })
  const input = box.querySelector('input')
  expect(input, 'the NumberBox opened its type-in field').toBeTruthy()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' })) })
}

const slider = (name) => q(`[role="slider"][aria-label="${name}"]`)

describe('Vibrato editor', () => {
  let commitVibrato, close
  beforeEach(() => {
    commitVibrato = vi.fn()
    close = vi.fn()
    useClipVibratoEditorStore.setState({
      target: { clipId: 127 },
      clip: { id: 127, modulation: { vibrato: { enabled: false, shape: 'sine', depthCents: 0, rateMode: 'freeHz', rateHz: 5, phaseOffset: 0.25, syncDivision: 'eighth', phaseResetOnClipStart: true } } },
      draftShape: null, selectedIdx: -1, commitVibrato, close,
    })
    act(() => { root.render(<ClipVibratoEditorPanel />) })
  })
  afterEach(() => { useClipVibratoEditorStore.setState({ target: null, clip: null }) })

  it('is a named, non-modal dialog that takes focus and closes on Escape', () => {
    const win = q('[data-testid="clip-vibrato-editor"]')
    expect(win.getAttribute('role')).toBe('dialog')
    expect(win.getAttribute('aria-modal')).toBe('false')
    expect(win.getAttribute('aria-label')).toBe('Vibrato editor')
    expect(document.activeElement).toBe(win)
    act(() => { win.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(close).toHaveBeenCalledOnce()
  })

  it('has no native range, select or checkbox: kit NumberBoxes, Selects, segments and a Toggle', () => {
    expect(q('input[type="range"]')).toBeNull()
    expect(q('select')).toBeNull()
    expect(q('input[type="checkbox"]')).toBeNull()
    expect(slider('Depth')).toBeTruthy()
    expect(slider('Rate')).toBeTruthy()
    expect(slider('Phase')).toBeTruthy()
    expect(q('[role="radiogroup"][aria-label="Vibrato shape"]')).toBeTruthy()
    expect(q('[role="radiogroup"][aria-label="Rate mode"]')).toBeTruthy()
    expect(q('button[aria-label="Sync division"]').disabled).toBe(true) // free Hz: no division
    expect(q('button[aria-pressed]').textContent).toContain('Reset phase on clip start')
  })

  it('prints values with their units and in sentence case', () => {
    expect(slider('Depth').getAttribute('aria-valuetext')).toBe(`Depth, 0${THIN_SPACE}¢`)
    expect(slider('Rate').getAttribute('aria-valuetext')).toBe(`Rate, 5.00${THIN_SPACE}Hz`)
    expect(slider('Phase').getAttribute('aria-valuetext')).toBe('Phase, 90°')
    expect(q('[data-testid="clip-vibrato-editor"]').textContent).not.toMatch(/SHAPE|RATE MODE|SYNC DIVISION/)
  })

  it('commits a typed depth once, with the same patch the slider wrote', async () => {
    await typeValue(slider('Depth'), '35')
    expect(commitVibrato).toHaveBeenCalledOnce()
    expect(commitVibrato).toHaveBeenCalledWith({ depthCents: 35 })
  })

  it('writes the phase in cycles and the rate mode as before', async () => {
    await typeValue(slider('Phase'), '180')
    expect(commitVibrato).toHaveBeenLastCalledWith({ phaseOffset: 0.5 })
    act(() => { Array.from(q('[aria-label="Rate mode"]').querySelectorAll('[role="radio"]')).find((r) => r.textContent === 'Sync').click() })
    expect(commitVibrato).toHaveBeenLastCalledWith({ rateMode: 'tempoSync' })
  })
})

describe('Scratch editor', () => {
  let commitScratch, close
  beforeEach(() => {
    commitScratch = vi.fn()
    close = vi.fn()
    useClipScratchEditorStore.setState({
      target: { clipId: 127 },
      clip: { id: 127, durationTicks: 7680, modulation: { scratch: { enabled: true, timeMode: 'clipSeconds', smoothingMs: 2, edgeMode: 'clamp', gainCompensationDb: 0, curve: [] } } },
      draftCurve: null, selectedIdx: -1, commitScratch, close,
    })
    act(() => { root.render(<ClipScratchEditorPanel />) })
  })
  afterEach(() => { useClipScratchEditorStore.setState({ target: null, clip: null }) })

  it('is a named, non-modal dialog and closes on Escape', () => {
    const win = q('[data-testid="clip-scratch-editor"]')
    expect(win.getAttribute('role')).toBe('dialog')
    expect(win.getAttribute('aria-modal')).toBe('false')
    act(() => { win.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(close).toHaveBeenCalledOnce()
  })

  it('has no native range or select, and prints smoothing and gain with their units', () => {
    expect(q('input[type="range"]')).toBeNull()
    expect(q('select')).toBeNull()
    expect(slider('Smoothing').getAttribute('aria-valuetext')).toBe(`Smoothing, 2.0${THIN_SPACE}ms`)
    expect(slider('Gain comp').getAttribute('aria-valuetext')).toBe(`Gain comp, 0.0${THIN_SPACE}dB`)
    expect(q('[data-testid="clip-scratch-editor"]').textContent).not.toMatch(/STAMP|BABY GEN|TIME MODE|EDGE MODE/)
  })

  it('commits a typed smoothing once and a time mode as before', async () => {
    await typeValue(slider('Smoothing'), '12')
    expect(commitScratch).toHaveBeenCalledOnce()
    expect(commitScratch).toHaveBeenCalledWith({ smoothingMs: 12 })
    act(() => { Array.from(q('[aria-label="Time mode"]').querySelectorAll('[role="radio"]')).find((r) => r.textContent === 'Beats').click() })
    expect(commitScratch).toHaveBeenLastCalledWith({ timeMode: 'beats' })
  })

  it('shows the Custom indicator for a curve that matches no preset', () => {
    expect(q('[data-testid="scratch-custom-indicator"]').textContent).toBe('Custom')
  })
})
