import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  getPickerPath,
  getPickerPaths,
  normalizeLegacyPickerResult,
  openFilePicker,
  setFilePickerOpener,
} from './filePickerService.js'

describe('filePickerService', () => {
  afterEach(() => {
    setFilePickerOpener(null)
  })

  it('normalizes legacy string, array, and Electron-shaped picker results', () => {
    expect(normalizeLegacyPickerResult('C:\\A\\one.wav')).toEqual({
      canceled: false,
      path: 'C:\\A\\one.wav',
      paths: ['C:\\A\\one.wav'],
    })
    expect(normalizeLegacyPickerResult(['a.wav', 'b.wav'], { mode: 'openFiles' })).toEqual({
      canceled: false,
      path: 'a.wav',
      paths: ['a.wav', 'b.wav'],
    })
    expect(normalizeLegacyPickerResult({ filePaths: ['x.mp4'] })).toEqual({
      canceled: false,
      path: 'x.mp4',
      paths: ['x.mp4'],
    })
  })

  it('uses the active provider opener before any legacy picker', async () => {
    const legacyPicker = vi.fn().mockResolvedValue('legacy.wav')
    setFilePickerOpener(async () => ({ canceled: false, path: 'custom.wav', paths: ['custom.wav'] }))

    const result = await openFilePicker({ legacyPicker })

    expect(getPickerPath(result)).toBe('custom.wav')
    expect(legacyPicker).not.toHaveBeenCalled()
  })

  it('falls back to legacy pickers or reports unavailable when no provider is mounted', async () => {
    const legacy = await openFilePicker({
      mode: 'openFiles',
      legacyPicker: () => Promise.resolve(['a.wav', 'b.wav']),
    })
    const unavailable = await openFilePicker({ mode: 'openFile' })

    expect(getPickerPaths(legacy)).toEqual(['a.wav', 'b.wav'])
    expect(unavailable).toEqual({ canceled: true, unavailable: true })
  })
})
