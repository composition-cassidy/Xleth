import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import MidiTrackRow from './MidiTrackRow.jsx'
import {
  areBpmsEffectivelyEqual,
  buildMidiCommitOptions,
  buildMidiImportOptions,
  buildOutputTracks,
  buildSamplePickerItems,
  getEffectiveTempoOverride,
} from './MidiImportDialog.jsx'

describe('MIDI import modal helpers', () => {
  it('treats near-matching BPMs as a no-op tempo override', () => {
    expect(areBpmsEffectivelyEqual(120, 120.02)).toBe(true)
    expect(getEffectiveTempoOverride(true, 120, 120.02)).toBe(false)
  })

  it('allows tempo override when source and project BPM differ', () => {
    expect(areBpmsEffectivelyEqual(120, 121)).toBe(false)
    expect(getEffectiveTempoOverride(true, 120, 121)).toBe(true)
    expect(getEffectiveTempoOverride(false, 120, 121)).toBe(false)
    expect(getEffectiveTempoOverride(true, 120, null)).toBe(true)
  })

  it('keeps max-length, sample assignment, and visual-only payload contracts intact', () => {
    const summary = {
      sourceTempo: 120,
      tracks: [
        { index: 0, name: 'Lead', noteCount: 12, isDrum: false },
      ],
    }
    const trackOptions = { 0: { enabled: true, splitByNote: false } }
    const outputTracks = buildOutputTracks(summary.tracks, trackOptions)
    const outputTrackOptions = {
      0: {
        enabled: true,
        name: 'Lead',
        sampleId: 42,
        visualOnly: true,
        maxNoteLengthDenom: 16,
      },
    }

    const importOptions = buildMidiImportOptions({
      summary,
      trackOptions,
      outputTracks,
      outputTrackOptions,
      projectBpm: 120,
      tempoOverride: true,
    })

    expect(importOptions).toMatchObject({
      enabledTrackIndices: [0],
      perTrackOptions: { 0: { splitDrums: false, enabledSubNotes: [] } },
      tempoOverride: false,
      projectBPM: 120,
      maxNoteLengthByOutputTrack: [240],
    })

    const commitOptions = buildMidiCommitOptions({
      metadata: { sourceTempo: 120, outputTracks: [{ name: 'Lead' }] },
      summary,
      outputTrackOptions,
      projectBpm: 120,
      tempoOverride: true,
    })

    expect(commitOptions.outputTracks).toEqual([
      {
        outputTrackIndex: 0,
        name: 'Lead',
        visualOnly: true,
        regionId: 42,
      },
    ])
    expect(commitOptions.tempoOverride).toBe(false)
  })

  it('joins existing regions to existing sources for the sample rail', () => {
    const items = buildSamplePickerItems(
      [
        { id: 7, sourceId: 3, name: 'Kick', startTime: 1, endTime: 2 },
        { id: 8, sourceId: 4, label: 'Snare label', startTime: 0 },
      ],
      [
        { id: 3, fileName: 'kick.mov', filePath: 'C:\\media\\kick.mov', hasVideo: true },
        { id: 4, fileName: 'snare.wav', filePath: 'C:\\media\\snare.wav', hasVideo: false },
      ]
    )

    expect(items[0]).toMatchObject({
      id: 7,
      name: 'Kick',
      subLabel: 'kick.mov',
      source: { id: 3, fileName: 'kick.mov' },
      previewTime: 1.1,
    })
    expect(items[1]).toMatchObject({
      id: 8,
      name: 'Snare label',
      subLabel: 'snare.wav',
      source: { id: 4, fileName: 'snare.wav' },
    })
  })
})

describe('MidiTrackRow redesigned layout', () => {
  it('renders the rail and themed max-length control without repeated warning copy', () => {
    const html = renderToStaticMarkup(
      <MidiTrackRow
        track={{ index: 0, name: 'Lead', noteCount: 12, isDrum: false, hasPitchBend: true }}
        parentOptions={{ enabled: true, splitByNote: false }}
        outputOptions={{
          outputTrackIndex: 0,
          sampleId: null,
          visualOnly: false,
          maxNoteLengthDenom: 0,
        }}
        onParentChange={vi.fn()}
        onOutputChange={vi.fn()}
        sampleItems={[{ id: 42, name: 'Lead Sample', source: { id: 1, hasVideo: false } }]}
      />
    )

    expect(html).toContain('midi-sample-rail')
    expect(html).toContain('Lead Sample')
    expect(html).toContain('Max Length')
    expect(html).toContain('Visual only')
    expect(html).not.toContain('<select')
    expect(html).not.toContain('Pitch bend will be discarded')
    expect(html).not.toContain('This track will import without a sample assignment')
  })
})
