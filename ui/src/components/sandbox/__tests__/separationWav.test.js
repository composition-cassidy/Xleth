import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// electron-main/separation.js requires 'electron' at module scope. Outside a
// real Electron process that resolves to a path string, so destructuring
// { ipcMain, app } yields undefined — harmless here because nothing under
// test calls init(), but the mock makes that explicit rather than incidental.
vi.mock('electron', () => ({ ipcMain: { handle: () => {} }, app: { on: () => {} } }))

const { writeWavFloat32, safeName } = await import('../../../../electron-main/separation.js')

// The WAV writer is the one place the Sample Sandbox's audio crosses from JS
// into a file another process reads. Getting the header or the interleave
// wrong does not throw — it produces a file that decodes as noise, or as the
// right audio at the wrong rate, somewhere much further downstream.

function readHeader(buf) {
  return {
    riff: buf.toString('ascii', 0, 4),
    wave: buf.toString('ascii', 8, 12),
    fmt: buf.toString('ascii', 12, 16),
    fmtSize: buf.readUInt32LE(16),
    audioFormat: buf.readUInt16LE(20),
    numChannels: buf.readUInt16LE(22),
    sampleRate: buf.readUInt32LE(24),
    byteRate: buf.readUInt32LE(28),
    blockAlign: buf.readUInt16LE(32),
    bitsPerSample: buf.readUInt16LE(34),
    data: buf.toString('ascii', 36, 40),
    dataBytes: buf.readUInt32LE(40),
    riffSize: buf.readUInt32LE(4),
  }
}

describe('separation WAV writer (electron-main)', () => {
  let dir
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xleth-sep-')) })
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })

  it('writes a 32-bit IEEE float stereo header', () => {
    const file = path.join(dir, 'a.wav')
    writeWavFloat32(file, [new Float32Array(8), new Float32Array(8)], 44100)
    const h = readHeader(fs.readFileSync(file))

    expect(h.riff).toBe('RIFF')
    expect(h.wave).toBe('WAVE')
    expect(h.fmt).toBe('fmt ')
    expect(h.fmtSize).toBe(16)
    expect(h.audioFormat).toBe(3)          // 3 = IEEE float, NOT 1 = PCM int
    expect(h.bitsPerSample).toBe(32)
    expect(h.numChannels).toBe(2)
    expect(h.sampleRate).toBe(44100)
    expect(h.blockAlign).toBe(8)           // 2ch * 4 bytes
    expect(h.byteRate).toBe(44100 * 8)
    expect(h.data).toBe('data')
    expect(h.dataBytes).toBe(8 * 2 * 4)
    expect(h.riffSize).toBe(36 + h.dataBytes)
  })

  it('interleaves channels in the right order', () => {
    const file = path.join(dir, 'b.wav')
    const left = new Float32Array([0.1, 0.2, 0.3])
    const right = new Float32Array([-0.1, -0.2, -0.3])
    writeWavFloat32(file, [left, right], 48000)

    const buf = fs.readFileSync(file)
    const samples = []
    for (let i = 0; i < 6; i++) samples.push(buf.readFloatLE(44 + i * 4))
    expect(samples.map((s) => Number(s.toFixed(4)))).toEqual([0.1, -0.1, 0.2, -0.2, 0.3, -0.3])
  })

  it('does NOT clip values beyond ±1.0', () => {
    // A separation residual, or a layer with gain ops on its stack, can
    // legitimately exceed full scale. Quantising or clamping here would bake
    // in damage the op-stack could otherwise undo.
    const file = path.join(dir, 'c.wav')
    writeWavFloat32(file, [new Float32Array([2.5, -3.75])], 44100)
    const buf = fs.readFileSync(file)
    expect(buf.readFloatLE(44)).toBeCloseTo(2.5, 5)
    expect(buf.readFloatLE(48)).toBeCloseTo(-3.75, 5)
  })

  it('round-trips the declared sample rate', () => {
    for (const rate of [22050, 44100, 48000, 96000]) {
      const file = path.join(dir, `r${rate}.wav`)
      writeWavFloat32(file, [new Float32Array(2), new Float32Array(2)], rate)
      expect(readHeader(fs.readFileSync(file)).sampleRate).toBe(rate)
    }
  })

  it('writes mono when handed one channel', () => {
    const file = path.join(dir, 'm.wav')
    writeWavFloat32(file, [new Float32Array([1, 0, -1])], 44100)
    const h = readHeader(fs.readFileSync(file))
    expect(h.numChannels).toBe(1)
    expect(h.blockAlign).toBe(4)
    expect(h.dataBytes).toBe(12)
  })

  it('creates the parent directory', () => {
    const file = path.join(dir, 'nested', 'deep', 'x.wav')
    writeWavFloat32(file, [new Float32Array(2)], 44100)
    expect(fs.existsSync(file)).toBe(true)
  })

  it('rejects an empty channel list rather than writing a headerless file', () => {
    expect(() => writeWavFloat32(path.join(dir, 'e.wav'), [], 44100)).toThrow(/no channels/)
  })
})

describe('separation safeName', () => {
  it('strips path separators and other filesystem hazards', () => {
    expect(safeName('a/b\\c:d*e?f')).not.toMatch(/[/\\:*?]/)
  })

  it('keeps ordinary layer names readable', () => {
    expect(safeName('Verse 2 - lead vox')).toBe('Verse 2 - lead vox')
  })

  it('falls back rather than producing an empty filename', () => {
    expect(safeName('///')).toBe('layer')
    expect(safeName('')).toBe('layer')
    expect(safeName(null)).toBe('layer')
  })

  it('bounds the length so a long layer name cannot blow the path limit', () => {
    expect(safeName('x'.repeat(500)).length).toBeLessThanOrEqual(60)
  })
})
