import { describe, expect, it } from 'vitest'
import { formatPreviewTime } from './PreviewTimecode.jsx'

describe('formatPreviewTime', () => {
  it('starts at zero', () => {
    expect(formatPreviewTime(0, 30)).toEqual({ timecode: '00:00:00:00', frame: 0 })
  })

  it('counts frames at the project rate', () => {
    expect(formatPreviewTime(1000, 30)).toEqual({ timecode: '00:00:01:00', frame: 30 })
    expect(formatPreviewTime(1034, 30).timecode).toBe('00:00:01:01')
    expect(formatPreviewTime(1999, 60)).toEqual({ timecode: '00:00:01:59', frame: 119 })
  })

  it('rolls minutes and hours', () => {
    expect(formatPreviewTime(3_723_500, 24).timecode).toBe('01:02:03:12')
  })

  it('never goes negative and falls back to 30 fps', () => {
    expect(formatPreviewTime(-50, 30).frame).toBe(0)
    expect(formatPreviewTime(1000, 0).frame).toBe(30)
  })
})
