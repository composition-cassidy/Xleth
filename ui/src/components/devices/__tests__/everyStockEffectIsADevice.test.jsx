/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EFFECT_EDITORS } from '../../mixer/effectEditorOpeners.js'
import { DEVICE_BODIES } from '../deviceRegistry.js'
import { DEVICE_NAMES } from '../deviceNames.js'
import EffectDevice from '../EffectDevice.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('every stock effect is a device', () => {
  it('each of the 27 stock effects has a device body, a pop-out opener and a name', () => {
    const stock = Object.keys(EFFECT_EDITORS)
    expect(stock).toHaveLength(27)
    for (const id of stock) {
      expect(DEVICE_BODIES[id], `${id} has a body in DEVICE_BODIES`).toBeTruthy()
      expect(DEVICE_NAMES[id], `${id} has a name in DEVICE_NAMES`).toBeTruthy()
    }
  })

  it('DEVICE_BODIES holds nothing but stock effects', () => {
    for (const id of Object.keys(DEVICE_BODIES)) expect(EFFECT_EDITORS[id], `${id} is a stock effect`).toBeTruthy()
  })

  it('the placeholder card and its stock "Open editor" path are gone from the source', () => {
    const src = readFileSync(path.resolve(__dirname, '../EffectDevice.jsx'), 'utf8')
    expect(src).not.toMatch(/until its device arrives|StubDevice|stockOpener/)
  })
})

describe('a chain entry that is not a stock effect', () => {
  let container
  let root
  let openPluginEditor

  beforeEach(() => {
    openPluginEditor = vi.fn()
    window.xleth = { audio: { openPluginEditor }, timeline: { getTracks: async () => [] } }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    delete window.xleth
  })

  const render = (effect) => act(() => root.render(<EffectDevice effect={effect} storeKey="3" />))

  it('a live third-party plugin shows the frame and opens its own window', () => {
    render({ nodeId: 5, pluginId: 'vst3:example', bypassed: false })
    expect(container.textContent).toContain('Plugin editor opens in its own window.')
    expect(container.textContent).not.toContain('until its device arrives')
    const open = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Open editor')
    act(() => open.click())
    expect(openPluginEditor).toHaveBeenCalledWith(3, 5)
  })

  it('a missing plugin says so and offers no editor', () => {
    render({ nodeId: 5, pluginId: 'vst3:example', bypassed: false, missing: true })
    expect(container.textContent).toContain('Plugin missing')
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Open editor')).toBe(false)
  })
})
