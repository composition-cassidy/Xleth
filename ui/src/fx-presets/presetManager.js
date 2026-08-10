// Renderer-side preset orchestration.
//
// Ties the three pieces together for the UI:
//   • the main-process file store (window.xleth.fxPresets.* IPC)
//   • the per-effect state adapters (capture / apply through the audio bridge)
//   • the preset schema validator (envelope + effectType mismatch guard)
//
// Bridge discipline: the four-layer bridge swallows undefined calls via optional
// chaining, so a wiring typo would fail silently. Every call here goes through
// requireFxPresetsBridge(), which throws a loud, named error if the namespace or
// method is missing — exactly the failure the task wants surfaced in testing.
//
// Undo model: loadPreset captures the full pre-load state through the adapter
// BEFORE applying, then applies the preset in one adapter.applyState call, and
// returns { before, after }. The caller records `before` as a single undo step;
// revertState(effectType, target, before) re-applies it in one call — so loading
// a preset (and undoing it) is one discrete action, never a per-parameter storm.

import { getPresetAdapter } from './effectPresetAdapters.js'
import { validatePreset, buildPreset } from './fxPresetSchema.js'

function requireFxPresetsBridge() {
  const fx = typeof window !== 'undefined' ? window?.xleth?.fxPresets : undefined
  if (!fx) throw new Error('[fxPresets] preload bridge (window.xleth.fxPresets) is not available')
  return fx
}

function requireMethod(fx, name) {
  const fn = fx[name]
  if (typeof fn !== 'function') throw new Error(`[fxPresets] bridge method "${name}" is not wired`)
  return fn
}

// ── Listing / grouping ────────────────────────────────────────────────────────

// Pure normalizer: take the store's { factory, user } (or a tolerant partial),
// drop malformed rows, and sort each group by display name. Exported so the
// factory/user grouping is unit-testable without touching IPC.
export function normalizePresetList(raw) {
  const pick = (arr, source) =>
    (Array.isArray(arr) ? arr : [])
      .filter(e => e && typeof e.slug === 'string' && typeof e.name === 'string')
      .map(e => ({
        slug: e.slug,
        name: e.name,
        author: typeof e.author === 'string' ? e.author : null,
        created: typeof e.created === 'string' ? e.created : null,
        effectType: typeof e.effectType === 'string' ? e.effectType : null,
        source,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  return {
    factory: pick(raw?.factory, 'factory'),
    user: pick(raw?.user, 'user'),
  }
}

export async function listPresets(effectType) {
  const fx = requireFxPresetsBridge()
  const raw = await requireMethod(fx, 'list')(effectType)
  return normalizePresetList(raw)
}

// ── Save ──────────────────────────────────────────────────────────────────────

// Capture the effect's current full state and write it as a named user preset.
// Returns { slug, overwritten } from the store.
export async function savePreset(effectType, name, target, { author } = {}) {
  if (!target) throw new Error('[fxPresets] cannot save a preset without an open effect target')
  const adapter = getPresetAdapter(effectType)
  const state = await adapter.captureState(target)
  const preset = buildPreset(effectType, name, state, author)
  const check = validatePreset(preset, effectType)
  if (!check.ok) throw new Error(`[fxPresets] refusing to save an invalid preset: ${check.errors[0]?.message}`)
  const fx = requireFxPresetsBridge()
  return requireMethod(fx, 'save')(preset)
}

// ── Load / apply ────────────────────────────────────────────────────────────

// Load a preset by (effectType, source, slug), validate it against the open
// effect (mismatch → thrown, never applied), capture the pre-load state, apply
// the preset, and return { before, after } for one-step undo. `after` is the
// preset's own state blob so the host can sync its UI without re-reading.
export async function loadPreset(effectType, source, slug, target) {
  if (!target) throw new Error('[fxPresets] cannot apply a preset without an open effect target')
  const fx = requireFxPresetsBridge()
  const preset = await requireMethod(fx, 'load')(effectType, source, slug)

  // Hard mismatch guard on the renderer side too, so a wrong-effect preset is
  // refused with a visible error even if the store is bypassed in a test.
  const check = validatePreset(preset, effectType)
  if (!check.ok) {
    const err = new Error(check.errors[0]?.message || 'Preset failed validation')
    err.code = check.errors[0]?.code
    throw err
  }

  const adapter = getPresetAdapter(effectType)
  const before = await adapter.captureState(target)
  await adapter.applyState(target, preset.state)
  return { before, after: preset.state, name: preset.name }
}

// Re-apply a previously captured state blob in one adapter call — the undo path.
export async function revertState(effectType, target, state) {
  if (!target || !state) return
  const adapter = getPresetAdapter(effectType)
  await adapter.applyState(target, state)
}

// ── Delete ────────────────────────────────────────────────────────────────────

export async function deletePreset(effectType, slug) {
  const fx = requireFxPresetsBridge()
  return requireMethod(fx, 'delete')(effectType, slug)
}
