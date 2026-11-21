import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  CLEANUP_PROJECT_LABEL,
  formatFreed,
  reportPurgeOnClose,
  runCleanupProject,
} from './projectCleanup.js'
import { FILE_DROPDOWN_ITEMS } from './TitleBar.jsx'

const SCAN_WITH_FILES = {
  hasProject: true,
  willFree: {
    files: 3,
    bytes: 3 * 1024 * 1024 * 1024,
    categories: [{ id: 'proxies', label: 'Video proxies', files: 3, bytes: 3 * 1024 * 1024 * 1024 }],
  },
  kept: { files: 0, bytes: 0, items: [] },
  partialsSkipped: false,
}

function bridge(overrides = {}) {
  return {
    project: {
      cleanupScan: vi.fn().mockResolvedValue(SCAN_WITH_FILES),
      cleanupRun: vi.fn().mockResolvedValue({ ok: true, freedBytes: 3 * 1024 * 1024 * 1024, filesRemoved: 3, filesFailed: 0 }),
      takeLastPurge: vi.fn().mockResolvedValue(null),
      ...overrides,
    },
  }
}

describe('Clean up project menu entry', () => {
  it('is in the File menu, and the label the menu dispatches is the one the handler switches on', () => {
    expect(CLEANUP_PROJECT_LABEL).toBe('Clean up project…')
    expect(FILE_DROPDOWN_ITEMS.map((i) => i.label)).toContain(CLEANUP_PROJECT_LABEL)
  })
})

describe('runCleanupProject', () => {
  let toast
  let errSpy
  beforeEach(() => {
    toast = vi.fn()
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => errSpy.mockRestore())

  it('deletes nothing until the user confirms, then reports the freed space', async () => {
    const xl = bridge()
    const confirm = vi.fn().mockResolvedValue(true)
    const out = await runCleanupProject({ xl, showToast: toast, confirm })

    expect(out).toBe('cleaned')
    expect(xl.project.cleanupScan).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledWith(SCAN_WITH_FILES)          // dialog got the scan
    // scan happened BEFORE any delete
    expect(xl.project.cleanupScan.mock.invocationCallOrder[0])
      .toBeLessThan(xl.project.cleanupRun.mock.invocationCallOrder[0])
    expect(toast).toHaveBeenCalledWith('Freed 3 GB (3 files).', 'success')
  })

  it('never calls cleanupRun when the user cancels', async () => {
    const xl = bridge()
    const out = await runCleanupProject({ xl, showToast: toast, confirm: vi.fn().mockResolvedValue(false) })
    expect(out).toBe('cancelled')
    expect(xl.project.cleanupRun).not.toHaveBeenCalled()
    expect(toast).not.toHaveBeenCalled()
  })

  it('skips the dialog when there is nothing to free, and says what was kept', async () => {
    const xl = bridge({
      cleanupScan: vi.fn().mockResolvedValue({
        hasProject: true,
        willFree: { files: 0, bytes: 0, categories: [] },
        kept: { files: 2, bytes: 10, items: [] },
        partialsSkipped: false,
      }),
    })
    const confirm = vi.fn()
    const out = await runCleanupProject({ xl, showToast: toast, confirm })
    expect(out).toBe('nothing')
    expect(confirm).not.toHaveBeenCalled()
    expect(xl.project.cleanupRun).not.toHaveBeenCalled()
    expect(toast.mock.calls[0][0]).toContain('Nothing to clean up.')
    expect(toast.mock.calls[0][0]).toContain('2 files are kept')
  })

  it('asks the user to save first for an untitled project', async () => {
    const xl = bridge({ cleanupScan: vi.fn().mockResolvedValue({ hasProject: false, willFree: { files: 0, bytes: 0, categories: [] }, kept: { files: 0, bytes: 0, items: [] } }) })
    const out = await runCleanupProject({ xl, showToast: toast, confirm: vi.fn() })
    expect(out).toBe('nothing')
    expect(toast.mock.calls[0][0]).toMatch(/Save the project/)
  })

  it('reports a missing bridge loudly instead of silently doing nothing', async () => {
    for (const xl of [{}, { project: {} }, { project: { cleanupScan: vi.fn() } }]) {
      toast.mockClear()
      const out = await runCleanupProject({ xl, showToast: toast, confirm: vi.fn() })
      expect(out).toBe('unavailable')
      expect(toast).toHaveBeenCalledWith(expect.stringContaining('unavailable'), 'error')
    }
  })

  it('surfaces an engine failure and a scan exception as errors', async () => {
    const failed = bridge({ cleanupRun: vi.fn().mockResolvedValue({ ok: false, error: 'disk on fire' }) })
    expect(await runCleanupProject({ xl: failed, showToast: toast, confirm: vi.fn().mockResolvedValue(true) })).toBe('error')
    expect(toast).toHaveBeenLastCalledWith('Clean up failed: disk on fire', 'error')

    const throws = bridge({ cleanupScan: vi.fn().mockRejectedValue(new Error('engine not ready')) })
    expect(await runCleanupProject({ xl: throws, showToast: toast, confirm: vi.fn() })).toBe('error')
    expect(toast).toHaveBeenLastCalledWith('Clean up failed: engine not ready', 'error')
  })

  it('mentions files that were in use and left in place', async () => {
    const xl = bridge({ cleanupRun: vi.fn().mockResolvedValue({ ok: true, freedBytes: 1024, filesRemoved: 1, filesFailed: 2 }) })
    await runCleanupProject({ xl, showToast: toast, confirm: vi.fn().mockResolvedValue(true) })
    expect(toast.mock.calls[0][0]).toContain('2 files were in use and left in place')
  })
})

describe('reportPurgeOnClose', () => {
  let toast
  let warnSpy
  beforeEach(() => {
    toast = vi.fn()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => warnSpy.mockRestore())

  it('reports the space the previous project freed', async () => {
    const xl = bridge({ takeLastPurge: vi.fn().mockResolvedValue({ freedBytes: 1.5 * 1024 ** 3, filesRemoved: 9, filesFailed: 0 }) })
    await reportPurgeOnClose({ xl, showToast: toast })
    expect(toast).toHaveBeenCalledWith('Freed 1.5 GB of regenerable files from the previous project.', 'success')
  })

  it('is silent when nothing was purged (setting off / nothing to free)', async () => {
    await reportPurgeOnClose({ xl: bridge(), showToast: toast })                       // null
    const zero = bridge({ takeLastPurge: vi.fn().mockResolvedValue({ freedBytes: 0, filesRemoved: 0, filesFailed: 0 }) })
    await reportPurgeOnClose({ xl: zero, showToast: toast })
    expect(toast).not.toHaveBeenCalled()
  })

  it('warns (does not throw) when the bridge call is missing or rejects', async () => {
    await expect(reportPurgeOnClose({ xl: {}, showToast: toast })).resolves.toBeNull()
    expect(warnSpy).toHaveBeenCalled()
    const rejects = bridge({ takeLastPurge: vi.fn().mockRejectedValue(new Error('x')) })
    await expect(reportPurgeOnClose({ xl: rejects, showToast: toast })).resolves.toBeNull()
    expect(toast).not.toHaveBeenCalled()
  })
})

describe('formatFreed', () => {
  it('never returns an empty string', () => {
    expect(formatFreed(0)).toBe('0 B')
    expect(formatFreed(undefined)).toBe('0 B')
    expect(formatFreed(1536)).toBe('1.5 KB')
  })
})
