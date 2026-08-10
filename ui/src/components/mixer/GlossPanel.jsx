import React, { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import useApexStore from '../../stores/apexStore.js'
import PluginUIKitKnob from '../../plugin-ui/runtime/components/PluginUIKitKnob.jsx'
import { loadPreset } from '../../fx-presets/presetManager.js'
import { GLOBAL_KNOBS } from './apexGeometry.js'

// GLOSS — the one-knob companion skin over the APEX engine (Image-Line
// Soundgoodizer concept: the same maximizer with a radically simplified face).
//
// It is NOT a separate DSP effect: a GLOSS instance is an `apex`-class processor
// registered under the distinct engine pluginId "gloss" (AudioGraph factory), so
// its skin identity + full APEX state persist through project save/load and every
// APEX fix propagates for free. This panel and ApexPanel share ONE store
// (apexStore); the target's `skin` field selects which one renders.
//
// The face is DELIBERATELY just two controls: one giant AMOUNT knob bound to the
// engine BAND MIX parameter, and four lettered banks (A/B/C/D) that each load a
// shipped factory APEX preset through the preset system in one apply. There is no
// preset bar here on purpose — the banks ARE the preset surface for GLOSS; anyone
// wanting the full library opens the same effect in APEX. AMOUNT stays independent
// of bank selection: the factory bank files deliberately omit `bandmix`, so
// loading a bank never moves the knob. The active letter reflects the last loaded
// snapshot; it does not track later manual edits (matching Soundgoodizer).
//
// Theming: CSS custom-property tokens only, no hardcoded hex; tokenValue() is
// never called at module scope; flat, zero-border-radius; color is earned (the
// active bank and AMOUNT activity carry the accent). Drag discipline: the knob
// previews locally during a drag and commits exactly one param on release — never
// IPC mid-gesture. No reserved script identifiers are declared here.

// The four banks. Letters are generic; the values are ours (factory/apex/gloss-*.json).
const GLOSS_BANKS = [
  { key: 'A', slug: 'gloss-a' },
  { key: 'B', slug: 'gloss-b' },
  { key: 'C', slug: 'gloss-c' },
  { key: 'D', slug: 'gloss-d' },
]

// AMOUNT is bound to the engine BAND MIX parameter (0–100 %). GLOSS opens fully
// DRY, so its AMOUNT default is 0 % — unlike APEX's BAND MIX default of 100 %.
// A fresh gloss node is created at 0 (effectChainStore.addEffect), and this is
// also the knob's reset value and its pre-hydration display fallback.
const AMOUNT = GLOBAL_KNOBS.bandmix
const AMOUNT_DEFAULT = 0
const AMOUNT_APPEARANCE = { preset: 'mixer-ring', sizePreset: 'inherit' }

// factory bank param snapshots (bandmix stripped), loaded once and reused for
// active-bank derivation across opens.
const glossBankParamsCache = new Map()   // slug -> { id: value } | null

// Session-scoped memory of the letter the user last loaded per open instance,
// keyed by `${storeKey}:${nodeId}`. This is what makes the selection STICKY: the
// lit letter reflects the last bank LOADED and is not re-derived from (possibly
// edited) engine state, and it survives close/reopen within a session. It is not
// persisted — a reloaded project reassigns node ids, so open() falls back to
// matching the restored engine state against each bank snapshot.
const glossSelectedBank = new Map()      // nodeKey -> 'A'|'B'|'C'|'D'

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
        if (id !== 'bandmix' && Number.isFinite(value)) params[id] = value
      }
    }
  } catch { params = null }
  glossBankParamsCache.set(slug, params)
  return params
}

// Tolerant equality: the engine round-trips params through a float APVTS, so the
// read-back rarely matches the authored JSON bit-for-bit. Every scalar bank param
// must match its live value within an absolute+relative epsilon. Extra live keys
// (e.g. bandmix / AMOUNT) are ignored, so AMOUNT never affects the lit letter.
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

export default function GlossPanel() {
  const target = useApexStore(s => s.target)
  const close = useApexStore(s => s.close)
  const amount = useApexStore(s => s.params[AMOUNT.id])
  const previewParam = useApexStore(s => s.previewParam)
  const commitParam = useApexStore(s => s.commitParam)
  const applyPresetState = useApexStore(s => s.applyPresetState)

  const [activeBank, setActiveBank] = useState(null)
  const [busy, setBusy] = useState(false)
  const [errorText, setErrorText] = useState(null)
  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round(window.innerWidth / 2 - 170),
    y: 72,
  }))
  const panelDragRef = useRef(null)

  const isGloss = !!target && target.skin === 'gloss'
  const nodeKey = target ? `${target.storeKey}:${target.nodeId}` : null

  const handleHeaderMouseDown = useCallback((e) => {
    if (e.target.closest('button')) return
    e.preventDefault()
    panelDragRef.current = {
      startMouseX: e.clientX, startMouseY: e.clientY,
      startPanelX: panelPos.x, startPanelY: panelPos.y,
    }
  }, [panelPos])

  useEffect(() => {
    const onMove = (e) => {
      if (!panelDragRef.current) return
      const { startMouseX, startMouseY, startPanelX, startPanelY } = panelDragRef.current
      setPanelPos({
        x: Math.max(-260, Math.min(window.innerWidth - 80, startPanelX + e.clientX - startMouseX)),
        y: Math.max(0, Math.min(window.innerHeight - 60, startPanelY + e.clientY - startMouseY)),
      })
    }
    const onUp = () => { panelDragRef.current = null }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [])

  // Resolve the lit bank whenever the open instance changes. Sticky session
  // memory wins (the letter reflects the last bank LOADED on this instance and
  // stays lit through close/reopen and later manual edits — matching
  // Soundgoodizer). With no session memory — e.g. a freshly loaded project, whose
  // node ids are new — fall back to matching the persisted engine state against
  // each bank snapshot, which is how the selection survives save/load.
  useEffect(() => {
    if (!isGloss || !target) { setActiveBank(null); return }
    const remembered = glossSelectedBank.get(nodeKey)
    if (remembered) { setActiveBank(remembered); setErrorText(null); return }
    let cancelled = false
    setActiveBank(null)
    setErrorText(null)
    ;(async () => {
      let live = null
      try {
        live = paramsListToMap(
          await window?.xleth?.audio?.getEffectParameters?.(target.trackId, target.nodeId),
        )
      } catch { live = null }
      if (cancelled || !live) return
      for (const bank of GLOSS_BANKS) {
        const bankParams = await loadBankParams(bank.slug)
        if (cancelled) return
        if (bankMatchesLive(bankParams, live)) {
          glossSelectedBank.set(nodeKey, bank.key)   // remember the derived match too
          setActiveBank(bank.key)
          return
        }
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGloss, nodeKey])

  // Load a bank through the preset system in one apply. The factory bank omits
  // bandmix, so AMOUNT is untouched by design. The choice is remembered for this
  // instance so it stays lit until another letter is picked (never unselected).
  const applyBank = useCallback(async (bank) => {
    if (!target || busy) return
    setBusy(true)
    setErrorText(null)
    try {
      const { after } = await loadPreset('apex', 'factory', bank.slug, target)
      applyPresetState(after)
      if (nodeKey) glossSelectedBank.set(nodeKey, bank.key)
      setActiveBank(bank.key)
    } catch (err) {
      setErrorText(err?.message || 'Failed to load bank')
    } finally {
      setBusy(false)
    }
  }, [target, busy, applyPresetState, nodeKey])

  if (!isGloss) return null

  const amountValue = Number.isFinite(amount) ? amount : AMOUNT_DEFAULT

  return (
    <div
      className="gloss-panel"
      style={{ left: panelPos.x, top: panelPos.y }}
      tabIndex={0}
    >
      <div className="gloss-header" onMouseDown={handleHeaderMouseDown}>
        <span className="gloss-title-tick" />
        <span className="gloss-title">GLOSS</span>
        <span className="gloss-sub">powered by APEX</span>
        <div className="gloss-header-actions">
          <button type="button" className="gloss-close" onClick={close} title="Close">
            <X size={13} />
          </button>
        </div>
      </div>

      <div className="gloss-body">
        <div className="gloss-amount">
          <PluginUIKitKnob
            value={amountValue}
            min={AMOUNT.min}
            max={AMOUNT.max}
            defaultValue={AMOUNT_DEFAULT}
            label="AMOUNT"
            formatValue={AMOUNT.fmt}
            onLiveChange={(nv) => previewParam(AMOUNT.id, nv)}
            onCommit={(nv) => commitParam(AMOUNT.id, nv)}
            size={132}
            dragRange={180}
            appearance={AMOUNT_APPEARANCE}
          />
          <div className="gloss-amount-value">{AMOUNT.fmt(amountValue)}</div>
        </div>

        <div className="gloss-banks" role="group" aria-label="Preset bank">
          {GLOSS_BANKS.map((bank) => (
            <button
              key={bank.key}
              type="button"
              className={`gloss-bank${activeBank === bank.key ? ' active' : ''}`}
              onClick={() => applyBank(bank)}
              disabled={busy}
              title={`Load bank ${bank.key}`}
            >
              {bank.key}
            </button>
          ))}
        </div>

        {errorText && (
          <div className="gloss-error" role="alert">{errorText}</div>
        )}
      </div>
    </div>
  )
}
