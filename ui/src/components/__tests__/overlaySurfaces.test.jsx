// @vitest-environment jsdom
// The dialogs, menus and toast migrated to the kit in Phase 8 keep their behaviour.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import UnsavedChangesDialog from '../UnsavedChangesDialog.jsx'
import ConfirmConvertDialog from '../timeline/ConfirmConvertDialog.jsx'
import AutomationDeleteConfirmDialog from '../mixer/AutomationDeleteConfirmDialog.jsx'
import MissingPluginsDialog from '../MissingPluginsDialog.jsx'
import MissingMediaDialog from '../MissingMediaDialog.jsx'
import ExportZipDialog from '../ExportZipDialog.jsx'
import ContextMenu from '../ContextMenu.jsx'
import TrackContextMenu from '../timeline/TrackContextMenu.jsx'
import { ToastProvider, ToastStatusText, useToast } from '../Toast.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

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

const render = (el) => act(async () => { root.render(el) })
const btn = (text) => Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent.trim().startsWith(text))
const press = (el, key) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
const menuItems = () => Array.from(document.body.querySelectorAll('[role^="menuitem"]'))

describe('confirm dialogs on the kit Dialog', () => {
  it('Unsaved changes: Save / Discard / Cancel, Enter saves, Escape cancels, Save has focus', async () => {
    const onSave = vi.fn(); const onDiscard = vi.fn(); const onCancel = vi.fn()
    await render(<UnsavedChangesDialog onSave={onSave} onDiscard={onDiscard} onCancel={onCancel} />)
    expect(document.querySelector('[role="dialog"]').getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(btn('Save'))
    await act(async () => { btn('Discard').click() })
    await act(async () => { btn('Cancel').click() })
    expect(onDiscard).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledTimes(1)
    press(document.querySelector('[role="dialog"]'), 'Enter')
    expect(onSave).toHaveBeenCalledTimes(1)
    press(window, 'Escape')
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it('Convert confirm: danger styling is the default, the label is configurable', async () => {
    const onConfirm = vi.fn()
    await render(<ConfirmConvertDialog title="Convert" message="Sure?" confirmLabel="Convert" onConfirm={onConfirm} onCancel={() => {}} />)
    expect(btn('Convert').getAttribute('data-variant')).toBe('danger')
    await act(async () => { btn('Convert').click() })
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('Sure?')
  })

  it('Automation delete names every clip that dies and the default focus is Cancel', async () => {
    const onConfirm = vi.fn(); const onCancel = vi.fn()
    await render(
      <AutomationDeleteConfirmDialog
        title="Delete effect" subject="Compressor"
        clips={[{ id: 1, label: 'Threshold', position: 'Bar 3' }, { id: 2, label: 'Ratio', position: 'Bar 9' }]}
        onConfirm={onConfirm} onCancel={onCancel}
      />,
    )
    expect(document.body.textContent).toContain('also delete 2 automation clips')
    expect(document.querySelector('ul').textContent).toContain('Threshold')
    expect(document.querySelector('ul').textContent).toContain('Bar 9')
    expect(document.activeElement).toBe(btn('Cancel'))
    await act(async () => { btn('Delete anyway').click() })
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})

describe('Missing plugins / media / ZIP dialogs', () => {
  it('Missing plugins lists each plugin, must be answered (no close button), and Ignore all closes', async () => {
    const onClose = vi.fn()
    await render(
      <MissingPluginsDialog
        plugins={[{ trackId: 0, nodeId: 4, pluginId: 'p1', pluginName: 'Fancy Verb', pluginVendor: 'Acme' }]}
        onClose={onClose}
      />,
    )
    const dlg = document.querySelector('[role="dialog"]')
    expect(dlg.textContent).toContain('Fancy Verb')
    expect(dlg.textContent).toContain('Acme · Track 1')
    expect(document.querySelector('[aria-label="Close"]')).toBeNull()
    press(window, 'Escape')
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => { btn('Ignore all').click() })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Missing media lists name and path with the engine error, and relinks one row at a time', async () => {
    const onClose = vi.fn()
    await render(
      <MissingMediaDialog
        media={[{ sourceId: 7, displayName: 'take1.mp4', filePath: 'C:\\clips\\take1.mp4', error: 'File not found' }]}
        onClose={onClose}
      />,
    )
    const dlg = document.querySelector('[role="dialog"]')
    expect(dlg.getAttribute('aria-labelledby')).toBeTruthy()
    expect(dlg.textContent).toContain('Missing media (1)')
    expect(dlg.textContent).toContain('take1.mp4')
    expect(dlg.textContent).toContain('C:\\clips\\take1.mp4 — File not found')
    expect(btn('Relink')).toBeTruthy()
    press(window, 'Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Export as ZIP: two modes in a radio group, Full is the default, nothing renders when closed', async () => {
    await render(<ExportZipDialog isOpen={false} onClose={() => {}} />)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await render(<ExportZipDialog isOpen onClose={() => {}} />)
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'))
    expect(radios.map((r) => r.value)).toEqual(['full', 'projectOnly'])
    expect(radios[0].checked).toBe(true)
    await act(async () => { radios[1].click() })
    expect(radios[1].checked).toBe(true)
    expect(btn('Export…')).toBeTruthy()
  })
})

describe('menus on the kit Menu', () => {
  it('ContextMenu keeps its item-array API: run then close, separators and custom rows', async () => {
    const onClose = vi.fn(); const run = vi.fn()
    await render(
      <ContextMenu
        x={5} y={5} onClose={onClose}
        items={[
          { label: 'Rename', onClick: run },
          { type: 'separator' },
          { type: 'custom', key: 'amt', content: <input aria-label="Amount" /> },
          { label: 'Delete', danger: true, onClick: () => {} },
        ]}
      />,
    )
    expect(menuItems().map((m) => m.textContent)).toEqual(['Rename', 'Delete'])
    expect(document.querySelector('[role="separator"]')).not.toBeNull()
    expect(document.querySelector('input[aria-label="Amount"]')).not.toBeNull()
    expect(menuItems()[1].getAttribute('data-danger')).not.toBeNull()
    await act(async () => { menuItems()[0].click() })
    expect(run).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('TrackContextMenu: a check column when any row is checkable, a submenu on hover, one close per pick', async () => {
    const onClose = vi.fn(); const leaf = vi.fn()
    await render(
      <TrackContextMenu
        x={0} y={0} onClose={onClose}
        items={[
          { label: 'Mute', checked: true, onClick: () => {} },
          { label: 'Move to', submenu: [{ label: 'Track 2', onClick: leaf }] },
          { type: 'separator' },
          { label: 'Gone', disabled: true },
        ]}
      />,
    )
    expect(menuItems()[0].getAttribute('role')).toBe('menuitemcheckbox')
    expect(menuItems()[0].getAttribute('aria-checked')).toBe('true')
    await act(async () => { menuItems()[1].dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    await act(async () => { menuItems()[1].click() })
    const sub = Array.from(document.querySelectorAll('[role="menu"]'))[1]
    expect(sub).toBeTruthy()
    await act(async () => { sub.querySelector('[role^="menuitem"]').click() })
    expect(leaf).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('Toast status text', () => {
  function Fire({ level }) {
    const { showToast } = useToast()
    React.useEffect(() => { showToast('Saved project', level) }, [showToast, level])
    return <ToastStatusText />
  }

  it('shows the message with a level glyph (colour is not the only signal) and dismisses on click', async () => {
    await render(<ToastProvider><Fire level="success" /></ToastProvider>)
    const b = btn('Saved project')
    expect(b.getAttribute('data-level')).toBe('success')
    expect(b.querySelector('svg')).not.toBeNull()
    expect(b.parentElement.getAttribute('role')).toBe('status')
    await act(async () => { b.click() })
    expect(btn('Saved project')).toBeUndefined()
  })

  it('errors are announced as alerts', async () => {
    await render(<ToastProvider><Fire level="error" /></ToastProvider>)
    expect(btn('Saved project').parentElement.getAttribute('role')).toBe('alert')
  })
})
