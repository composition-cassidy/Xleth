import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { telemetryFile, appendEvent, readAll } from '../../../../electron-main/loopTelemetry.js'

describe('loopTelemetry (electron-main)', () => {
  let dir
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xleth-telemetry-')) })
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })

  it('reads empty before anything is written', () => {
    expect(readAll(dir)).toEqual([])
  })

  it('appends apply + nudge lines and reads them back with timestamps', () => {
    appendEvent(dir, { kind: 'apply', sample_duration: 1.2, gates_bound: ['placement_drift'],
      loop: { loopStart: 100, loopEnd: 900, crossfadeSamples: 50, period: 168.5, periodMultiple: 4 } })
    appendEvent(dir, { kind: 'nudge', field: 'crossfadeSamples', from: 50, to: 80, since_apply_ms: 4200 })

    const rows = readAll(dir)
    expect(rows).toHaveLength(2)
    expect(rows[0].kind).toBe('apply')
    expect(rows[0].gates_bound).toEqual(['placement_drift'])
    expect(rows[0].loop.periodMultiple).toBe(4)
    expect(typeof rows[0].timestamp).toBe('string')
    expect(rows[1]).toMatchObject({ kind: 'nudge', field: 'crossfadeSamples', from: 50, to: 80 })
  })

  it('keeps a caller-supplied timestamp', () => {
    appendEvent(dir, { timestamp: '2020-01-01T00:00:00.000Z', kind: 'apply' })
    expect(readAll(dir)[0].timestamp).toBe('2020-01-01T00:00:00.000Z')
  })

  it('rejects a non-object event', () => {
    expect(() => appendEvent(dir, 'nope')).toThrow()
    expect(() => appendEvent(dir, [1, 2])).toThrow()
    expect(fs.existsSync(telemetryFile(dir))).toBe(false)
  })
})
