import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearSamplePreviewCache, getCachedPreview, getSourceFingerprint } from './samplePreviewCache.js'

beforeEach(() => {
  clearSamplePreviewCache()
})

describe('samplePreviewCache', () => {
  it('shares one in-flight promise across concurrent callers for the same tile', async () => {
    const getFrameAtTime = vi.fn().mockResolvedValue('data:image/png;base64,AAA')

    const [a, b] = await Promise.all([
      getCachedPreview(getFrameAtTime, 1, 'file.mp4:2.5', 0.5, 96, 54),
      getCachedPreview(getFrameAtTime, 1, 'file.mp4:2.5', 0.5, 96, 54),
    ])

    expect(getFrameAtTime).toHaveBeenCalledTimes(1)
    expect(a).toBe('data:image/png;base64,AAA')
    expect(b).toBe('data:image/png;base64,AAA')
  })

  it('reuses a resolved cache entry for a later request with the same key', async () => {
    const getFrameAtTime = vi.fn().mockResolvedValue('data:image/png;base64,BBB')

    await getCachedPreview(getFrameAtTime, 1, 'file.mp4:2.5', 0.5, 96, 54)
    await getCachedPreview(getFrameAtTime, 1, 'file.mp4:2.5', 0.5, 96, 54)

    expect(getFrameAtTime).toHaveBeenCalledTimes(1)
  })

  it('issues a separate request when the fingerprint changes (source media changed)', async () => {
    const getFrameAtTime = vi.fn().mockResolvedValue('data:image/png;base64,CCC')

    await getCachedPreview(getFrameAtTime, 1, 'file.mp4:2.5', 0.5, 96, 54)
    await getCachedPreview(getFrameAtTime, 1, 'file.mp4:9.0', 0.5, 96, 54)

    expect(getFrameAtTime).toHaveBeenCalledTimes(2)
  })

  it('issues a separate request when dimensions or preview time differ', async () => {
    const getFrameAtTime = vi.fn().mockResolvedValue('data:image/png;base64,DDD')

    await getCachedPreview(getFrameAtTime, 1, 'file.mp4:2.5', 0.5, 96, 54)
    await getCachedPreview(getFrameAtTime, 1, 'file.mp4:2.5', 0.5, 144, 81)
    await getCachedPreview(getFrameAtTime, 1, 'file.mp4:2.5', 1.1, 96, 54)

    expect(getFrameAtTime).toHaveBeenCalledTimes(3)
  })

  it('resolves to null (never rejects) when getFrameAtTime fails, and still caches the failure', async () => {
    const getFrameAtTime = vi.fn().mockRejectedValue(new Error('decode failed'))

    const first = await getCachedPreview(getFrameAtTime, 1, 'file.mp4:2.5', 0.5, 96, 54)
    const second = await getCachedPreview(getFrameAtTime, 1, 'file.mp4:2.5', 0.5, 96, 54)

    expect(first).toBeNull()
    expect(second).toBeNull()
    expect(getFrameAtTime).toHaveBeenCalledTimes(1)
  })

  it('getSourceFingerprint combines filePath and duration, and is stable for missing fields', () => {
    expect(getSourceFingerprint({ filePath: 'a.mp4', duration: 3 })).toBe('a.mp4:3')
    expect(getSourceFingerprint({ filePath: 'a.mp4', duration: NaN })).toBe('a.mp4:')
    expect(getSourceFingerprint(null)).toBe('')
    expect(getSourceFingerprint({})).toBe(':')
  })
})
