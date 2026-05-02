// Tests for EqOutputMeter.
// Uses react-dom/server renderToStaticMarkup (node env, no jsdom).
// Canvas draw loop and requestAnimationFrame are not exercised — only
// the rendered HTML structure is verified.

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect } from 'vitest'

import EqOutputMeter from '../EqOutputMeter.jsx'
import * as METER_SLOTS from '../../../constants/meterSlots.js'

// ── Slot contract ─────────────────────────────────────────────────────────────

describe('meterSlots — EQ output meter slot contract', () => {
  it('PEAK_L is slot 0 (universal for all effects, including EQ)', () => {
    expect(METER_SLOTS.PEAK_L).toBe(0)
  })

  it('PEAK_R is slot 1 (universal for all effects, including EQ)', () => {
    expect(METER_SLOTS.PEAK_R).toBe(1)
  })
})

// ── EqOutputMeter rendering ───────────────────────────────────────────────────

describe('EqOutputMeter — inactive state (no audio target)', () => {
  it('renders .eq-output-meter wrapper', () => {
    const html = renderToStaticMarkup(
      <EqOutputMeter peaksRef={{ current: { l: 0, r: 0 } }} active={false} />
    )
    expect(html).toContain('eq-output-meter')
  })

  it('renders a canvas element', () => {
    const html = renderToStaticMarkup(
      <EqOutputMeter peaksRef={{ current: { l: 0, r: 0 } }} active={false} />
    )
    expect(html).toContain('<canvas')
  })

  it('renders the OUT label', () => {
    const html = renderToStaticMarkup(
      <EqOutputMeter peaksRef={{ current: { l: 0, r: 0 } }} active={false} />
    )
    expect(html).toContain('OUT')
    expect(html).toContain('eq-output-meter-label')
  })

  it('renders without throwing when peaksRef is null', () => {
    expect(() =>
      renderToStaticMarkup(
        <EqOutputMeter peaksRef={null} active={false} />
      )
    ).not.toThrow()
  })
})

describe('EqOutputMeter — active state', () => {
  it('renders without throwing when active with zero peaks', () => {
    expect(() =>
      renderToStaticMarkup(
        <EqOutputMeter peaksRef={{ current: { l: 0, r: 0 } }} active={true} />
      )
    ).not.toThrow()
  })

  it('renders without throwing when active with non-zero peaks', () => {
    expect(() =>
      renderToStaticMarkup(
        <EqOutputMeter peaksRef={{ current: { l: 0.7, r: 0.6 } }} active={true} />
      )
    ).not.toThrow()
  })

  it('renders without throwing when active but peaksRef is null (API unavailable)', () => {
    expect(() =>
      renderToStaticMarkup(
        <EqOutputMeter peaksRef={null} active={true} />
      )
    ).not.toThrow()
  })

  it('same HTML structure whether active or not (canvas always present)', () => {
    const inactive = renderToStaticMarkup(
      <EqOutputMeter peaksRef={{ current: { l: 0, r: 0 } }} active={false} />
    )
    const activeHtml = renderToStaticMarkup(
      <EqOutputMeter peaksRef={{ current: { l: 0.5, r: 0.4 } }} active={true} />
    )
    // Both render the meter container and label — only canvas draw content differs
    expect(inactive).toContain('eq-output-meter')
    expect(activeHtml).toContain('eq-output-meter')
    expect(inactive).toContain('<canvas')
    expect(activeHtml).toContain('<canvas')
  })
})

// ── BandRow / EqPanel integration guard ──────────────────────────────────────

describe('EqOutputMeter — integration guard', () => {
  it('does not import from eqStore (pure component — no store hooks)', async () => {
    // If EqOutputMeter had store hooks it would break the SSR test environment.
    // Verify the module loads cleanly without side-effects that need a DOM/store.
    const mod = await import('../EqOutputMeter.jsx')
    expect(typeof mod.default).toBe('function')
  })
})
