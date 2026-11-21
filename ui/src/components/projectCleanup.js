// Project-hygiene flows for regenerable files (proxies, thumbnails, waveform
// peak caches, and the .tmp leftovers of interrupted jobs):
//
//   • runCleanupProject  — File → "Clean up project…": scan → confirm → delete
//   • reportPurgeOnClose — after a project switch, report the space that the
//                          "Delete regenerable files when closing a project"
//                          setting freed from the project that was just closed
//
// What may be deleted is decided by the engine (engine/src/project/
// RegenerableFiles.*); this module only drives the UI around it. Kept apart from
// the React dialog so the flow is testable without a DOM.

import { formatFileSize } from './filePicker/filePickerHelpers.js'

export const CLEANUP_PROJECT_LABEL = 'Clean up project…'

/** "1.2 GB", or "0 B" for nothing — never the empty string formatFileSize gives. */
export function formatFreed(bytes) {
  return formatFileSize(bytes) || '0 B'
}

// A bridge call that is missing does not throw — `xl.project.cleanupRun?.()`
// would just do nothing. These flows report it instead of failing silently.
function hasCleanupBridge(xl) {
  return typeof xl?.project?.cleanupScan === 'function'
      && typeof xl?.project?.cleanupRun === 'function'
}

/**
 * Scan the open project, show what would be freed, and — only on confirmation —
 * delete it. `confirm(scan)` resolves true/false (see CleanupProjectDialog).
 * Returns 'cleaned' | 'nothing' | 'cancelled' | 'unavailable' | 'error'.
 */
export async function runCleanupProject({ xl = window.xleth, showToast, confirm }) {
  if (!hasCleanupBridge(xl)) {
    console.error('[Cleanup] window.xleth.project.cleanupScan/cleanupRun are not exposed — bridge/preload out of date?')
    showToast?.('Clean up is unavailable: the engine bridge is out of date. Rebuild the app.', 'error')
    return 'unavailable'
  }

  let scan
  try {
    scan = await xl.project.cleanupScan()
  } catch (e) {
    console.error('[Cleanup] cleanupScan failed:', e)
    showToast?.(`Clean up failed: ${e?.message || 'could not scan the project'}`, 'error')
    return 'error'
  }

  if (!scan?.hasProject) {
    showToast?.('Save the project to a folder before cleaning it up.', 'info')
    return 'nothing'
  }
  if (!scan.willFree || scan.willFree.files === 0) {
    const kept = scan.kept?.files > 0
      ? ` ${scan.kept.files} file${scan.kept.files === 1 ? ' is' : 's are'} kept because their source media is offline.`
      : ''
    showToast?.(`Nothing to clean up.${kept}`, 'info')
    return 'nothing'
  }

  const go = await confirm(scan)
  if (!go) return 'cancelled'

  let result
  try {
    result = await xl.project.cleanupRun()
  } catch (e) {
    console.error('[Cleanup] cleanupRun failed:', e)
    showToast?.(`Clean up failed: ${e?.message || 'unknown error'}`, 'error')
    return 'error'
  }
  if (!result?.ok) {
    showToast?.(`Clean up failed: ${result?.error || 'unknown error'}`, 'error')
    return 'error'
  }

  const inUse = result.filesFailed > 0
    ? ` ${result.filesFailed} file${result.filesFailed === 1 ? ' was' : 's were'} in use and left in place.`
    : ''
  showToast?.(`Freed ${formatFreed(result.freedBytes)} (${result.filesRemoved} file${result.filesRemoved === 1 ? '' : 's'}).${inUse}`, 'success')
  return 'cleaned'
}

/**
 * Call after a project switch (New / Open). Consumes the engine's last
 * purge-on-close result and, if it freed anything, tells the user how much.
 * Silent when the setting is off (the engine has nothing to report).
 */
export async function reportPurgeOnClose({ xl = window.xleth, showToast }) {
  if (typeof xl?.project?.takeLastPurge !== 'function') {
    console.warn('[Cleanup] window.xleth.project.takeLastPurge is not exposed — cannot report purge-on-close')
    return null
  }
  let purge
  try {
    purge = await xl.project.takeLastPurge()
  } catch (e) {
    console.warn('[Cleanup] takeLastPurge failed:', e)
    return null
  }
  if (!purge) return null

  if (purge.freedBytes > 0) {
    const inUse = purge.filesFailed > 0 ? ` (${purge.filesFailed} in use, left in place)` : ''
    showToast?.(`Freed ${formatFreed(purge.freedBytes)} of regenerable files from the previous project${inUse}.`, 'success')
  }
  return purge
}
