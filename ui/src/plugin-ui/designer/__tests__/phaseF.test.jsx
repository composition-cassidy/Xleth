import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import BindingPicker, {
  getMeterSlotOptions,
  getParamPickerOptions,
  getVizSourceOptions,
} from '../BindingPicker.jsx'
import ToggleInspector from '../inspectors/ToggleInspector.jsx'
import VisualizerInspector from '../inspectors/VisualizerInspector.jsx'
import {
  buildKnobPatchForParam,
  buildMeterPatchForSlot,
  buildVisualizerPatchForSource,
  getPresetOptionsForSource,
  isMeterRangeValid,
} from '../inspectors/inspectorHelpers.js'
import { COMPRESSOR_MANIFEST } from '../../manifests/compressor.js'
import { COMPRESSOR_VISUALIZER_PRESETS } from '../../runtime/visualizers/compressorPainter.js'

describe('Phase F BindingPicker helpers', () => {
  it('param options come from the Compressor manifest', () => {
    const options = getParamPickerOptions(COMPRESSOR_MANIFEST, 'threshold')

    expect(options.map(option => option.value)).toContain('threshold')
    expect(options.find(option => option.value === 'threshold')?.label).toBe('Threshold (threshold)')
    expect(options.map(option => option.value)).not.toContain('not-a-param')
  })

  it('meter options use semantic keys, not raw numbers', () => {
    const options = getMeterSlotOptions(COMPRESSOR_MANIFEST, 'GAIN_REDUCTION')

    expect(options.map(option => option.value)).toEqual(['PEAK_L', 'PEAK_R', 'GAIN_REDUCTION'])
    expect(options.map(option => option.value)).not.toContain(2)
    expect(options.map(option => option.label)).not.toContain('2')
  })

  it('viz source options come from the manifest', () => {
    const options = getVizSourceOptions(COMPRESSOR_MANIFEST, 'compressor.combined')

    expect(options.map(option => option.value)).toEqual(COMPRESSOR_MANIFEST.vizSources)
  })

  it('unknown current bindings render as disabled removed options', () => {
    const options = getParamPickerOptions(COMPRESSOR_MANIFEST, 'removed.param')
    const removed = options[0]

    expect(removed).toMatchObject({
      value: 'removed.param',
      label: '(removed) removed.param',
      disabled: true,
      removed: true,
    })

    const html = renderToStaticMarkup(
      <BindingPicker kind="param" value="removed.param" manifest={COMPRESSOR_MANIFEST} onChange={() => {}} />,
    )
    expect(html).toContain('(removed) removed.param')
    expect(html).toContain('disabled=""')
  })
})

describe('Phase F inspector helpers', () => {
  it('buildKnobPatchForParam sets param and updates label/format defaults when appropriate', () => {
    const patch = buildKnobPatchForParam(
      { param: '<unset>', label: 'Knob', format: 'raw' },
      'threshold',
      COMPRESSOR_MANIFEST,
    )

    expect(patch).toEqual({
      param: 'threshold',
      label: 'Threshold',
      format: 'dB1',
      size: 52,
    })
  })

  it('ToggleInspector supports detect_mode valueWhenOn 0 and 1', () => {
    const peak = renderToStaticMarkup(
      <ToggleInspector
        node={{ id: 'peak', type: 'toggle', props: { param: 'detect_mode', mode: 'discreteValue', valueWhenOn: 0, label: 'Peak' } }}
        manifest={COMPRESSOR_MANIFEST}
        onPatchProps={() => ({ ok: true })}
      />,
    )
    const rms = renderToStaticMarkup(
      <ToggleInspector
        node={{ id: 'rms', type: 'toggle', props: { param: 'detect_mode', mode: 'discreteValue', valueWhenOn: 1, label: 'RMS' } }}
        manifest={COMPRESSOR_MANIFEST}
        onPatchProps={() => ({ ok: true })}
      />,
    )

    expect(peak).toContain('value="0"')
    expect(rms).toContain('value="1"')
  })

  it('buildMeterPatchForSlot keeps effectMeter and uses friendly generic labels', () => {
    expect(buildMeterPatchForSlot({ label: 'Meter' }, 'GAIN_REDUCTION')).toEqual({
      source: { kind: 'effectMeter', slot: 'GAIN_REDUCTION' },
      label: 'GR',
    })
  })

  it('MeterInspector range validation rejects range.min >= range.max', () => {
    expect(isMeterRangeValid({ min: 4, max: 4 })).toBe(false)
    expect(isMeterRangeValid({ min: 6, max: 4 })).toBe(false)
    expect(isMeterRangeValid({ min: 0, max: 4 })).toBe(true)
  })

  it('visualizer preset registry exposes compressorCombined and filters safely by source', () => {
    expect(COMPRESSOR_VISUALIZER_PRESETS.compressorCombined).toBeTruthy()

    const combinedOptions = getPresetOptionsForSource('compressor.combined')
    expect(combinedOptions.map(option => option.value)).toContain('compressorCombined')
    expect(combinedOptions.map(option => option.value)).not.toContain('detector')
  })

  it('VisualizerInspector rejects unknown source and repairs by picker', () => {
    expect(buildVisualizerPatchForSource({ preset: 'detector' }, 'removed.source', COMPRESSOR_MANIFEST)).toBeNull()
    expect(buildVisualizerPatchForSource({ preset: 'detector' }, 'compressor.combined', COMPRESSOR_MANIFEST)).toEqual({
      source: 'compressor.combined',
      preset: 'compressorCombined',
    })

    const html = renderToStaticMarkup(
      <VisualizerInspector
        node={{ id: 'viz', type: 'visualizer', props: { source: 'removed.source', preset: 'removedPreset', heightPx: 110 } }}
        manifest={COMPRESSOR_MANIFEST}
        onPatchProps={() => ({ ok: true })}
      />,
    )
    expect(html).toContain('(removed) removed.source')
    expect(html).toContain('Unknown visualizer source')
  })
})
