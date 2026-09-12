import { create } from 'zustand'

import useSandboxStore from './sandboxStore.js'

// ─── Source separation session store (P4-1) ────────────────────────────────
//
// Drives the Python/FastAPI separation sidecar through
// window.xleth.separation.* (ui/electron-main/separation.js). Nothing here
// touches the engine — the sidecar reads a WAV and writes WAVs, and the
// stems re-enter the workspace through sandboxStore.addSourceFromFile, the
// exact path an Explorer drop takes.
//
// ── Separation is a source generator, never an op ────────────────────────
// A stem is NOT an entry on a layer's op-stack. It is a new layer, with its
// own stack, its own undo, and no back-reference to the layer it came from.
// That is a deliberate model choice, not an implementation shortcut: an op
// has to be re-runnable from its parameters when anything upstream of it
// changes, and a two-minute GPU inference against a 65 MB weight is not that.
// Making it an op would mean every upstream param tweak silently queues
// another separation.
//
// ── One job at a time ────────────────────────────────────────────────────
// The sidecar can hold several, but the UI deliberately offers one: two
// concurrent runs on one machine are slower than the same two in sequence
// (they contend for the same GPU or the same cores), and a progress strip
// showing one bar is worth more than one showing three.

// Terminal job states, mirroring jobs.py's TERMINAL_STATES.
const TERMINAL = new Set(['done', 'cancelled', 'error'])

// Set once by ensureSubscribed(). Not store state: an unsubscribe function
// isn't serializable, and this is process-lifetime wiring, not session data.
let unsubscribeProgress = null

// ── Licence acknowledgement ────────────────────────────────────────────────
//
// The BALANCED model is CC BY-NC 4.0. The sidecar refuses it with a 409 until
// the caller says the condition has been accepted, and this is where that
// answer is remembered.
//
// localStorage, keyed by model id, and NOT a bare boolean: the text a user
// accepted is stored alongside, so a future edit to the licence terms asks
// again rather than inheriting consent to something they never read. Consent
// to a previous sentence is not consent to a new one.
const ACK_STORAGE_KEY = 'xleth.separation.licenseAcks'

// Session-scoped mirror of the same answers, and NOT an optimisation.
// localStorage can be unavailable outright — a private window, site data the
// browser refuses to hand over — and every read and write below swallows that
// and reports "not acknowledged". Without this mirror, accepting in such a
// window writes nothing, the retry asks again, and the user is in a loop with
// no way through. Consent given this session holds for this session; only
// persistence across restarts depends on storage.
const sessionAcks = new Map()

function readAcks() {
  try {
    const raw = window.localStorage?.getItem(ACK_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    // A private window, cleared site data, or storage the browser refuses to
    // hand over. Failing closed means the user is asked again — mildly
    // annoying, and the only safe direction.
    return {}
  }
}

function writeAck(modelId, text) {
  sessionAcks.set(modelId, text)
  try {
    const acks = readAcks()
    acks[modelId] = { text, at: Date.now() }
    window.localStorage?.setItem(ACK_STORAGE_KEY, JSON.stringify(acks))
  } catch {
    // Not fatal, and not a loop either — sessionAcks already holds it. The
    // user is asked again on the next app start, which is the honest outcome
    // when nothing could be persisted.
  }
}

function hasAcknowledged(modelId, text) {
  if (sessionAcks.get(modelId) === text) return true
  const entry = readAcks()[modelId]
  return !!entry && entry.text === text
}

function stemLayerName(baseName, stemName) {
  return `${baseName} [${stemName}]`
}

const useSeparationStore = create((set, get) => ({
  // ── Sidecar / environment ──────────────────────────────────────────────
  status: null,          // { running, device, python, modelsDir, stemsDir, lastError }
  statusState: 'idle',   // 'idle' | 'loading' | 'ready' | 'error'
  environment: null,     // deep probe result — only after checkEnvironment()
  environmentState: 'idle',

  // ── Manifest ───────────────────────────────────────────────────────────
  catalog: null,         // { models: [...], tiers: [...], device, diskUsageBytes }
  catalogState: 'idle',

  // ── Current job ────────────────────────────────────────────────────────
  job: null,             // the sidecar's own job dict, echoed verbatim
  jobError: null,
  // Layer the run was started from, so the stems can be named after it and
  // inserted next to it conceptually. Held separately from `job` because the
  // sidecar knows nothing about layers.
  sourceLayerId: null,
  sourceLayerName: '',
  // Job ids whose stems have already been imported. The progress poll can
  // deliver 'done' more than once (a final tick plus a manual getJob), and
  // importing twice would silently double every stem layer.
  importedJobs: [],
  importState: 'idle',   // 'idle' | 'importing' | 'done' | 'error'
  importedStems: [],     // [{ name, path, layerId }]
  // True between pressing a tier and the sidecar answering with a job id.
  // During that window `job` is null, so applyJobUpdate has no id to compare
  // against — and a late tick from the PREVIOUS run would be adopted as if it
  // were this one. See its guard below.
  starting: false,

  // ── Licence prompt ─────────────────────────────────────────────────────
  // The sidecar's 409 body when a model's licence carries a condition, plus
  // enough context to retry once the user answers. Null the rest of the time.
  //   { code, modelId, tier, spdx, licenseUrl, attribution, message, mode, pair }
  // `mode`/`pair` are only present for an ensemble retry — see acceptLicense.
  licensePrompt: null,

  // ── Advanced: ENSEMBLE + DE-BLEED ──────────────────────────────────────
  // Both are opt-in toggles, orthogonal to each other. ENSEMBLE replaces
  // "pick one tier" with "run two, sequentially, and average their common
  // stems" (see ensemble.average_stems); DE-BLEED is a post-pass that
  // composes with either a single tier OR an ensemble run.
  ensembleMode: false,
  // Two tier ids to combine. Null until the user (or the default below)
  // picks one — a button with nothing to run is worse than one that is not
  // shown yet.
  ensemblePair: null,
  deBleed: false,

  setEnsembleMode(on) {
    set({ ensembleMode: !!on })
  },
  setEnsemblePair(pair) {
    set({ ensemblePair: pair })
  },
  setDeBleed(on) {
    set({ deBleed: !!on })
  },

  // The tiers a pair CAN be drawn from: enabled, licence cleared (an
  // uncleared model cannot run alone, so it cannot run in an ensemble
  // either), and not the tier already broken by a missing runtime package.
  ensembleCandidates() {
    const catalog = get().catalog
    if (!catalog?.tiers?.length) return []
    return catalog.tiers.filter((t) => {
      if (!t.enabled) return false
      const model = t.modelId ? catalog.models?.find((m) => m.id === t.modelId) : null
      return !!model && model.license?.cleared !== false && model.runtimeOk !== false
    })
  },

  // ── Wiring ─────────────────────────────────────────────────────────────

  // Subscribe to main's progress feed. Idempotent — the panel mounts and
  // unmounts freely, and a second listener would double every update.
  ensureSubscribed() {
    if (unsubscribeProgress) return
    unsubscribeProgress = window.xleth?.separation?.onProgress?.((job) => {
      get().applyJobUpdate(job)
    }) ?? null
  },

  applyJobUpdate(job) {
    if (!job || !job.id) return
    // Ignore updates for a job we are no longer showing (a cancelled run's
    // last tick can land after the user started another).
    const current = get().job
    if (current && current.id !== job.id) return
    // No current job AND a start in flight: this tick belongs to a run the
    // user has already replaced. The new run's first tick is a poll interval
    // away, long after separateBuffer's reply has set `job`.
    if (!current && get().starting) return

    set({ job, jobError: job.state === 'error' ? (job.error || 'separation failed') : null })

    if (job.state === 'done' && !get().importedJobs.includes(job.id)) {
      get().importStems(job)
    }
  },

  // ── Status ─────────────────────────────────────────────────────────────

  // Cheap. Does NOT start the sidecar — the strip calls this on mount, and
  // booting Python (plus a torch import) to render three buttons would be a
  // multi-second stall for a user who may never press one.
  async refreshStatus() {
    if (get().statusState === 'loading') return get().status
    set({ statusState: 'loading' })
    try {
      const status = await window.xleth?.separation?.getStatus()
      set({ status, statusState: 'ready' })
      return status
    } catch (e) {
      set({ status: null, statusState: 'error' })
      console.warn('[Separation] getStatus failed:', e?.message || e)
      return null
    }
  },

  // Expensive: spawns a Python to check imports. Only from the "why is this
  // unavailable?" affordance.
  async checkEnvironment() {
    set({ environmentState: 'loading' })
    try {
      const environment = await window.xleth?.separation?.checkEnvironment()
      set({ environment, environmentState: 'ready' })
      return environment
    } catch (e) {
      set({ environment: null, environmentState: 'error' })
      return null
    }
  },

  // Starts the sidecar (that is what makes it expensive) and reads the
  // manifest, including per-model store presence and license status.
  async loadCatalog() {
    if (get().catalogState === 'loading') return get().catalog
    set({ catalogState: 'loading' })
    try {
      const catalog = await window.xleth?.separation?.listModels()
      set({ catalog, catalogState: 'ready' })
      get().refreshStatus()
      return catalog
    } catch (e) {
      set({ catalog: null, catalogState: 'error' })
      console.warn('[Separation] listModels failed:', e?.message || e)
      return null
    }
  },

  // ── Running ────────────────────────────────────────────────────────────

  // Separate the ACTIVE layer's rendered buffer.
  //
  // The rendered buffer, not the layer's source file: it is what the user is
  // looking at and hearing, with the op-stack applied. Someone who trimmed a
  // layer to one phrase and then pressed FAST means that phrase, and handing
  // the sidecar the untrimmed source file would quietly separate two minutes
  // of audio they did not ask about.
  async separateActiveLayer(tier = 'fast') {
    const sandbox = useSandboxStore.getState()
    const layer = sandbox.layers.find((l) => l.id === sandbox.activeLayerId) ?? null
    if (!layer) {
      set({ jobError: 'Select a layer to separate.' })
      return null
    }
    const buffer = layer.renderedBuffer
    if (!buffer?.channels?.length || layer.renderState !== 'ready') {
      set({ jobError: 'This layer has not finished rendering yet.' })
      return null
    }

    // Answer the licence question up front when it has already been answered
    // for this exact text. The sidecar is the gate — this only saves the user
    // from being asked the same thing on every run.
    const model = get().modelForTier(tier)
    const ackText = model?.license?.requiresAcknowledgement
      ? model.license.acknowledgement
      : null
    const acknowledgeLicense = !!ackText && hasAcknowledged(model.id, ackText)

    get().ensureSubscribed()
    set({
      job: null,
      jobError: null,
      licensePrompt: null,
      starting: true,
      importState: 'idle',
      importedStems: [],
      sourceLayerId: layer.id,
      sourceLayerName: layer.name || `Layer ${layer.id}`,
    })

    try {
      const result = await window.xleth?.separation?.separateBuffer({
        sampleRate: buffer.sampleRate,
        channels: buffer.channels,
        name: layer.name || `Layer ${layer.id}`,
        tier,
        acknowledgeLicense,
        deBleed: get().deBleed,
      })

      // Not a failure — a question. Nothing was downloaded and no job exists;
      // the user answers and acceptLicense() retries.
      if (result?.licenseRequired) {
        set({ job: null, starting: false, licensePrompt: { ...result.licenseRequired, tier } })
        return null
      }

      set({ job: result, jobError: null, starting: false })
      return result
    } catch (e) {
      const message = e?.message || String(e)
      set({ job: null, jobError: message, starting: false })
      console.warn('[Separation] separateBuffer failed:', message)
      return null
    }
  },

  // ENSEMBLE: the same shape as separateActiveLayer, but naming two model
  // ids instead of one tier. Kept as its own action rather than folding a
  // "pair" branch into separateActiveLayer — the two request shapes genuinely
  // differ (a tier string vs a two-id array), and a single function juggling
  // both reads worse than two short ones.
  async separateActiveLayerEnsemble() {
    const pair = get().ensemblePair
    if (!pair || pair.length !== 2) {
      set({ jobError: 'Pick two tiers to combine.' })
      return null
    }
    const sandbox = useSandboxStore.getState()
    const layer = sandbox.layers.find((l) => l.id === sandbox.activeLayerId) ?? null
    if (!layer) {
      set({ jobError: 'Select a layer to separate.' })
      return null
    }
    const buffer = layer.renderedBuffer
    if (!buffer?.channels?.length || layer.renderState !== 'ready') {
      set({ jobError: 'This layer has not finished rendering yet.' })
      return null
    }

    const models = pair.map((tierId) => get().modelForTier(tierId))
    if (models.some((m) => !m)) {
      set({ jobError: 'One of the selected tiers has no model to run.' })
      return null
    }
    // Every model in the pair must have its OWN condition acknowledged — an
    // ensemble is only as answered-for as its more restricted half, the same
    // rule the sidecar enforces server-side.
    const acknowledgeLicense = models.every((m) => (
      !m.license?.requiresAcknowledgement || hasAcknowledged(m.id, m.license.acknowledgement)
    ))

    get().ensureSubscribed()
    set({
      job: null,
      jobError: null,
      licensePrompt: null,
      starting: true,
      importState: 'idle',
      importedStems: [],
      sourceLayerId: layer.id,
      sourceLayerName: layer.name || `Layer ${layer.id}`,
    })

    try {
      const result = await window.xleth?.separation?.separateBuffer({
        sampleRate: buffer.sampleRate,
        channels: buffer.channels,
        name: layer.name || `Layer ${layer.id}`,
        ensembleModelIds: models.map((m) => m.id),
        acknowledgeLicense,
        deBleed: get().deBleed,
      })

      if (result?.licenseRequired) {
        set({ job: null, starting: false,
              licensePrompt: { ...result.licenseRequired, mode: 'ensemble', pair } })
        return null
      }

      set({ job: result, jobError: null, starting: false })
      return result
    } catch (e) {
      const message = e?.message || String(e)
      set({ job: null, jobError: message, starting: false })
      console.warn('[Separation] ensemble separateBuffer failed:', message)
      return null
    }
  },

  // The user accepted the licence condition in the strip. Remember it against
  // the exact text they saw, then re-run whatever they originally pressed —
  // a single tier, or the ensemble pair.
  async acceptLicense() {
    const prompt = get().licensePrompt
    if (!prompt) return null
    writeAck(prompt.modelId, prompt.message)
    set({ licensePrompt: null })
    if (prompt.mode === 'ensemble') return get().separateActiveLayerEnsemble()
    return get().separateActiveLayer(prompt.tier)
  },

  declineLicense() {
    set({ licensePrompt: null })
  },

  // ── Catalog helpers ────────────────────────────────────────────────────

  modelForTier(tierId) {
    const catalog = get().catalog
    const tier = catalog?.tiers?.find((t) => t.id === tierId)
    if (!tier?.modelId) return null
    return catalog.models?.find((m) => m.id === tier.modelId) ?? null
  },

  // The tier buttons, straight from the manifest rather than a list hardcoded
  // here. When the manifest is the only place a tier's model, licence and
  // speed are written down, a UI that keeps its own copy is a second source of
  // truth that goes stale the first time one of them changes.
  tiers() {
    const catalog = get().catalog
    if (!catalog?.tiers?.length) return []
    return catalog.tiers.map((tier) => {
      const model = tier.modelId
        ? catalog.models?.find((m) => m.id === tier.modelId) ?? null
        : null
      return { ...tier, model }
    })
  },

  async cancel() {
    const job = get().job
    if (!job || TERMINAL.has(job.state)) return false
    try {
      await window.xleth?.separation?.cancel(job.id)
      return true
    } catch (e) {
      console.warn('[Separation] cancel failed:', e?.message || e)
      return false
    }
  },

  // ── Stems → layers ─────────────────────────────────────────────────────

  async importStems(job) {
    if (!job?.stems?.length) {
      set({ importState: 'done', importedStems: [] })
      return []
    }
    // Claim the job id BEFORE the first await. Two 'done' updates arriving
    // back to back would otherwise both pass the guard in applyJobUpdate and
    // each add a full set of stem layers.
    if (get().importedJobs.includes(job.id)) return []
    set((state) => ({ importedJobs: [...state.importedJobs, job.id], importState: 'importing' }))

    const base = get().sourceLayerName || job.label || 'Separation'
    const addSourceFromFile = useSandboxStore.getState().addSourceFromFile
    const imported = []
    try {
      for (const stem of job.stems) {
        const name = stemLayerName(base, stem.name)
        // Sequential, not Promise.all: each add takes an engine round trip
        // that mints a SampleBank id and opens a layer, and firing them
        // together interleaves two workspace mutations for no real gain.
        const layer = await addSourceFromFile(stem.path, name)
        imported.push({ name: stem.name, path: stem.path, layerId: layer?.id ?? null })
      }
      set({ importState: 'done', importedStems: imported })
      return imported
    } catch (e) {
      console.warn('[Separation] stem import failed:', e?.message || e)
      set({ importState: 'error', importedStems: imported,
            jobError: `Stems finished but could not be added: ${e?.message || e}` })
      return imported
    }
  },

  clearJob() {
    set({ job: null, jobError: null, licensePrompt: null, starting: false,
          importState: 'idle', importedStems: [] })
  },
}))

export default useSeparationStore
export {
  TERMINAL as SEPARATION_TERMINAL_STATES,
  ACK_STORAGE_KEY,
  hasAcknowledged,
  stemLayerName,
}
