import { describe, expect, it } from 'vitest'

import {
  ensureSaveExtension,
  fileMatchesFilters,
  formatDuration,
  formatFileSize,
  formatLength,
  normalizeFilterExtensions,
  uniqueParentDirectories,
} from './filePickerHelpers.js'

describe('filePickerHelpers', () => {
  it('normalizes filters and matches files while always allowing folders', () => {
    const filters = [{ name: 'Audio', extensions: ['.wav', 'MP3'] }]

    expect(normalizeFilterExtensions(filters)).toEqual(['wav', 'mp3'])
    expect(fileMatchesFilters('C:\\Samples\\kick.wav', filters)).toBe(true)
    expect(fileMatchesFilters('C:\\Samples\\kick.flac', filters)).toBe(false)
    expect(fileMatchesFilters({ isDirectory: true, path: 'C:\\Samples' }, filters)).toBe(true)
  })

  it('appends the default save extension only when the current extension is not allowed', () => {
    const filters = [{ name: 'ZIP', extensions: ['zip'] }]

    expect(ensureSaveExtension('C:\\Exports\\project', filters, 'zip')).toBe('C:\\Exports\\project.zip')
    expect(ensureSaveExtension('C:\\Exports\\project.zip', filters, 'zip')).toBe('C:\\Exports\\project.zip')
    expect(ensureSaveExtension('C:\\Exports\\project.txt', filters, 'zip')).toBe('C:\\Exports\\project.txt.zip')
  })

  it('formats media durations and non-media sizes for the Length column', () => {
    expect(formatDuration(1.4)).toBe('0:01 sec')
    expect(formatDuration(65)).toBe('1:05 sec')
    expect(formatDuration(3661)).toBe('1:01:01')
    expect(formatFileSize(1536)).toBe('1.5 KB')
    expect(formatLength({ isDirectory: false, size: 2048 }, null)).toBe('2 KB')
    expect(formatLength({ isDirectory: true, size: 2048 }, 12)).toBe('')
  })

  it('builds unique parent directories for source-folder sidebar entries', () => {
    expect(uniqueParentDirectories([
      { filePath: 'C:\\Project\\media\\a.wav' },
      { filePath: 'C:\\Project\\media\\b.wav' },
      { filePath: 'D:\\Sources\\clip.mp4' },
    ])).toEqual([
      { label: 'media', path: 'C:\\Project\\media' },
      { label: 'Sources', path: 'D:\\Sources' },
    ])
  })
})
