// @vitest-environment jsdom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import CleanupProjectDialog from './CleanupProjectDialog.jsx'
import ProxyBatchBadge from './ProxyBatchBadge.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const GB = 1024 ** 3
const SCAN = {
  hasProject: true,
  willFree: {
    files: 5,
    bytes: 2.5 * GB,
    categories: [
      { id: 'proxies', label: 'Video proxies', files: 2, bytes: 2 * GB },
      { id: 'partials', label: 'Unfinished files from interrupted jobs', files: 3, bytes: 0.5 * GB },
    ],
  },
  kept: { files: 1, bytes: 300 * 1024 * 1024, items: [{ name: 'gone.preview.720p.h264.mov', reason: 'offline' }] },
  partialsSkipped: false,
}

let container
let root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

async function renderDialog(props) {
  await act(async () => {
    root.render(<CleanupProjectDialog scan={SCAN} onConfirm={() => {}} onCancel={() => {}} {...props} />)
  })
}

const q = (sel) => document.body.querySelector(sel)
const button = (text) => Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent.trim().startsWith(text))

describe('CleanupProjectDialog', () => {
  it('lists every category with its size and the total that will be freed', async () => {
    await renderDialog()
    const text = q('.cleanup-dialog-list').textContent
    expect(text).toContain('Video proxies')
    expect(text).toContain('2 files · 2 GB')
    expect(text).toContain('Unfinished files from interrupted jobs')
    expect(text).toContain('Will free5 files · 2.5 GB')
    expect(button('Clean up').textContent).toContain('2.5 GB')
  })

  it('says what is KEPT and why, naming the files', async () => {
    await renderDialog()
    const note = q('.cleanup-dialog-note').textContent
    expect(note).toContain('Kept: 1 file (300 MB)')
    expect(note).toContain('source media is offline')
    expect(note).toContain('gone.preview.720p.h264.mov')
  })

  it('promises source media and project file are untouched', async () => {
    await renderDialog()
    expect(q('.cleanup-dialog-lead').textContent).toMatch(/source media and the project\s+file are never touched/)
  })

  it('explains skipped partials while a background job runs', async () => {
    await renderDialog({ scan: { ...SCAN, kept: { files: 0, bytes: 0, items: [] }, partialsSkipped: true } })
    expect(document.body.textContent).toContain('background job is still running')
    expect(document.body.textContent).not.toContain('Kept:')
  })

  it('confirms with the button and cancels with the button, Escape and the backdrop', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    await renderDialog({ onConfirm, onCancel })

    await act(async () => { button('Clean up').click() })
    expect(onConfirm).toHaveBeenCalledTimes(1)

    await act(async () => { button('Cancel').click() })
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    await act(async () => { q('.cleanup-dialog-backdrop').click() })
    expect(onCancel).toHaveBeenCalledTimes(3)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('does not close when the dialog body itself is clicked', async () => {
    const onCancel = vi.fn()
    await renderDialog({ onCancel })
    await act(async () => { q('.cleanup-dialog').click() })
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('is an accessible modal dialog', async () => {
    await renderDialog()
    const dlg = q('[role="dialog"]')
    expect(dlg.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dlg.getAttribute('aria-labelledby')).textContent).toBe('Clean up project')
  })
})

describe('ProxyBatchBadge', () => {
  it('shows label, position in the batch and percent', async () => {
    await act(async () => {
      root.render(
        <ProxyBatchBadge
          label="Rebuilding previews"
          title="t"
          batch={{ total: 4, completed: 1, failed: 0, progress: 0.4 }}
          pct={40}
          testId="proxy-rebuild-badge"
        />
      )
    })
    const badge = q('[data-testid="proxy-rebuild-badge"]')
    expect(badge.getAttribute('role')).toBe('status')
    expect(badge.textContent).toContain('Rebuilding previews')
    expect(badge.textContent).toContain('2 / 4')
    expect(badge.textContent).toContain('40%')
    expect(badge.querySelector('.proxy-migration-bar-fill').style.width).toBe('40%')
  })

  it('never shows a position beyond the batch size', async () => {
    await act(async () => {
      root.render(<ProxyBatchBadge label="x" title="t" batch={{ total: 2, completed: 2, failed: 0, progress: 1 }} pct={100} />)
    })
    expect(q('.proxy-migration-count').textContent).toContain('2 / 2')
  })
})
