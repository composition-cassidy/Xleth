import React, { useCallback, useEffect, useState } from 'react'
import { DeviceSection, SegmentedControl } from '../../ui-kit'
import { loadPreset } from '../../fx-presets/presetManager.js'
import AutomatableKnob from './AutomatableKnob.jsx'
import useDeviceParams from './useDeviceParams.js'
import styles from './GlossDevice.module.css'

// GLOSS as a device — the one-knob companion over the APEX engine (the Image-Line
// Soundgoodizer idea: the same maximizer with a radically simplified face). It is
// NOT a separate DSP effect: a GLOSS instance is an `apex`-class processor
// registered under the engine pluginId "gloss", so its identity and full APEX
// state persist through project save/load and every APEX fix reaches it.
//
// The face is two controls and nothing else:
//   Amount  the engine BAND MIX parameter (0 to 100 %). GLOSS opens fully dry, so
//           its default is 0 % (APEX's own BAND MIX default is 100 %).
//   Bank    A / B / C / D, each loading a shipped factory APEX preset in one
//           apply. The factory bank files omit `bandmix` on purpose, so loading a
//           bank never moves Amount. The lit letter is the last bank LOADED; it
//           does not track later manual edits (matching Soundgoodizer).
//
// There is no gain-reduction readout: the legacy GLOSS never read one and this
// device adds no display the panel did not have.
//
// Presets and A/B on the title bar use the APEX adapter (registry `presetType`),
// which captures the curves as well as the scalar parameters.

const GLOSS_BANKS = [
  { value: 'A', slug: 'gloss-a', label: 'A', hint: 'Load bank A' },
  { value: 'B', slug: 'gloss-b', label: 'B', hint: 'Load bank B' },
  { value: 'C', slug: 'gloss-c', label: 'C', hint: 'Load bank C' },
  { value: 'D', slug: 'gloss-d', label: 'D', hint: 'Load bank D' },
]

const AMOUNT_ID = 'bandmix'
const AMOUNT_DEFAULT = 0
const DEFAULTS = Object.freeze({ [AMOUNT_ID]: AMOUNT_DEFAULT })

// Factory bank param snapshots (bandmix stripped), loaded once and reused for
// active-bank derivation across opens.
const glossBankParamsCache = new Map() // slug -> { id: value } | null

// Session-scoped memory of the letter the user last loaded per instance, keyed by
// `${storeKey}:${nodeId}`. This is what makes the selection sticky: it survives
// close, reopen and pop-out within a session. It is not persisted — a reloaded
// project reassigns node ids, so the fallback matches the restored engine state
// against each bank snapshot.
const glossSelectedBank = new Map() // nodeKey -> 'A' | 'B' | 'C' | 'D'

function safeParseList(raw) {
  if (typeof raw === 'string') { try { return JSON.parse(raw) } catch { return [] } }
  return Array.isArray(raw) ? raw : []
}

function paramsListToMap(raw) {
  const map = {}
  for (const p of safeParseList(raw)) {
    if (p && typeof p.id === 'string' && Number.isFinite(p.value)) map[p.id] = p.value
  }
  return map
}

async function loadBankParams(slug) {
  if (glossBankParamsCache.has(slug)) return glossBankParamsCache.get(slug)
  let params = null
  try {
    const preset = await window?.xleth?.fxPresets?.load?.('apex', 'factory', slug)
    const raw = preset?.state?.params
    if (raw && typeof raw === 'object') {
      params = {}
      for (const [id, value] of Object.entries(raw)) {
        if (id !== AMOUNT_ID && Number.isFinite(value)) params[id] = value
      }
    }
  } catch { params = null }
  glossBankParamsCache.set(slug, params)
  return params
}

// Tolerant equality: the engine round-trips params through a float APVTS, so the
// read-back rarely matches the authored JSON bit for bit. Every scalar bank param
// must match its live value within an absolute+relative epsilon. Extra live keys
// (bandmix among them) are ignored, so Amount never affects the lit letter.
function bankMatchesLive(bankParams, liveParams) {
  if (!bankParams || !liveParams) return false
  for (const [id, want] of Object.entries(bankParams)) {
    const got = liveParams[id]
    if (!Number.isFinite(got)) return false
    const tol = Math.max(1e-2, Math.abs(want) * 1e-3)
    if (Math.abs(got - want) > tol) return false
  }
  return true
}

export default function GlossDevice({ target, registerApplied }) {
  const { params, preview, commit, syncParamsFromPreset } = useDeviceParams('gloss', DEFAULTS, target)
  const [activeBank, setActiveBank] = useState(null)
  const [busy, setBusy] = useState(false)
  const [errorText, setErrorText] = useState(null)

  // Presets and A/B write the engine through their adapter; mirror the blob here.
  useEffect(() => {
    registerApplied?.(syncParamsFromPreset)
    return () => registerApplied?.(null)
  }, [registerApplied, syncParamsFromPreset])

  const nodeKey = target ? `${target.storeKey}:${target.nodeId}` : null

  // Resolve the lit bank whenever the instance changes: the sticky memory wins,
  // else match the persisted engine state against each bank snapshot.
  useEffect(() => {
    if (!target) { setActiveBank(null); return undefined }
    const remembered = glossSelectedBank.get(nodeKey)
    if (remembered) { setActiveBank(remembered); setErrorText(null); return undefined }
    let cancelled = false
    setActiveBank(null)
    setErrorText(null)
    ;(async () => {
      let live = null
      try {
        live = paramsListToMap(await window?.xleth?.audio?.getEffectParameters?.(target.trackId, target.nodeId))
      } catch { live = null }
      if (cancelled || !live) return
      for (const bank of GLOSS_BANKS) {
        const bankParams = await loadBankParams(bank.slug)
        if (cancelled) return
        if (bankMatchesLive(bankParams, live)) {
          glossSelectedBank.set(nodeKey, bank.value) // remember the derived match too
          setActiveBank(bank.value)
          return
        }
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeKey])

  // Load a bank through the preset system in one apply, then mirror what it set.
  const applyBank = useCallback(async (value) => {
    const bank = GLOSS_BANKS.find((b) => b.value === value)
    if (!target || !bank || busy) return
    setBusy(true)
    setErrorText(null)
    try {
      const { after } = await loadPreset('apex', 'factory', bank.slug, target)
      syncParamsFromPreset(after)
      if (nodeKey) glossSelectedBank.set(nodeKey, bank.value)
      setActiveBank(bank.value)
    } catch (err) {
      setErrorText(err?.message || 'Failed to load bank')
    } finally {
      setBusy(false)
    }
  }, [target, busy, nodeKey, syncParamsFromPreset])

  const amount = Number.isFinite(params[AMOUNT_ID]) ? params[AMOUNT_ID] : AMOUNT_DEFAULT

  return (
    <>
      <DeviceSection title="Amount" width={108}>
        <AutomatableKnob
          paramId={AMOUNT_ID}
          target={target}
          label="Amount"
          value={amount}
          min={0}
          max={100}
          defaultValue={AMOUNT_DEFAULT}
          unit="%"
          size={72}
          width={92}
          hint="How much of the processed sound is mixed in. Bank changes never move it."
          data-param={AMOUNT_ID}
          onChange={(v) => preview(AMOUNT_ID, v)}
          onCommit={(v) => commit(AMOUNT_ID, v)}
        />
      </DeviceSection>

      <DeviceSection title="Bank" width={164}>
        <SegmentedControl
          size="lg"
          label="Bank"
          value={activeBank ?? ''}
          options={GLOSS_BANKS.map(({ value, label, hint }) => ({ value, label, hint, disabled: busy }))}
          hint="Load one of four factory settings. Amount stays where it is."
          data-param="bank"
          onChange={applyBank}
        />
        <span className={styles.caption}>Powered by APEX</span>
        {errorText ? <p className={styles.error} role="alert">{errorText}</p> : null}
      </DeviceSection>
    </>
  )
}
