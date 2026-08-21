// FX Chain Library — the seam between the mixer UI, the engine, and the folder
// of chain files on disk.
//
// Two collaborators, deliberately kept apart:
//   • window.xleth.audio  — capture a chain's live state / build a chain from a
//                           saved one. The apply RPC is ONE undoable engine
//                           command, so a library load or a drag-drop is a
//                           single global Ctrl+Z step.
//   • window.xleth.fxChains — the file store under userData/fx-chains.
//
// Everything here is plain async functions over those two. No React, no zustand:
// the menu calls in, gets a result, and shows a toast. Failures come back as
// { ok: false, error } rather than throwing, because every caller is a click
// handler and an unhandled rejection there is a silent no-op for the user.

import { EFFECT_CATEGORIES } from '../components/mixer/effectCatalog.js'
import {
  buildChainDocument,
  buildEffectsFromChain,
  describeChainDocumentProblem,
} from './chainDocument.js'

export const MASTER_FX_KEY = 'master'

const audio = () => (typeof window !== 'undefined' ? window?.xleth?.audio : undefined)
const store = () => (typeof window !== 'undefined' ? window?.xleth?.fxChains : undefined)

// fxKey ('master' | '3') → the trackId the audio RPCs take. Master has its own
// pair of methods, so callers branch on isMasterKey rather than passing -1.
export function isMasterKey(fxKey) {
  return String(fxKey) === MASTER_FX_KEY
}

function trackIdOf(fxKey) {
  return Number(fxKey)
}

function safeParse(raw, fallback) {
  if (raw == null) return fallback
  if (typeof raw !== 'string') return raw
  try { return JSON.parse(raw) } catch { return fallback }
}

function failure(error) {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

// ── Plugin availability ───────────────────────────────────────────────────────

// Every pluginId this machine can currently instantiate: the stock catalog plus
// whatever VST3s have been scanned. Used to warn about a chain BEFORE loading it
// instead of reporting a short chain afterwards.
export function buildAvailablePluginIds(vstPlugins = []) {
  const ids = new Set()
  for (const category of EFFECT_CATEGORIES) {
    for (const effect of category.submenu) ids.add(effect.id)
  }
  for (const plugin of Array.isArray(vstPlugins) ? vstPlugins : []) {
    if (plugin && typeof plugin.id === 'string') ids.add(plugin.id)
  }
  return ids
}

// ── Capture ───────────────────────────────────────────────────────────────────

// Read one chain's full live state as an ordered effects array.
//
// `chainSlots` is the ORDERED light view the mixer already holds
// (effectChainStore.chains[fxKey]); the snapshot RPC supplies each node's
// serialized parameter state and its live bypass flag. Passing the slots in
// rather than re-fetching them keeps this a single engine round trip and
// guarantees the saved order is exactly the order on screen.
export async function captureChainEffects(fxKey, chainSlots) {
  const a = audio()
  if (!a) return { ok: false, error: 'audio bridge unavailable' }

  try {
    const raw = isMasterKey(fxKey)
      ? await a.getMasterEffectChainSnapshot?.()
      : await a.getEffectChainSnapshot?.(trackIdOf(fxKey))
    const snapshot = safeParse(raw, null)
    // A missing snapshot is not fatal: the chain still saves its plugin list and
    // order, the effects just arrive at their defaults. Better than refusing.
    return { ok: true, effects: buildEffectsFromChain(chainSlots, snapshot) }
  } catch (e) {
    return failure(e)
  }
}

// ── Apply ─────────────────────────────────────────────────────────────────────

// Build a chain onto a track from an ordered effects array.
//   mode 'replace' — clear the target's chain first (the default)
//   mode 'append'  — add after the target's last effect
//
// Returns { ok, added, skipped: [pluginId], undoable } — `skipped` names the
// effects this machine could not instantiate, so the caller can say so.
export async function applyChainEffects(fxKey, effects, { label = '', mode = 'replace' } = {}) {
  const a = audio()
  if (!a) return { ok: false, error: 'audio bridge unavailable' }
  if (!Array.isArray(effects)) return { ok: false, error: 'no effects to apply' }

  const replace = mode !== 'append'
  const payload = JSON.stringify(effects)

  try {
    const raw = isMasterKey(fxKey)
      ? await a.applyMasterEffectChainPreset?.(payload, label, replace, true)
      : await a.applyEffectChainPreset?.(trackIdOf(fxKey), payload, label, replace, true)
    const result = safeParse(raw, null)
    if (!result || result.ok !== true) {
      return { ok: false, error: result?.reason ?? 'the engine rejected the chain' }
    }
    return {
      ok: true,
      added: Number.isInteger(result.added) ? result.added : effects.length,
      skipped: Array.isArray(result.skipped) ? result.skipped : [],
      effectCount: Number.isInteger(result.effectCount) ? result.effectCount : null,
      undoable: result.undoable === true,
    }
  } catch (e) {
    return failure(e)
  }
}

// ── File store ────────────────────────────────────────────────────────────────

// → { ok, chains: [meta], folders: [name], root }
// meta: { slug, folder, name, author, created, effectCount, pluginIds, hasStrip }
export async function listChains() {
  const s = store()
  if (!s) return { ok: false, error: 'chain library unavailable', chains: [], folders: [] }
  try {
    const result = await s.list()
    return {
      ok: true,
      chains: Array.isArray(result?.chains) ? result.chains : [],
      folders: Array.isArray(result?.folders) ? result.folders : [],
      root: typeof result?.root === 'string' ? result.root : '',
    }
  } catch (e) {
    return { ...failure(e), chains: [], folders: [] }
  }
}

export async function loadChain(folder, slug) {
  const s = store()
  if (!s) return { ok: false, error: 'chain library unavailable' }
  try {
    const doc = await s.load(folder ?? null, slug)
    const problem = describeChainDocumentProblem(doc)
    if (problem) return { ok: false, error: problem }
    return { ok: true, chain: doc }
  } catch (e) {
    return failure(e)
  }
}

// Capture the track's chain and write it to the library in one call.
// `strip` is passed through only when the user opted in to saving the fader,
// pan and width — omitting it is what marks a document as chain-only.
export async function saveChainFromTrack({
  fxKey,
  chainSlots,
  name,
  folder = null,
  strip = null,
  author = null,
} = {}) {
  const s = store()
  if (!s) return { ok: false, error: 'chain library unavailable' }

  const trimmed = String(name ?? '').trim()
  if (!trimmed) return { ok: false, error: 'give the chain a name' }

  const captured = await captureChainEffects(fxKey, chainSlots)
  if (!captured.ok) return captured
  if (captured.effects.length === 0) return { ok: false, error: 'this track has no effects to save' }

  const doc = buildChainDocument({ name: trimmed, effects: captured.effects, strip, author })

  try {
    const result = await s.save(doc, folder ?? null)
    return {
      ok: true,
      slug: result?.slug ?? null,
      folder: result?.folder ?? null,
      overwritten: result?.overwritten === true,
      effectCount: captured.effects.length,
    }
  } catch (e) {
    return failure(e)
  }
}

export async function deleteChain(folder, slug) {
  const s = store()
  if (!s) return { ok: false, error: 'chain library unavailable' }
  try {
    return { ok: (await s.delete(folder ?? null, slug)) === true }
  } catch (e) {
    return failure(e)
  }
}

// Reveal the library folder, creating it on first use so the button never opens
// nothing. Returns the path either way so a failure can name it in the toast.
export async function openLibraryFolder() {
  const s = store()
  if (!s) return { ok: false, error: 'chain library unavailable' }
  try {
    const result = await s.openFolder()
    return {
      ok: result?.ok !== false,
      root: typeof result?.root === 'string' ? result.root : '',
      error: result?.error ?? null,
    }
  } catch (e) {
    return failure(e)
  }
}

// ── Composite: load a saved chain onto a track ───────────────────────────────

// The one call the menu makes when a library entry is chosen: fetch the file,
// then build it onto the target. Kept together so the menu never has to
// sequence two async steps and handle a half-failure between them.
export async function applySavedChain(fxKey, folder, slug, { mode = 'replace' } = {}) {
  const loaded = await loadChain(folder, slug)
  if (!loaded.ok) return loaded

  const applied = await applyChainEffects(fxKey, loaded.chain.effects, {
    label: loaded.chain.name,
    mode,
  })
  if (!applied.ok) return applied

  return { ...applied, name: loaded.chain.name, strip: loaded.chain.strip ?? null }
}
