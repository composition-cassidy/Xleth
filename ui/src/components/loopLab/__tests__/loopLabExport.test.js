import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import loopLabExport from '../../../../electron-main/loopLabExport.js'

const { parseWavHeader, convertGold, buildDataset, sanitizeSegment } = loopLabExport

// Minimal 16-bit PCM WAV (silence). Only the header matters for these tests.
function makeWav(filePath, { sampleRate, channels = 1, numFrames, bits = 16 }) {
  const blockAlign = channels * (bits / 8)
  const dataSize = numFrames * blockAlign
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(channels, 22); buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * blockAlign, 28); buf.writeUInt16LE(blockAlign, 32); buf.writeUInt16LE(bits, 34)
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40)
  fs.writeFileSync(filePath, buf)
}

let tmpDir
let wav48, wav441
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'looplab-test-'))
  wav48 = path.join(tmpDir, 'a48.wav')
  wav441 = path.join(tmpDir, 'b441.wav')
  makeWav(wav48, { sampleRate: 48000, channels: 2, numFrames: 96000 })   // 2.0 s @ 48k
  makeWav(wav441, { sampleRate: 44100, channels: 1, numFrames: 44100 })  // 1.0 s @ 44.1k
})
afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {} })

describe('parseWavHeader', () => {
  it('reads rate / channels / frame count from the header', () => {
    expect(parseWavHeader(wav48)).toMatchObject({ sampleRate: 48000, channels: 2, numFrames: 96000 })
    expect(parseWavHeader(wav441)).toMatchObject({ sampleRate: 44100, channels: 1, numFrames: 44100 })
  })
  it('returns null for a non-WAV file', () => {
    const bad = path.join(tmpDir, 'bad.wav')
    fs.writeFileSync(bad, Buffer.from('not a wav'))
    expect(parseWavHeader(bad)).toBeNull()
  })
})

describe('convertGold (engine-buffer → file domain)', () => {
  it('is identity when file rate equals engine rate', () => {
    const hdr = { sampleRate: 48000, numFrames: 96000 }
    expect(convertGold({ start: 24000, end: 72000, xfade: 2048 }, 48000, hdr))
      .toEqual({ start: 24000, end: 72000, xfade: 2048 })
  })
  it('scales by fileRate/engineRate for off-rate files', () => {
    // Engine 48k, file 44.1k: a loop point at engine-sample 48000 (1.0 s) → 44100.
    const hdr = { sampleRate: 44100, numFrames: 44100 }
    const g = convertGold({ start: 24000, end: 48000, xfade: 960 }, 48000, hdr)
    expect(g.start).toBe(Math.round(24000 * 44100 / 48000)) // 22050
    expect(g.end).toBe(44100)                               // clamped to frame count
    expect(g.xfade).toBe(Math.round(960 * 44100 / 48000))   // 882
  })
})

describe('sanitizeSegment', () => {
  it('keeps spaces/hyphens but strips illegal chars', () => {
    expect(sanitizeSegment('Hard-tuned vocal')).toBe('Hard-tuned vocal')
    expect(sanitizeSegment('a/b:c*?')).toBe('a_b_c__')
    expect(sanitizeSegment('')).toBe('unnamed')
  })
})

describe('buildDataset', () => {
  it('produces schema-correct entries with converted gold + file-domain header info', () => {
    const { dataset, zipEntries } = buildDataset([
      {
        filePath: wav48, name: 'hard_tuned_vocal_ep12_0001', className: 'Hard-tuned vocal',
        instrumentName: null, source: 'ep12', rootNote: 60, behaviorFamily: 'stable_periodic',
        engineSampleRate: 48000, gold: { start: 24000, end: 72000, xfade: 2048 },
      },
      {
        filePath: wav441, name: 'flute_0001', className: 'Instrument',
        instrumentName: 'flute', source: '', rootNote: null, behaviorFamily: 'stable_periodic',
        engineSampleRate: 48000, gold: { start: 24000, end: 48000, xfade: 960 },
      },
    ])

    expect(dataset).toHaveLength(2)
    // Entry 0 — vocal, on-rate.
    expect(dataset[0]).toMatchObject({
      sample_id: 'hard_tuned_vocal_ep12_0001',
      file: 'corpus/Hard-tuned vocal/hard_tuned_vocal_ep12_0001.wav',
      class: 'Hard-tuned vocal', instrument_name: null, behavior_family: 'stable_periodic',
      source: 'ep12', root_note: 60, sample_rate: 48000, channels: 2, num_samples: 96000,
      gold_loop: { start: 24000, end: 72000, xfade: 2048 }, measured_features: null,
    })
    // Entry 1 — instrument, off-rate → gold converted + instrument subfolder.
    expect(dataset[1].file).toBe('corpus/Instrument/flute/flute_0001.wav')
    expect(dataset[1]).toMatchObject({
      instrument_name: 'flute', sample_rate: 44100, channels: 1, num_samples: 44100, root_note: null,
    })
    expect(dataset[1].gold_loop).toEqual({ start: 22050, end: 44100, xfade: 882 })
    // Zip entries copy the original files at the dataset paths.
    expect(zipEntries).toEqual([
      { src: wav48, name: 'corpus/Hard-tuned vocal/hard_tuned_vocal_ep12_0001.wav' },
      { src: wav441, name: 'corpus/Instrument/flute/flute_0001.wav' },
    ])
  })

  it('disambiguates duplicate names and ids', () => {
    const { dataset, zipEntries } = buildDataset([
      { filePath: wav48, name: 'dup', className: 'Natural vocal', engineSampleRate: 48000, gold: {} },
      { filePath: wav48, name: 'dup', className: 'Natural vocal', engineSampleRate: 48000, gold: {} },
    ])
    expect(zipEntries[0].name).toBe('corpus/Natural vocal/dup.wav')
    expect(zipEntries[1].name).toBe('corpus/Natural vocal/dup_1.wav')
    expect(dataset[0].sample_id).toBe('dup')
    expect(dataset[1].sample_id).toBe('dup_1')
  })

  it('throws on a missing source file', () => {
    expect(() => buildDataset([{ filePath: path.join(tmpDir, 'nope.wav'), name: 'x', className: 'Natural vocal', gold: {} }]))
      .toThrow(/Missing source WAV/)
  })
})

describe('full ZIP round-trip', () => {
  it('writes a real archive containing dataset.json + the corpus WAVs', async () => {
    const archiver = (await import('archiver')).default
    const { dataset, zipEntries } = buildDataset([
      { filePath: wav48, name: 'z1', className: 'Natural vocal', engineSampleRate: 48000, gold: { start: 1, end: 2, xfade: 0 } },
    ])
    const zipPath = path.join(tmpDir, 'out.zip')
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath)
      const archive = archiver('zip', { zlib: { level: 9 } })
      output.on('close', resolve)
      archive.on('error', reject)
      archive.pipe(output)
      archive.append(JSON.stringify(dataset, null, 2), { name: 'dataset.json' })
      for (const e of zipEntries) archive.file(e.src, { name: e.name })
      archive.finalize()
    })
    const stat = fs.statSync(zipPath)
    expect(stat.size).toBeGreaterThan(200) // header + dataset.json + one wav
  })
})
