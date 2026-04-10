import { useState, useEffect, useCallback } from 'react'
import { timelineEvents } from '../../timelineEvents.js'
import SyllableSplitter from './SyllableSplitter.jsx'

/**
 * Modal wrapper around SyllableSplitter, opened from Sample Selector's
 * right-click menu on a Quote region.
 *
 * Props:
 *   isOpen  – boolean
 *   region  – the Quote region to edit (must have .id, .startTime, .endTime, .sourceId, .audioFilePath)
 *   onClose – () => void
 */
export default function SyllableSplitterModal({ isOpen, region, onClose }) {
  const [sourceFilePath, setSourceFilePath] = useState(null)
  const [regionWaveform, setRegionWaveform] = useState(null)  // { peaks, duration }
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)

  // On open: look up source file path and fetch region-sliced waveform
  useEffect(() => {
    if (!isOpen || !region) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setRegionWaveform(null)
    setSourceFilePath(null)

    ;(async () => {
      try {
        // Resolve sourceFilePath from the region's sourceId
        const sources = (await window.xleth?.timeline?.getSources?.()) ?? []
        const src = sources.find(s => s.id === region.sourceId)
        const filePath = src?.filePath
        if (!filePath) {
          throw new Error(`Source ${region.sourceId} not found`)
        }
        if (cancelled) return
        setSourceFilePath(filePath)

        // Pre-load the source audio for preview playback
        window.xleth?.audio?.loadSource(filePath).catch(() => {})

        // Fetch peaks — try regionId first (applies SampleProcessor transforms),
        // fall back to file-based peaks (works for all formats via FFmpeg)
        let raw = await window.xleth?.waveform?.getRegionPeaks?.(
          region.id, region.startTime, region.endTime, 1200, -1)
        if ((!raw || !raw.peaks?.length) && filePath) {
          raw = await window.xleth?.waveform?.getFilePeaks?.(
            filePath, region.startTime, region.endTime, 1200, -1)
        }
        if (cancelled) return
        if (raw && raw.peaks?.length > 0) {
          setRegionWaveform({
            peaks: raw.peaks,
            duration: (region.endTime - region.startTime),
            stride: 3,
          })
        } else {
          setError('Could not load waveform')
        }
      } catch (e) {
        if (!cancelled) setError(e.message || String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [isOpen, region])

  const handleSave = useCallback(async (syllables) => {
    if (!region) return
    try {
      await window.xleth?.timeline?.setSyllables(region.id, syllables)
      timelineEvents.dispatchEvent(new Event('timeline-regions-changed'))
      onClose?.()
    } catch (e) {
      console.error('[SyllableSplitterModal] setSyllables failed:', e)
      setError(e.message || String(e))
    }
  }, [region, onClose])

  if (!isOpen || !region) return null

  return (
    <div className="export-dialog-backdrop" onClick={onClose}>
      <div className="syllable-splitter-modal" onClick={(e) => e.stopPropagation()}>
        <div className="export-dialog-header">
          <span>Split Syllables — {region.name || 'Quote'}</span>
          <button className="export-dialog-close" onClick={onClose} title="Close">×</button>
        </div>
        <div className="syllable-splitter-modal-body">
          {loading && <div className="syllable-splitter-loading">Loading waveform…</div>}
          {error && <div className="syllable-splitter-error">{error}</div>}
          {!loading && !error && (
            <SyllableSplitter
              region={region}
              sourceFilePath={sourceFilePath}
              regionWaveform={regionWaveform}
              onSave={handleSave}
            />
          )}
        </div>
      </div>
    </div>
  )
}
