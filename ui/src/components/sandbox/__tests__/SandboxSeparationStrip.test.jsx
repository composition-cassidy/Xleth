/**
 * @vitest-environment jsdom
 */
import React, { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same flag the other component tests in this repo set. Without it every
// act() logs a warning, and a suite that prints warnings on a green run is a
// suite whose output nobody reads.
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// What this file defends, and why each one is here rather than in the store
// tests: all three are obligations the SEPARATE surface (now split across
// SandboxMenuBar's EFFECT ▾ → SEPARATE tier buttons and
// SandboxSeparationStrip's progress/licence/advanced UI) discharges, and a
// store that behaves perfectly while nothing renders satisfies none of them.
//
//   1. The credit lines are on screen. Both weights are licensed on condition
//      of attribution, and showing the line is what actually satisfies that
//      condition — NOTICE-separation-models.md says in as many words that if
//      the line leaves the UI, the CLEARED status is no longer accurate.
//   2. The licence question is answerable. A 409 that renders as prose with no
//      button is a permanently dead BALANCED tier.
//   3. Tiers come from the manifest, and the per-tier device and estimate come
//      with them. One device chip for two runtimes is a six-fold lie about one
//      of them.

const NC_TEXT = 'CC BY-NC 4.0: non-commercial use only, and you must credit becruily.'

function catalog() {
  return {
    tiers: [
      { id: 'fast', label: 'FAST', modelId: 'kim', enabled: true, order: 0, hint: 'MDX-Net' },
      { id: 'balanced', label: 'BALANCED', modelId: 'deux', enabled: true, order: 1, hint: 'Mel-Band RoFormer' },
      { id: 'best', label: 'BEST', modelId: null, enabled: false, order: 2, planned: 'P4-3' },
    ],
    models: [
      {
        id: 'kim',
        name: 'MDX-Net Kim Vocal 2',
        device: 'cuda',
        runtimeOk: true,
        missing: [],
        secondsPerSecond: 0.05,
        fixedSeconds: 0,
        speedMeasured: true,
        sizeBytes: 66_759_214,
        store: { present: true },
        license: { cleared: true, requiresAcknowledgement: false, commercialUse: true,
                   attribution: 'Kim Vocal 2 — model by KimberleyJSN, via UVR (MIT).' },
      },
      {
        id: 'deux',
        name: 'Mel-Band RoFormer “deux”',
        device: 'cpu',
        runtimeOk: true,
        missing: [],
        secondsPerSecond: 3.09,
        fixedSeconds: 40,
        speedMeasured: true,
        sizeBytes: 435_007_990,
        store: { present: false },
        license: { cleared: true, requiresAcknowledgement: true, acknowledgement: NC_TEXT,
                   commercialUse: false, spdx: 'CC-BY-NC-4.0',
                   licenseUrl: 'https://creativecommons.org/licenses/by-nc/4.0/',
                   attribution: 'Mel-Band RoFormer “deux” — model by becruily, CC BY-NC 4.0.' },
      },
    ],
  }
}

// 60 s of stereo audio, so the estimates have something real to scale.
function readyLayer() {
  const n = 44100 * 60
  return {
    id: 1,
    name: 'Verse',
    renderState: 'ready',
    ops: [],
    renderedBuffer: {
      sampleRate: 44100,
      numChannels: 2,
      channels: [new Float32Array(n), new Float32Array(n)],
    },
  }
}

// Mirrors SandboxPanelContent's own composition: SandboxMenuBar owns the
// button that OPENS the advanced (ENSEMBLE/DE-BLEED) panel, but the panel
// itself lives in SandboxSeparationStrip — both driven by one lifted
// `advancedOpen` bit, not either component's local state.
function Harness({ withStrip = true, withMenu = true }) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  return (
    <>
      {withMenu && <SandboxMenuBar onOpenAdvancedSeparation={() => setAdvancedOpen(true)} />}
      {withStrip && (
        <SandboxSeparationStrip
          advancedOpen={advancedOpen}
          onToggleAdvanced={() => setAdvancedOpen((v) => !v)}
        />
      )}
    </>
  )
}

let SandboxMenuBar
let SandboxSeparationStrip

async function mount({ separationState = {}, layers = [readyLayer()], activeLayerId = 1, ...harnessProps } = {}) {
  vi.resetModules()
  const sandboxMod = await import('../../../stores/sandboxStore.js')
  sandboxMod.default.setState({ layers, activeLayerId })

  const sepMod = await import('../../../stores/separationStore.js')
  sepMod.default.setState({
    status: { running: true, python: { version: '3.14.2' }, runtimeOk: true, missing: [] },
    statusState: 'ready',
    catalog: catalog(),
    catalogState: 'ready',
    ...separationState,
  })

  ;({ default: SandboxMenuBar } = await import('../SandboxMenuBar.jsx'))
  ;({ default: SandboxSeparationStrip } = await import('../SandboxSeparationStrip.jsx'))

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(<Harness {...harnessProps} />) })
  return { host, root, useSeparationStore: sepMod.default }
}

// Opens the EFFECT ▾ dropdown so its SEPARATE tier buttons are queryable.
async function openEffectMenu(host) {
  const btn = [...host.querySelectorAll('button')].find((b) => b.textContent.includes('EFFECT'))
  await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

function tierButtons(host) {
  return [...host.querySelectorAll('.sandbox-separation-tier')]
}

describe('Sample Sandbox separation UI (SandboxMenuBar SEPARATE + SandboxSeparationStrip)', () => {
  let mounted = []

  beforeEach(() => {
    // Both components probe on mount through window.xleth. Nothing here
    // should reach a sidecar; if it tries, these throw loudly rather than
    // hanging.
    globalThis.window.xleth = {
      separation: {
        getStatus: vi.fn(async () => ({ running: true, python: { version: '3.14.2' } })),
        listModels: vi.fn(async () => catalog()),
        onProgress: vi.fn(() => () => {}),
        separateBuffer: vi.fn(async () => ({ id: 'job-1', state: 'queued', tier: 'balanced' })),
      },
    }
  })

  afterEach(() => {
    mounted.forEach(({ root, host }) => { act(() => root.unmount()); host.remove() })
    mounted = []
    vi.restoreAllMocks()
  })

  function track(m) { mounted.push(m); return m }

  it('renders a credit line for every weight that can run', async () => {
    // The licence condition attaches to whichever model is used, so both
    // credits are shown before the user chooses — not only mid-run.
    const { host } = track(await mount({ withMenu: false }))
    const text = host.textContent
    expect(text).toContain('KimberleyJSN')
    expect(text).toContain('becruily')
    expect(text).toContain('CC BY-NC 4.0')
  })

  it('builds its EFFECT ▾ → SEPARATE tier buttons from the manifest, not a hardcoded list', async () => {
    const { host } = track(await mount({ withStrip: false }))
    await openEffectMenu(host)
    const buttons = tierButtons(host)
    expect(buttons.map((b) => b.textContent)).toEqual(['FAST', 'BALANCED', 'BEST'])
    expect(buttons[0].disabled).toBe(false)
    expect(buttons[1].disabled).toBe(false)
    expect(buttons[2].disabled).toBe(true)   // unwired, and says so
  })

  it('quotes a separate time and device for each tier', async () => {
    // 60 s of audio: FAST is 60 * 0.05 = 3 s on cuda; BALANCED is
    // 40 + 60 * 3.09 = 225 s on cpu. One figure for both is how a
    // four-minute job looks like a hang.
    const { host } = track(await mount({ withMenu: false }))
    const status = host.querySelector('.sandbox-separation-status').textContent
    expect(status).toContain('FAST 3s on cuda')
    expect(status).toContain('BALANCED 3m 45s on cpu')
  })

  it('warns in the tooltip about the first-run download and the licence', async () => {
    const { host } = track(await mount({ withStrip: false }))
    await openEffectMenu(host)
    const balanced = tierButtons(host).find((b) => b.textContent === 'BALANCED')
    expect(balanced.title).toContain('415 MB')
    expect(balanced.title).toContain('non-commercial use only')
  })

  it('renders the licence question with a way to answer it', async () => {
    const { host, useSeparationStore } = track(await mount({
      withMenu: false,
      separationState: {
        licensePrompt: {
          code: 'license-acknowledgement-required',
          modelId: 'deux',
          tier: 'balanced',
          spdx: 'CC-BY-NC-4.0',
          licenseUrl: 'https://creativecommons.org/licenses/by-nc/4.0/',
          message: NC_TEXT,
        },
      },
    }))

    const row = host.querySelector('.sandbox-separation-license')
    expect(row).not.toBeNull()
    expect(row.textContent).toContain(NC_TEXT)

    // The full licence has to be reachable, not just summarised.
    const link = row.querySelector('a')
    expect(link.href).toContain('creativecommons.org/licenses/by-nc/4.0')

    const accept = row.querySelector('.sandbox-separation-license-accept')
    expect(accept).not.toBeNull()

    const acceptLicense = vi.fn(async () => null)
    act(() => { useSeparationStore.setState({ acceptLicense }) })
    await act(async () => { accept.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(acceptLicense).toHaveBeenCalled()
  })

  it('a licence question is not an error', async () => {
    // It must not land in the error slot: nothing failed and nothing was
    // downloaded — the run is waiting on an answer.
    const { host } = track(await mount({
      withMenu: false,
      separationState: { licensePrompt: { modelId: 'deux', tier: 'balanced', message: NC_TEXT } },
    }))
    expect(host.querySelector('.sandbox-status-item.error')).toBeNull()
  })

  it('a tier missing its own packages does not disable the other one', async () => {
    // FAST and BALANCED depend on different Python packages. Gating a working
    // tier on a missing one breaks a feature to report a feature.
    const broken = catalog()
    broken.models[1].runtimeOk = false
    broken.models[1].missing = ['einops', 'librosa']

    const { host } = track(await mount({ withStrip: false, separationState: { catalog: broken } }))
    await openEffectMenu(host)
    const buttons = tierButtons(host)
    const fast = buttons.find((b) => b.textContent === 'FAST')
    const balanced = buttons.find((b) => b.textContent === 'BALANCED')

    expect(fast.disabled).toBe(false)
    expect(balanced.disabled).toBe(true)
    expect(balanced.title).toContain('einops')
  })

  it('a wired tier whose licence has not cleared is disabled with the reason, not a raw error', async () => {
    // The real BEST tier: enabled, a real model, a real checksum — but its
    // licence status is PENDING-AUDIT. That must disable the button with an
    // explanation, the same shape a missing runtime package already gets,
    // rather than letting the user press it and hit the sidecar's 403 cold.
    const pending = catalog()
    pending.tiers[2] = { id: 'best', label: 'BEST', modelId: 'ft1', enabled: true, order: 2 }
    pending.models.push({
      id: 'ft1',
      name: 'BS-Roformer FT1 (anvuew)',
      device: 'cpu',
      runtimeOk: true,
      missing: [],
      secondsPerSecond: 5.99,
      fixedSeconds: 11,
      speedMeasured: true,
      store: { present: false },
      license: { cleared: false, spdx: 'GPL-3.0', requiresAcknowledgement: false },
    })

    const { host } = track(await mount({ withStrip: false, separationState: { catalog: pending } }))
    await openEffectMenu(host)
    const buttons = tierButtons(host)
    const best = buttons.find((b) => b.textContent === 'BEST')

    expect(best.disabled).toBe(true)
    expect(best.title).toContain('GPL-3.0')
    expect(best.title).toContain('audit')

    // FAST and BALANCED stay live — one tier's unclosed audit must not sink
    // the other two, same principle as the missing-package test above.
    expect(buttons.find((b) => b.textContent === 'FAST').disabled).toBe(false)
    expect(buttons.find((b) => b.textContent === 'BALANCED').disabled).toBe(false)
  })

  it('the advanced row is hidden until EFFECT ▾ → Advanced is pressed, then exposes DE-BLEED and ENSEMBLE', async () => {
    const { host } = track(await mount())
    expect(host.querySelector('.sandbox-separation-advanced')).toBeNull()

    await openEffectMenu(host)
    const openAdvanced = [...host.querySelectorAll('button')]
      .find((b) => b.className.includes('sandbox-menu-item--advanced-separation'))
    await act(async () => { openAdvanced.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    const row = host.querySelector('.sandbox-separation-advanced')
    expect(row).not.toBeNull()
    expect(row.textContent).toContain('DE-BLEED')
    expect(row.textContent).toContain('ENSEMBLE')
  })

  it('checking ENSEMBLE defaults a pair from the two runnable tiers and can run it', async () => {
    const { host, useSeparationStore } = track(await mount({ withMenu: false }))
    await act(async () => {
      host.querySelector('.sandbox-separation-advanced-toggle')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const [debleedBox, ensembleBox] = host.querySelectorAll('.sandbox-separation-checkbox input')
    await act(async () => { ensembleBox.click() })

    // FAST + BALANCED are the only two runnable candidates in this fixture.
    expect(useSeparationStore.getState().ensembleMode).toBe(true)
    expect(useSeparationStore.getState().ensemblePair).toEqual(['fast', 'balanced'])

    const run = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Run')
    expect(run).not.toBeNull()
    expect(run.disabled).toBe(false)

    await act(async () => { run.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const call = window.xleth.separation.separateBuffer.mock.calls[0][0]
    expect(call.ensembleModelIds).toEqual(['kim', 'deux'])
    expect(debleedBox.checked).toBe(false)
  })

  it('DE-BLEED is carried on an ordinary tier run (EFFECT ▾ → SEPARATE) once checked', async () => {
    const { host } = track(await mount())
    await act(async () => {
      host.querySelector('.sandbox-separation-advanced-toggle')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const [debleedBox] = host.querySelectorAll('.sandbox-separation-checkbox input')
    await act(async () => { debleedBox.click() })

    await openEffectMenu(host)
    const fastButton = tierButtons(host).find((b) => b.textContent === 'FAST')
    await act(async () => { fastButton.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(window.xleth.separation.separateBuffer.mock.calls[0][0].deBleed).toBe(true)
  })

  it('quotes no estimate when there is no layer to scale one from', async () => {
    // An estimate with no input is a made-up number.
    const { host } = track(await mount({ withMenu: false, layers: [], activeLayerId: null }))
    const status = host.querySelector('.sandbox-separation-status').textContent
    expect(status).toContain('Select a layer')
    expect(status).not.toContain('on cpu')
  })
})
