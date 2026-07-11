/* @vitest-environment jsdom */
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import XlethFilePickerModal from './XlethFilePickerModal.jsx'

const DESKTOP = 'C:\\Users\\K\\Desktop'
const FOLDER = 'C:\\Users\\K\\Desktop\\Samples'
const NEW_FOLDER = 'C:\\Users\\K\\Desktop\\New Folder'
const WAVE = 'C:\\Users\\K\\Desktop\\Pitch 1.wav'
const EXPORT_WAVE = 'C:\\Users\\K\\Desktop\\export.wav'

function parentOf(filePath) {
  const index = String(filePath).lastIndexOf('\\')
  return index > 0 ? filePath.slice(0, index) : ''
}

function makePathValidator() {
  const dirs = new Set([DESKTOP, FOLDER, NEW_FOLDER, 'C:\\'])
  const files = new Map([[WAVE, 2048]])
  return vi.fn(async (rawPath) => {
    const filePath = String(rawPath || '')
    const parentPath = parentOf(filePath)
    const isDirectory = dirs.has(filePath)
    const isFile = files.has(filePath)
    return {
      ok: true,
      path: filePath,
      name: filePath.split('\\').pop(),
      parentPath,
      parentExists: dirs.has(parentPath),
      exists: isDirectory || isFile,
      isDirectory,
      isFile,
      extension: isFile ? '.wav' : '',
      size: files.get(filePath) || 0,
      modifiedMs: 0,
    }
  })
}

function installFilePickerApi() {
  const validatePath = makePathValidator()
  const setFavorites = vi.fn(async (favorites) => favorites)
  const createFolder = vi.fn(async () => ({
    name: 'New Folder',
    path: NEW_FOLDER,
    isDirectory: true,
    isFile: false,
    extension: '',
    size: 0,
    modifiedMs: 0,
  }))
  globalThis.window.xleth = {
    filePicker: {
      getRoots: vi.fn(async () => ({
        home: 'C:\\Users\\K',
        locations: [{ label: 'Desktop', path: DESKTOP }],
        drives: [{ label: 'C:', path: 'C:\\' }],
        favorites: ['C:\\Favorites'],
      })),
      listDirectory: vi.fn(async (dirPath) => ({
        path: dirPath,
        parentPath: parentOf(dirPath),
        entries: dirPath === DESKTOP
          ? [
              {
                name: 'Samples',
                path: FOLDER,
                isDirectory: true,
                isFile: false,
                extension: '',
                size: 0,
                modifiedMs: 0,
                isMedia: false,
              },
              {
                name: 'Pitch 1.wav',
                path: WAVE,
                isDirectory: false,
                isFile: true,
                extension: '.wav',
                size: 2048,
                modifiedMs: 0,
                isMedia: true,
              },
            ]
          : [],
      })),
      validatePath,
      createFolder,
      getFavorites: vi.fn(async () => ['C:\\Favorites']),
      setFavorites,
      probeDurations: vi.fn(async () => ({ [WAVE]: 1 })),
    },
    project: {
      getInfo: vi.fn(async () => ({
        projectDir: 'C:\\Project',
        exportsDir: 'C:\\Project\\exports',
      })),
    },
    timeline: {
      getSources: vi.fn(async () => [{ filePath: 'C:\\Sources\\clip.mp4' }]),
    },
  }
  return { validatePath, setFavorites, createFolder }
}

async function flushEffects(times = 8) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function waitFor(assertion) {
  let lastError
  for (let i = 0; i < 20; i += 1) {
    try {
      assertion()
      return
    } catch (err) {
      lastError = err
      await flushEffects(1)
    }
  }
  throw lastError
}

describe('XlethFilePickerModal', () => {
  let container
  let root

  beforeEach(() => {
    document.body.innerHTML = ''
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    installFilePickerApi()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('lists files, toggles favorites, creates folders, and accepts a selected file', async () => {
    const accepted = vi.fn()
    await act(async () => {
      root.render(
        <XlethFilePickerModal
          options={{
            mode: 'openFile',
            title: 'Select Sample',
            actionLabel: 'Select Sample',
            filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
          }}
          onCancel={() => {}}
          onAccept={accepted}
        />,
      )
    })

    await waitFor(() => expect(container.textContent).toContain('Pitch 1.wav'))
    expect(container.querySelector('.xleth-file-picker__path-input').value).toBe(DESKTOP)
    expect(container.textContent).toContain('0:01 sec')

    await act(async () => {
      container.querySelector('[title="Favorite current folder"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(window.xleth.filePicker.setFavorites).toHaveBeenCalledWith(['C:\\Favorites', DESKTOP])

    await act(async () => {
      container.querySelector('[title="Add new folder"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find(button => button.textContent === 'Create')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(window.xleth.filePicker.createFolder).toHaveBeenCalledWith(DESKTOP, 'New Folder')
    await act(async () => {
      container.querySelector('[title="Go back"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await waitFor(() => expect(container.textContent).toContain('Pitch 1.wav'))

    await act(async () => {
      Array.from(container.querySelectorAll('.xleth-file-picker__row'))
        .find(row => row.textContent.includes('Pitch 1.wav'))
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      container.querySelector('.xleth-file-picker__primary').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(accepted).toHaveBeenCalledWith({ canceled: false, path: WAVE, paths: [WAVE] })
  })

  it('accepts a non-existing save path when its parent exists', async () => {
    const accepted = vi.fn()
    await act(async () => {
      root.render(
        <XlethFilePickerModal
          options={{
            mode: 'saveFile',
            title: 'Export Audio As',
            actionLabel: 'Export',
            defaultPath: EXPORT_WAVE,
            defaultExtension: 'wav',
            filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
          }}
          onCancel={() => {}}
          onAccept={accepted}
        />,
      )
    })

    await waitFor(() => expect(container.querySelector('.xleth-file-picker__path-input').value).toBe(EXPORT_WAVE))
    await act(async () => {
      container.querySelector('.xleth-file-picker__primary').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(accepted).toHaveBeenCalledWith({ canceled: false, path: EXPORT_WAVE, paths: [EXPORT_WAVE] })
  })
})
