import { useEffect } from 'react'

import useSandboxStore from '../../stores/sandboxStore.js'
import useSeparationStore, { SEPARATION_TERMINAL_STATES } from '../../stores/separationStore.js'
import { Button, Checkbox, IconButton, Progress, Select } from '../../ui-kit'
import styles from './Sandbox.module.css'
import { iconComponent } from '../../ui-kit/icons'

const IcInfo = iconComponent('info')
const IcShieldWarning = iconComponent('shield-warning')
const IcSliders = iconComponent('sliders')
const IcWaveform = iconComponent('waveform')
const IcX = iconComponent('x')

// Bottom strip — tiered vocal separation (P4) progress/license/advanced UI.
// The tier BUTTONS themselves (FAST/BALANCED/BEST) now live in
// SandboxMenuBar's EFFECT ▾ → SEPARATE section, reusing this file's exported
// tierTitle/estimateSeconds/formatDuration/FALLBACK_TIERS so the tooltip
// wording has one source of truth. This strip is mounted only while there is
// something to show — a running job, a licence prompt, an error, or the
// advanced (ENSEMBLE/DE-BLEED) panel — see SandboxPanelContent.jsx.
//
// FAST is MDX-Net Kim Vocal 2; BALANCED is Mel-Band RoFormer "deux"; BEST is
// BS-Roformer FT1 (anvuew). BEST's code is wired and verified, but its
// licence audit never closed — the model's only card content is a bare
// "gpl-3.0" tag, no third-party-use statement, unlike the other two — so its
// menu entry stays present but disabled with the reason shown, exactly the
// same shape as a runtime-package gap. A control that starts a run against a
// model nobody has cleared is worse than one that says why it will not.
//
// The tier data comes from the MANIFEST, not from a list in this file. The
// manifest is where a tier's model, licence, device and speed are written down,
// and a UI holding its own copy is a second source of truth that goes stale the
// first time one of them changes. FALLBACK_TIERS exists only for the window
// before the sidecar has been started — reading the manifest means starting
// Python, and a user who never presses a tier should not pay for that.
//
// Two things this strip has to get right and used not to:
//
//   * DEVICE IS PER TIER. MDX-Net infers in onnxruntime and Mel-Band RoFormer
//     in torch, and the project's own requirements pin CPU torch alongside a
//     CUDA onnxruntime. On that ordinary install FAST is on the GPU and
//     BALANCED is not, and one device chip would be a six-fold lie about one
//     of them.
//   * SO IS THE ESTIMATE. The same CPU runs FAST at 0.33x realtime and
//     BALANCED at 3.1x plus a 40-second fixed cost. Quoting one figure for
//     both is how a nine-minute job looks like a hang.

/** "BALANCED" -> "Balanced" */
const sentence = (v) => (v ? String(v).charAt(0).toUpperCase() + String(v).slice(1).toLowerCase() : v)

export const FALLBACK_TIERS = [
  { id: 'fast', label: 'FAST', enabled: true, hint: 'MDX-Net Kim Vocal 2 — vocals + instrumental' },
  { id: 'balanced', label: 'BALANCED', enabled: true, hint: 'Mel-Band RoFormer “deux” — cleaner, much slower' },
  { id: 'best', label: 'BEST', enabled: true, hint: 'BS-Roformer FT1 — licence audit not yet closed' },
]

const PHASE_LABEL = {
  queued: 'Queued',
  downloading: 'Downloading model',
  verifying: 'Verifying model',
  loading: 'Loading model',
  separating: 'Separating',
  writing: 'Writing stems',
}

// Exported for SandboxMenuBar's SEPARATE submenu, which needs the exact same
// "about Xs on this device" / "first run downloads Y" / licence-notice
// tooltip text this strip already computes — one source of truth for the
// wording rather than a second copy drifting out of sync.
export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return null
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}m ${String(s).padStart(2, '0')}s`
}

export function formatBytes(bytes) {
  if (!bytes) return null
  return bytes >= 1024 * 1024 * 1024
    ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 / 1024)} MB`
}

// Estimated wall clock for `durationSec` of audio on a model, from the
// manifest's own figures. Two terms, not one: `fixedSeconds` is the reflected
// padding the model processes regardless of input length — 40 s on
// BALANCED/CPU, which IS the job for a five-second sample.
export function estimateSeconds(model, durationSec) {
  if (!model || !durationSec || !Number.isFinite(model.secondsPerSecond)) return null
  return (model.fixedSeconds || 0) + durationSec * model.secondsPerSecond
}

export function tierTitle(tier, model, durationSec, blocked) {
  if (blocked) return blocked
  if (!tier.enabled) return tier.planned ? `Not wired yet — ${tier.planned}` : tier.hint
  const parts = [tier.hint || model?.name].filter(Boolean)
  const estimate = formatDuration(estimateSeconds(model, durationSec))
  if (estimate && model?.device) {
    parts.push(`about ${estimate} on ${model.device}`
      + (model.speedMeasured ? '' : ' (estimated — no measured figure for this device)'))
  }
  if (model && !model.store?.present) {
    const size = formatBytes(model.sizeBytes)
    if (size) parts.push(`first run downloads ${size}`)
  }
  if (model?.license?.commercialUse === false) {
    parts.push(`${model.license.spdx} — non-commercial use only`)
  }
  return parts.join(' · ')
}

// `advancedOpen`/`onToggleAdvanced` are controlled from SandboxPanelContent
// (not local state) — this strip is now mounted only while something is
// worth showing (a running job, a licence prompt, an error, or the advanced
// panel itself), and the button that opens the advanced panel lives in
// SandboxMenuBar's EFFECT ▾ → SEPARATE section instead of in this row, so it
// stays reachable even while the strip itself is unmounted.
export default function SandboxSeparationStrip({ advancedOpen, onToggleAdvanced }) {
  const layers = useSandboxStore((s) => s.layers)
  const activeLayerId = useSandboxStore((s) => s.activeLayerId)

  const status = useSeparationStore((s) => s.status)
  const statusState = useSeparationStore((s) => s.statusState)
  const environment = useSeparationStore((s) => s.environment)
  const environmentState = useSeparationStore((s) => s.environmentState)
  const catalog = useSeparationStore((s) => s.catalog)
  const job = useSeparationStore((s) => s.job)
  const jobError = useSeparationStore((s) => s.jobError)
  const licensePrompt = useSeparationStore((s) => s.licensePrompt)
  const importState = useSeparationStore((s) => s.importState)
  const importedStems = useSeparationStore((s) => s.importedStems)
  const refreshStatus = useSeparationStore((s) => s.refreshStatus)
  const checkEnvironment = useSeparationStore((s) => s.checkEnvironment)
  const loadCatalog = useSeparationStore((s) => s.loadCatalog)
  const ensureSubscribed = useSeparationStore((s) => s.ensureSubscribed)
  const acceptLicense = useSeparationStore((s) => s.acceptLicense)
  const declineLicense = useSeparationStore((s) => s.declineLicense)
  const cancel = useSeparationStore((s) => s.cancel)
  const clearJob = useSeparationStore((s) => s.clearJob)

  // ── Advanced: ENSEMBLE + DE-BLEED ──────────────────────────────────────
  const ensembleMode = useSeparationStore((s) => s.ensembleMode)
  const setEnsembleMode = useSeparationStore((s) => s.setEnsembleMode)
  const ensemblePair = useSeparationStore((s) => s.ensemblePair)
  const setEnsemblePair = useSeparationStore((s) => s.setEnsemblePair)
  const ensembleCandidates = useSeparationStore((s) => s.ensembleCandidates)
  const separateActiveLayerEnsemble = useSeparationStore((s) => s.separateActiveLayerEnsemble)
  const deBleed = useSeparationStore((s) => s.deBleed)
  const setDeBleed = useSeparationStore((s) => s.setDeBleed)

  const layer = layers.find((l) => l.id === activeLayerId) ?? null
  const layerReady = !!layer && layer.renderState === 'ready' && !!layer.renderedBuffer
  const buffer = layerReady ? layer.renderedBuffer : null
  const durationSec = buffer?.channels?.[0]?.length && buffer.sampleRate
    ? buffer.channels[0].length / buffer.sampleRate
    : null

  // Probe on every mount, not just the first. The old `statusState === 'idle'`
  // guard latched: a probe that failed once (opening the panel mid-startup,
  // say) left the strip reporting "unavailable" for the rest of the session
  // with nothing to retrigger it. refreshStatus is a plain IPC round trip and
  // de-dupes its own in-flight call.
  useEffect(() => {
    ensureSubscribed()
    refreshStatus()
  }, [ensureSubscribed, refreshStatus])

  // Read the manifest once the sidecar is up anyway — that is where each
  // model's licence, device and speed come from, and the credit condition on
  // a weight is only honoured if it is actually shown.
  useEffect(() => {
    if (status?.running && !catalog) loadCatalog()
  }, [status?.running, catalog, loadCatalog])

  const ensembleCandidateTiers = ensembleCandidates()
  const candidateIds = ensembleCandidateTiers.map((t) => t.id).join(',')

  // Default the pair to the first two runnable tiers as soon as there are
  // enough of them — a checkbox that reveals two empty dropdowns is not a
  // usable feature. Only fires while nothing has been picked yet, so it
  // never overwrites a user's own choice.
  useEffect(() => {
    if (!ensemblePair && ensembleCandidateTiers.length >= 2) {
      setEnsemblePair([ensembleCandidateTiers[0].id, ensembleCandidateTiers[1].id])
    }
    // candidateIds (not the array itself) keeps this from re-running every
    // render just because the derived list is a fresh array reference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ensemblePair, candidateIds, setEnsemblePair])

  const running = !!job && !SEPARATION_TERMINAL_STATES.has(job.state)
  const pythonMissing = statusState === 'ready' && !status?.python
  // The sidecar can be up and still unable to separate anything — a Python
  // with fastapi but no torch starts and serves happily. This is the CORE
  // runtime, which every tier needs; a package only one tier needs is handled
  // per button in reasonFor. `runtimeOk` is null until the sidecar has been
  // asked, and only a definite false blocks.
  const runtimeBroken = status?.runtimeOk === false
  const missingPackages = status?.missing?.length ? status.missing.join(', ') : null

  const tiers = catalog?.tiers?.length
    ? catalog.tiers.map((t) => ({
      ...t,
      model: t.modelId ? catalog.models?.find((m) => m.id === t.modelId) ?? null : null,
    }))
    : FALLBACK_TIERS.map((t) => ({ ...t, model: null }))

  // A reason that applies to EVERY tier. Anything specific to one model — its
  // packages, its licence — is decided per button below, so a broken BALANCED
  // install never disables a working FAST.
  const globalReason = pythonMissing
    ? 'Python 3.9+ with the sidecar requirements is not installed'
    : runtimeBroken
      ? `Sidecar is missing ${missingPackages || 'required packages'}`
      : !layer
      ? 'Select a layer to separate'
      : !layerReady
        ? 'Waiting for this layer to finish rendering'
        : running
          ? 'A separation is already running'
          : null

  function reasonFor(tier) {
    if (globalReason) return globalReason
    if (!tier.enabled) return null       // the button says so itself
    const model = tier.model
    if (model && model.runtimeOk === false) {
      const missing = model.missing?.length ? model.missing.join(', ') : 'required packages'
      // No repo-relative path here. Most people running this installed an
      // .exe and have never seen the source tree, so naming a file inside it
      // is worse than saying nothing. XLETH bundles its own Python runtime;
      // if a package is missing from it, the install is damaged.
      return `${tier.label} needs ${missing} — XLETH's bundled runtime looks incomplete, reinstalling should fix it`
    }
    // A wired tier whose weight the license gate refuses (PENDING-AUDIT and
    // anything else outside CLEARED_STATUSES). Caught here rather than left
    // for the sidecar's 403: a button that is disabled with a reason is a
    // better experience than one that starts a run and immediately errors,
    // and it matches how a missing runtime package is already handled above.
    if (model && model.license && model.license.cleared === false) {
      return `${tier.label}'s model (${model.license.spdx || 'licence'}) has not cleared its audit — see NOTICE-separation-models.md`
    }
    return null
  }

  // Every credit line we are obliged to show, for the tiers that can actually
  // run. Not just the active one: the condition attaches to whichever weight
  // is used, and a footnote that only appears mid-run is a footnote nobody
  // reads before choosing.
  const attributions = tiers
    .filter((t) => t.enabled && t.model?.license?.attribution)
    .map((t) => t.model.license.attribution)

  // The "what will this cost" line. Only when a layer is actually ready —
  // an estimate with no input to scale is a made-up number.
  const estimates = durationSec
    ? tiers
      .filter((t) => t.enabled && t.model?.device && !reasonFor(t))
      .map((t) => {
        const secs = formatDuration(estimateSeconds(t.model, durationSec))
        if (!secs) return null
        return `${t.label} ${t.model.speedMeasured ? '' : '~'}${secs} on ${t.model.device}`
      })
      .filter(Boolean)
    : []

  const tierOptions = ensembleCandidateTiers.map((t) => ({ value: t.id, label: sentence(t.label) }))

  return (
    <div className={styles.sep}>
      <div className={styles.sepRow}>
        <span className={styles.sepTitle}>
          <IcWaveform size={14} aria-hidden="true" />
          Separate{running && job?.tier ? `: ${sentence(job.tier)}` : ''}
        </span>

        <IconButton
          size="sm"
          label="Advanced separation options"
          pressed={advancedOpen}
          onClick={onToggleAdvanced}
          data-sep-advanced-toggle=""
          hint="Advanced separation"
          hintMods="Ensemble (average two models) and de-bleed (reduce cross-talk between stems)"
        >
          <IcSliders />
        </IconButton>

        <div className={styles.divider} />

        {running ? (
          <>
            <div className={styles.sepProgress} title={job.detail || ''}>
              <Progress
                label="Separation progress"
                value={job.progress ?? 0}
                text={`${PHASE_LABEL[job.phase] ?? job.phase}${job.detail ? `: ${job.detail}` : ''}`}
              />
            </div>
            {formatDuration(job.etaSeconds) && (
              <span className={styles.sepMeta}>
                {job.etaMeasured ? '' : '~'}{formatDuration(job.etaSeconds)} left
              </span>
            )}
            <Button size="sm" glyph={<IcX />} onClick={() => cancel()} hint="Cancel this separation">
              Cancel separation
            </Button>
          </>
        ) : (
          <span className={styles.sepStatus} data-sep-status="">
            {jobError
              ? <span className={styles.sepError} data-sep-error="">{jobError}</span>
              : job?.state === 'cancelled'
                ? 'Cancelled'
                : importState === 'done' && importedStems.length
                  ? `Added ${importedStems.length} stem${importedStems.length === 1 ? '' : 's'} as layers: ${importedStems.map((st) => st.name).join(', ')}`
                  : globalReason
                    || (estimates.length ? estimates.join('  ·  ') : 'Stems are added as new layers')}
          </span>
        )}

        <div className={styles.spacer} />

        {job?.device && (
          <span className={styles.sepDevice} title="Compute device the sidecar selected for this model">
            {job.device}
          </span>
        )}
        {!running && (job || jobError) && (
          <Button size="sm" onClick={clearJob} hint="Clear this result">Clear result</Button>
        )}
      </div>

      {/*
        Advanced: ensemble and de-bleed. Both opt-in, both orthogonal to the
        tier entries in the Effect menu: choosing a tier still runs a single
        model, this row is the alternate "run two and average" path plus a
        post-pass that composes with either one.
      */}
      {advancedOpen && (
        <div className={`${styles.sepRow} ${styles.sepAdvanced}`} data-sep-advanced="">
          <Checkbox checked={deBleed} onChange={setDeBleed}>De-bleed</Checkbox>
          <span className={styles.sepMeta}>reduce cross-talk between the two stems after separation</span>

          <div className={styles.divider} />

          <Checkbox
            checked={ensembleMode}
            disabled={ensembleCandidateTiers.length < 2}
            onChange={setEnsembleMode}
          >
            Ensemble
          </Checkbox>

          {ensembleMode && ensembleCandidateTiers.length >= 2 ? (
            <>
              <Select
                size="sm" ariaLabel="First ensemble model" options={tierOptions}
                value={ensemblePair?.[0] || ''}
                onChange={(v) => setEnsemblePair([v, ensemblePair?.[1] || ''])}
              />
              <span className={styles.sepMeta}>+</span>
              <Select
                size="sm" ariaLabel="Second ensemble model" options={tierOptions}
                value={ensemblePair?.[1] || ''}
                onChange={(v) => setEnsemblePair([ensemblePair?.[0] || '', v])}
              />
              <Button
                size="sm"
                disabled={!!globalReason || !ensemblePair || ensemblePair[0] === ensemblePair[1]}
                onClick={() => separateActiveLayerEnsemble()}
                hint="Run ensemble"
                hintMods="Run both models and average their common stems"
              >
                Run ensemble
              </Button>
            </>
          ) : (
            <span className={styles.sepMeta}>
              {ensembleCandidateTiers.length < 2
                ? 'needs two runnable tiers'
                : 'average two different models’ stems, sample-aligned'}
            </span>
          )}
        </div>
      )}

      {/*
        The licence gate. This is a question, not an error: the sidecar refused
        with a 409 and nothing has been downloaded. The user's answer is what
        the run needs, and it is remembered against the exact text shown here
        so a later change to the terms asks again rather than inheriting
        consent to something they never read.
      */}
      {licensePrompt && (
        <div className={styles.sepRow} data-sep-license="">
          <IcShieldWarning size={14} aria-hidden="true" />
          <span className={styles.sepLicenseText}>{licensePrompt.message}</span>
          {licensePrompt.licenseUrl && (
            <a
              className={styles.sepLink}
              href={licensePrompt.licenseUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              Read {licensePrompt.spdx || 'the licence'}
            </a>
          )}
          <Button size="sm" variant="primary" data-sep-license-accept="" onClick={() => acceptLicense()}>
            I understand, continue
          </Button>
          <Button size="sm" onClick={declineLicense}>Not now</Button>
        </div>
      )}

      {(attributions.length > 0 || pythonMissing || runtimeBroken) && (
        <div className={styles.sepFootnote}>
          <IcInfo size={14} aria-hidden="true" />
          {runtimeBroken && !pythonMissing ? (
            <span className={styles.sepError} data-sep-error="">
              {status.runtimeError
                || `The separation sidecar is missing ${missingPackages}. XLETH's bundled runtime looks incomplete — reinstalling should fix it.`}
            </span>
          ) : pythonMissing ? (
            <>
              {/*
                Reached only when the bundled runtime is absent AND no system
                interpreter could stand in: a damaged install, or a source
                checkout where build_sidecar_runtime.py has not been run. Not
                the everyday state it used to be, when separation required the
                user to install Python themselves.
              */}
              <span>
                XLETH&rsquo;s bundled Python runtime is missing, so separation
                cannot start. Reinstalling XLETH restores it.
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => checkEnvironment()}
                disabled={environmentState === 'loading'}
              >
                {environmentState === 'loading' ? 'Checking…' : 'Check environment'}
              </Button>
              {environment?.error && <span className={styles.sepError} data-sep-error="">{environment.error}</span>}
            </>
          ) : (
            // These weights are licensed on condition of credit. Showing the
            // lines here is what actually satisfies that condition — see the
            // license blocks in
            // tools/separation_sidecar/xleth_separation/models.json.
            <span>{attributions.join('  ·  ')}</span>
          )}
        </div>
      )}
    </div>
  )
}
