// Pure component — all data arrives via props, no store hooks.
// This makes it directly renderable with react-dom/server.renderToStaticMarkup
// in the node test environment (no jsdom required).

import React from 'react'
import { DYN_FIELDS, SPEC_FIELDS, getInspectorFields, inspectorHasGR } from './eqInspectorConfig.js'
import EqInspectorKnob from './EqInspectorKnob.jsx'

const BAND_MODE_NAMES = ['Static', 'Dynamic', 'Spectral']

export default function SelectedBandInspector({ band, bandIndex, setBandParam, grValue }) {
  // No band selected
  if (!band || bandIndex < 0) {
    return (
      <div className="eq-selected-band-inspector eq-selected-band-empty">
        Select a band to edit dynamics.
      </div>
    )
  }

  const modeName = BAND_MODE_NAMES[band.mode] ?? 'Static'
  const fields   = getInspectorFields(band.mode)
  const showGR   = inspectorHasGR(band.mode)
  const grMag    = Math.abs(grValue ?? 0)

  const handleChange = (key, value) => setBandParam(bandIndex, key, value)

  // Static band — no extra fields
  if (band.mode === 0 || fields.length === 0) {
    return (
      <div className="eq-selected-band-inspector">
        <div className="eq-selected-band-header">Band {bandIndex + 1} · {modeName}</div>
        <div className="eq-selected-band-empty-msg">No extra controls for static bands.</div>
      </div>
    )
  }

  const modeSlug = band.mode === 1 ? 'dynamic' : 'spectral'
  const accentCssVar = band.mode === 1 ? '--xleth-eq-mode-dynamic' : '--xleth-eq-mode-spectral'

  return (
    <div className={`eq-selected-band-inspector eq-selected-band-inspector--${modeSlug}`}>
      <div className="eq-selected-band-header">Band {bandIndex + 1} · {modeName}</div>
      <div className="eq-selected-band-fields eq-inspector-knob-grid">
        {fields.map(field => (
          <EqInspectorKnob
            key={field.key}
            field={field}
            value={band[field.key] ?? field.def}
            onChange={handleChange}
            isBipolar={field.key === 'spec_depth'}
            accentCssVar={accentCssVar}
          />
        ))}
        {showGR && grMag > 0.1 && (
          <div className="eq-selected-band-gr">
            <div className="eq-gr-bar">
              <div
                className="eq-gr-fill"
                style={{
                  width: `${Math.min(100, grMag * 3)}%`,
                  background: (grValue ?? 0) >= 0
                    ? 'var(--xleth-eq-gr-boost)'
                    : 'var(--xleth-eq-gr-cut)',
                }}
              />
              <span>{(grValue ?? 0).toFixed(1)} dB</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// Named exports for test isolation
export { DYN_FIELDS, SPEC_FIELDS }
