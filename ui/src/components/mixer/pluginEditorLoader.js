// Third-party plugin loading screen: the state behind PluginLoadingDialog.
//
// Inserting a scanned plugin and opening its editor are both slow: the engine
// loads the plugin DLL, then a separate xleth-editor-host process loads it
// again cold and builds the window. openPluginEditor returns as soon as that
// host is launched, so this module polls getPluginEditorStatus until the window
// is up (or the host died) while the dialog shows what is happening.
//
// One load at a time. While one is adding or opening, another request is a
// repeat click (the frustrated spam-click that used to queue a cold load per
// click) and is dropped. A failed load is only a message, so a new request
// replaces it.

import { create } from 'zustand'
import useVstStore from '../../stores/vstStore.js'
import { STOCK_EFFECT_IDS } from './effectCatalog.js'

// job: null | {
//   id, pluginId, name, vendor, trackId, nodeId (null until added),
//   phase: 'adding' | 'opening' | 'failed', withAddStep (began by inserting),
//   startedAt, openedAt (ms, null until the editor open starts),
//   visible (false for the first SHOW_AFTER_MS so an instant open never flashes),
//   error (failed only), audio (the API the job talks to)
// }
export const usePluginLoadStore = create(() => ({ job: null }))

const SHOW_AFTER_MS = 250
const POLL_MS = 150

let nextJobId = 1

export function isThirdPartyPluginId(pluginId) {
  return typeof pluginId === 'string' && pluginId.length > 0
    && pluginId !== 'placeholder' && !STOCK_EFFECT_IDS.has(pluginId)
}

function defaultAudio() {
  return globalThis.window?.xleth?.audio
}

function currentJob(id) {
  const job = usePluginLoadStore.getState().job
  return job && job.id === id ? job : null
}

function patchJob(id, patch) {
  usePluginLoadStore.setState((s) => (s.job?.id === id ? { job: { ...s.job, ...patch } } : s))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Start a load and show the loading screen. Returns the job id, or null when
 * another plugin is still adding/opening (the caller must then do nothing).
 */
export function beginPluginLoad({ pluginId, trackId, nodeId = null, phase = 'adding', audio = defaultAudio() }) {
  const active = usePluginLoadStore.getState().job
  if (active && active.phase !== 'failed') return null

  const plugin = useVstStore.getState().plugins.find((p) => p?.id === pluginId)
  const id = nextJobId++
  const now = Date.now()
  usePluginLoadStore.setState({
    job: {
      id,
      pluginId,
      name: plugin?.name || 'Plugin',
      vendor: plugin?.vendor || '',
      trackId,
      nodeId,
      phase,
      withAddStep: phase === 'adding',
      startedAt: now,
      openedAt: phase === 'opening' ? now : null,
      visible: false,
      error: null,
      audio,
    },
  })
  setTimeout(() => patchJob(id, { visible: true }), SHOW_AFTER_MS)
  return id
}

/** The insert failed: keep the screen up with the reason. */
export function failPluginLoad(id, error) {
  if (currentJob(id)) patchJob(id, { phase: 'failed', error, visible: true })
}

/**
 * The plugin is in the chain as engine node `nodeId`: open its editor and wait
 * until the window is up. Ends the job on success, marks it failed otherwise.
 */
export async function openEditorForLoad(id, nodeId) {
  const job = currentJob(id)
  if (!job) return
  patchJob(id, { phase: 'opening', nodeId, openedAt: Date.now(), error: null })
  const { audio, trackId } = job

  let opened
  try {
    opened = await audio?.openPluginEditor?.(trackId, nodeId)
  } catch (e) {
    failPluginLoad(id, e?.message || 'editor-host-error')
    return
  }
  if (!currentJob(id)) return
  if (!opened?.hasEditor) {
    failPluginLoad(id, opened?.error || 'editor-host-error')
    return
  }

  // An addon older than the status RPC only returns once the window is up.
  if (typeof audio.getPluginEditorStatus !== 'function') {
    usePluginLoadStore.setState({ job: null })
    return
  }

  while (currentJob(id)) {
    let status = null
    try { status = await audio.getPluginEditorStatus(trackId, nodeId) } catch { /* engine busy: poll again */ }
    if (!currentJob(id)) return
    if (status?.status === 'open') {
      usePluginLoadStore.setState({ job: null })
      return
    }
    if (status?.status === 'failed' || status?.status === 'closed') {
      failPluginLoad(id, status.error || 'closed')
      return
    }
    await sleep(POLL_MS)
  }
}

/**
 * Open an already-inserted plugin's editor behind the loading screen.
 * Returns false when another plugin is still loading (a repeat click).
 */
export function openPluginEditorWithLoading({ trackId, nodeId, pluginId, audio = defaultAudio() }) {
  const id = beginPluginLoad({ pluginId, trackId, nodeId, phase: 'opening', audio })
  if (id == null) return false
  void openEditorForLoad(id, nodeId)
  return true
}

/** Cancel: close the screen and stop an editor that is still opening. The plugin stays inserted. */
export function cancelPluginLoad() {
  const job = usePluginLoadStore.getState().job
  if (!job) return
  usePluginLoadStore.setState({ job: null })
  if (job.phase === 'opening' && job.nodeId != null) {
    try { job.audio?.closePluginEditor?.(job.trackId, job.nodeId) } catch { /* already gone */ }
  }
}

/** Retry the editor open after a failure (only once the plugin is inserted). */
export function retryPluginLoad() {
  const job = usePluginLoadStore.getState().job
  if (!job || job.phase !== 'failed' || job.nodeId == null) return
  void openEditorForLoad(job.id, job.nodeId)
}

/** Plain-language reason for a failure code or editor-host message. */
export function describePluginLoadError(error) {
  const e = String(error || '')
  if (e === 'add-failed' || e.startsWith('Failed to add effect')) return 'XLETH could not load this plugin.'
  if (e.includes('null editor')) return 'This plugin has no editor window of its own.'
  if (e === 'protocol-mismatch') return "XLETH's editor helper is out of date. Reinstall or rebuild XLETH."
  if (e === 'editor-host-missing') return "XLETH's editor helper (xleth-editor-host.exe) is missing."
  if (e === 'no-description') return 'This plugin is not in the plugin list any more. Rescan plugins and try again.'
  if (e === 'closed') return 'The editor window closed before it finished loading.'
  if (e.startsWith('createPluginInstance failed')) {
    const detail = e.slice('createPluginInstance failed'.length).replace(/^[:\s]+/, '')
    return detail ? `The plugin failed to load in its editor window: ${detail}` : 'The plugin failed to load in its editor window.'
  }
  if (e === 'editor-host-error' || e === '') return 'The editor window could not start.'
  return `The editor window could not open: ${e}`
}
