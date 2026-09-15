import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import MidiTrackRow from './MidiTrackRow.jsx'
import MidiDrumSubTrackRow from './MidiDrumSubTrackRow.jsx'
import {
  areBpmsEffectivelyEqual,
  buildMidiCommitOptions,
  buildMidiImportOptions,
  buildOutputTracks,
  buildSamplePickerItems,
  getEffectiveTempoOverride,
  resolveRowMode,
  MODE_NEW,
  MODE_UPDATE,
} from './MidiImportDialog.jsx'
import { findMatchingTrack } from './filenameMatch.js'
import { buildTargetOptions } from './MidiReimportModeSelect.jsx'

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
        // A row with no re-import target commits as a plain create, which is
        // the pre-re-import behaviour.
        mode: MODE_NEW,
        targetTrackId: -1,
      },
    ])
    expect(commitOptions.tempoOverride).toBe(false)
  })

  it('carries per-output-track transpose and dialog-level trim into the import payload', () => {
    const summary = {
      sourceTempo: 120,
      tracks: [
        { index: 0, name: 'Lead', noteCount: 12, isDrum: false },
        { index: 1, name: 'Bass', noteCount: 8, isDrum: false },
      ],
    }
    const trackOptions = {
      0: { enabled: true, splitByNote: false },
      1: { enabled: true, splitByNote: false },
    }
    const outputTracks = buildOutputTracks(summary.tracks, trackOptions)
    const outputTrackOptions = {
      0: { enabled: true, name: 'Lead', transposeSemitones: 12 },
      1: { enabled: true, name: 'Bass', transposeSemitones: -5 },
    }

    const importOptions = buildMidiImportOptions({
      summary,
      trackOptions,
      outputTracks,
      outputTrackOptions,
      projectBpm: 120,
      tempoOverride: true,
      trimLeadingSilence: true,
    })

    expect(importOptions.transposeByOutputTrack).toEqual([12, -5])
    expect(importOptions.trimLeadingSilence).toBe(true)
  })

  it('defaults transpose to 0 and trim to false when unset', () => {
    const summary = { sourceTempo: 120, tracks: [{ index: 0, name: 'Lead', noteCount: 4, isDrum: false }] }
    const trackOptions = { 0: { enabled: true, splitByNote: false } }
    const outputTracks = buildOutputTracks(summary.tracks, trackOptions)

    const importOptions = buildMidiImportOptions({
      summary,
      trackOptions,
      outputTracks,
      outputTrackOptions: { 0: { enabled: true, name: 'Lead' } },
      projectBpm: 120,
      tempoOverride: true,
    })

    expect(importOptions.transposeByOutputTrack).toEqual([0])
    expect(importOptions.trimLeadingSilence).toBe(false)
  })

  it('clamps an out-of-range transpose value before it reaches the wire payload', () => {
    const summary = { sourceTempo: 120, tracks: [{ index: 0, name: 'Lead', noteCount: 4, isDrum: false }] }
    const trackOptions = { 0: { enabled: true, splitByNote: false } }
    const outputTracks = buildOutputTracks(summary.tracks, trackOptions)

    const importOptions = buildMidiImportOptions({
      summary,
      trackOptions,
      outputTracks,
      outputTrackOptions: { 0: { enabled: true, name: 'Lead', transposeSemitones: 99 } },
      projectBpm: 120,
      tempoOverride: true,
    })

    expect(importOptions.transposeByOutputTrack).toEqual([24])
  })

  it('carries the resolved placement (position + tile-to-fill) into the commit payload', () => {
    const commitOptions = buildMidiCommitOptions({
      metadata: { sourceTempo: 120, outputTracks: [{ name: 'Lead' }] },
      summary: { sourceTempo: 120 },
      outputTrackOptions: { 0: { name: 'Lead', visualOnly: false, sampleId: -1 } },
      projectBpm: 120,
      tempoOverride: true,
      positionTicks: 15360,
      tileToFillProject: true,
    })

    expect(commitOptions.positionTicks).toBe(15360)
    expect(commitOptions.tileToFillProject).toBe(true)
  })

  it('defaults placement to start-of-timeline with no tiling when unset', () => {
    const commitOptions = buildMidiCommitOptions({
      metadata: { sourceTempo: 120, outputTracks: [{ name: 'Lead' }] },
      summary: { sourceTempo: 120 },
      outputTrackOptions: { 0: { name: 'Lead', visualOnly: false, sampleId: -1 } },
      projectBpm: 120,
      tempoOverride: true,
    })

    expect(commitOptions.positionTicks).toBe(0)
    expect(commitOptions.tileToFillProject).toBe(false)
  })

  it('commits an update row with its resolved target track', () => {
    const targets = [{ trackId: 9, name: 'Kick', eligible: true, patternCount: 1, regionId: 3 }]
    const commitOptions = buildMidiCommitOptions({
      metadata: { sourceTempo: 120, outputTracks: [{ name: 'Kick' }] },
      summary: { sourceTempo: 120 },
      outputTrackOptions: {
        0: { name: 'Kick', visualOnly: false, sampleId: 3, mode: MODE_UPDATE, targetTrackId: 9 },
      },
      projectBpm: 140,
      tempoOverride: true,
      reimportTargets: targets,
    })

    expect(commitOptions.outputTracks[0]).toMatchObject({
      mode: MODE_UPDATE,
      targetTrackId: 9,
      regionId: 3,
    })
  })

  it('falls back to a new track when the chosen target has vanished', () => {
    // The engine hard-fails an update into a missing track, which would drop the
    // notes on the floor; creating instead at least keeps the material.
    expect(resolveRowMode({ mode: MODE_UPDATE, targetTrackId: 9 }, []))
      .toEqual({ mode: MODE_NEW, targetTrackId: -1 })

    // An ineligible target (more than one distinct pattern on the track) is
    // treated the same way.
    expect(resolveRowMode(
      { mode: MODE_UPDATE, targetTrackId: 9 },
      [{ trackId: 9, name: 'Kick', eligible: false }],
    )).toEqual({ mode: MODE_NEW, targetTrackId: -1 })

    expect(resolveRowMode({ mode: MODE_NEW, targetTrackId: 9 }, []))
      .toEqual({ mode: MODE_NEW, targetTrackId: -1 })
  })

  it('suggests a re-import target by name, tie-breaking on the lowest trackId', () => {
    const targets = [
      { trackId: 12, name: 'Snare', eligible: true },
      { trackId: 4, name: 'Snare', eligible: true },
      { trackId: 7, name: 'Hat', eligible: true },
      { trackId: 2, name: 'Kick', eligible: false },
    ]

    expect(findMatchingTrack('Snare', targets).trackId).toBe(4)
    expect(findMatchingTrack('Hat', targets).trackId).toBe(7)
    // Ineligible targets are never suggested even on an exact name match.
    expect(findMatchingTrack('Kick', targets)).toBe(null)
    expect(findMatchingTrack('Nothing Like This', targets)).toBe(null)
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
    // No existing Pattern tracks were passed, so the target picker is hidden
    // rather than shown as a one-option dropdown.
    expect(html).not.toContain('Target')
  })

  it('renders the re-import target picker only when targets exist', () => {
    const row = targets => renderToStaticMarkup(
      <MidiTrackRow
        track={{ index: 0, name: 'Kick', noteCount: 12, isDrum: false }}
        parentOptions={{ enabled: true, splitByNote: false }}
        outputOptions={{
          outputTrackIndex: 0,
          sampleId: null,
          visualOnly: false,
          maxNoteLengthDenom: 0,
          mode: MODE_UPDATE,
          targetTrackId: 5,
        }}
        onParentChange={vi.fn()}
        onOutputChange={vi.fn()}
        sampleItems={[]}
        reimportTargets={targets}
      />
    )

    expect(row([])).not.toContain('Target')

    const html = row([
      { trackId: 5, name: 'Kick', eligible: true, patternCount: 1, regionId: 3 },
      { trackId: 6, name: 'Busy', eligible: false, patternCount: 3, regionId: -1 },
    ])
    // XlethSelect renders only the closed trigger, so the markup shows the
    // label and the SELECTED option; the option list is asserted below.
    expect(html).toContain('Target')
    expect(html).toContain('Update: Kick')
  })

  it('shows the transpose stepper for a melodic track but hides it for a drum track', () => {
    const melodicHtml = renderToStaticMarkup(
      <MidiTrackRow
        track={{ index: 0, name: 'Lead', noteCount: 12, isDrum: false }}
        parentOptions={{ enabled: true, splitByNote: false }}
        outputOptions={{ outputTrackIndex: 0, sampleId: null, visualOnly: false, transposeSemitones: 3 }}
        onParentChange={vi.fn()}
        onOutputChange={vi.fn()}
        sampleItems={[]}
      />
    )
    expect(melodicHtml).toContain('Transpose')
    expect(melodicHtml).toContain('midi-transpose-stepper')

    const drumHtml = renderToStaticMarkup(
      <MidiTrackRow
        track={{ index: 1, name: 'Drums', noteCount: 12, isDrum: true, uniqueNoteNumbers: [36] }}
        parentOptions={{ enabled: true, splitByNote: false }}
        outputOptions={{ outputTrackIndex: 0, sampleId: null, visualOnly: false }}
        onParentChange={vi.fn()}
        onOutputChange={vi.fn()}
        sampleItems={[]}
      />
    )
    expect(drumHtml).not.toContain('Transpose')
    expect(drumHtml).not.toContain('midi-transpose-stepper')
  })

  it('never shows a transpose control on a drum sub-track row', () => {
    const html = renderToStaticMarkup(
      <MidiDrumSubTrackRow
        noteNum={36}
        options={{ enabled: true, visualOnly: false, sampleId: null, outputTrackIndex: 0 }}
        onChange={vi.fn()}
        sampleItems={[]}
        reimportTargets={[]}
      />
    )
    expect(html).not.toContain('Transpose')
    expect(html).not.toContain('midi-transpose-stepper')
  })

  it('notes that Position/Tile are ignored on a row resolved to re-import', () => {
    const targets = [{ trackId: 5, name: 'Kick', eligible: true, patternCount: 1, regionId: 3 }]
    const html = renderToStaticMarkup(
      <MidiTrackRow
        track={{ index: 0, name: 'Kick', noteCount: 12, isDrum: false }}
        parentOptions={{ enabled: true, splitByNote: false }}
        outputOptions={{ outputTrackIndex: 0, sampleId: null, visualOnly: false, mode: MODE_UPDATE, targetTrackId: 5 }}
        onParentChange={vi.fn()}
        onOutputChange={vi.fn()}
        sampleItems={[]}
        reimportTargets={targets}
      />
    )
    expect(html).toContain('Position / Tile ignored')

    const createHtml = renderToStaticMarkup(
      <MidiTrackRow
        track={{ index: 0, name: 'Kick', noteCount: 12, isDrum: false }}
        parentOptions={{ enabled: true, splitByNote: false }}
        outputOptions={{ outputTrackIndex: 0, sampleId: null, visualOnly: false, mode: MODE_NEW, targetTrackId: -1 }}
        onParentChange={vi.fn()}
        onOutputChange={vi.fn()}
        sampleItems={[]}
        reimportTargets={targets}
      />
    )
    expect(createHtml).not.toContain('Position / Tile ignored')
  })

  it('offers New track plus every Pattern target, disabling ambiguous ones', () => {
    expect(buildTargetOptions([
      { trackId: 5, name: 'Kick', eligible: true, patternCount: 1 },
      { trackId: 6, name: 'Busy', eligible: false, patternCount: 3 },
    ])).toEqual([
      { value: MODE_NEW, label: 'New track' },
      { value: '5', label: 'Update: Kick', disabled: false },
      // An ambiguous track is shown, disabled, with why — not silently dropped,
      // which would read as the track having gone missing.
      { value: '6', label: 'Busy (3 patterns)', disabled: true },
    ])

    expect(buildTargetOptions([])).toEqual([{ value: MODE_NEW, label: 'New track' }])
  })
})
