// Floating per-band inspector for the Parametric EQ.
//
// A small popup anchored near the selected node's on-screen position —
// like every other floating inspector in this app (EqBandPopup before it,
// context menus, the theme popover) — NOT a bar docked across the display.
// A wide docked bar was tried and it ate most of the screen and could
// cover the panel's own drag handle; this stays out of the way instead.

import React, { useRef, useLayoutEffect, useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Power, X, Copy, Trash2 } from 'lucide-react'
import { BAND_TYPES, BAND_MODES, CHANNEL_MODES, CHANNEL_META } from '../../stores/eqStore.js'
import { SVG_W, SVG_H, FREQ_MIN, FREQ_MAX, freqToX, dbToY_response, formatFreqValue, formatGainValue } from './eqGeometry.js'
import PluginUIKitKnob from '../../plugin-ui/runtime/components/PluginUIKitKnob.jsx'
import SelectedBandInspector from './SelectedBandInspector.jsx'
import XlethSelect from '../common/XlethSelect.jsx'

// Same knob look every other stock-effect panel uses (mixer Pan/Width ring).
const MIXER_RING_APPEARANCE = { preset: 'mixer-ring', sizePreset: 'inherit', labelPlacement: 'bottom' }
const FREQ_SKEW = 0.23
const Q_SKEW = 0.18
const fmtQ = (v) => v.toFixed(2)

// Knob + printed value below it, matching FilterPanel's FilterKnob convention.
function EqBandKnob({ value, min, max, def, skew, label, fmt, onChange }) {
  return (
    <div className="eqbp-knob-cell">
      <PluginUIKitKnob
        value={value} min={min} max={max} defaultValue={def} skew={skew || 1}
        label={label} formatValue={fmt} appearance={MIXER_RING_APPEARANCE}
        size={40} dragRange={160}
        onLiveChange={onChange} onCommit={onChange}
      />
      <div className="eqbp-knob-value">{fmt(value)}</div>
    </div>
  )
}

const ANCHOR_OFFSET = 14
const VIEWPORT_MARGIN = 8

export default function EqBandPanel({
  band, bandIndex, bandCount, svgRef, dbZoom, panelPos, grValue,
  linPhase, oversample,
  setBandParam, setBandChannel, removeBand, duplicateBand,
  onClose,
}) {
  const panelRef = useRef(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const confirmTimerRef = useRef(null)
  const colorVar = `--xleth-eq-ch-${band.channel || 'stereo'}`
  // Dynamic mode needs per-sample sidechain detection (incompatible with
  // linear-phase's block processing); Spectral mode additionally needs the
  // engine's non-oversampled FFT path.
  const modeOptions = BAND_MODES.map((label, i) => ({
    value: i,
    label,
    disabled: (i === 1 && linPhase) || (i === 2 && (linPhase || oversample > 0)),
  }))

  useLayoutEffect(() => {
    const el = panelRef.current
    const svg = svgRef?.current
    if (!el || !svg) return
    const svgRect = svg.getBoundingClientRect()
    const scaleX = svgRect.width / SVG_W
    const scaleY = svgRect.height / SVG_H
    const anchor = {
      x: svgRect.left + freqToX(band.freq) * scaleX,
      y: svgRect.top + dbToY_response(band.gain, dbZoom) * scaleY,
    }
    const rect = el.getBoundingClientRect()
    let left = anchor.x + ANCHOR_OFFSET
    let top = anchor.y + ANCHOR_OFFSET
    if (left + rect.width > window.innerWidth - VIEWPORT_MARGIN) left = anchor.x - rect.width - ANCHOR_OFFSET
    if (top + rect.height > window.innerHeight - VIEWPORT_MARGIN) top = anchor.y - rect.height - ANCHOR_OFFSET
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, window.innerWidth - rect.width - VIEWPORT_MARGIN))
    top = Math.max(VIEWPORT_MARGIN, Math.min(top, window.innerHeight - rect.height - VIEWPORT_MARGIN))
    el.style.left = `${left}px`
    el.style.top = `${top}px`
    // panelPos re-measures while the EQ window itself is being dragged.
  }, [svgRef, band.freq, band.gain, dbZoom, band.mode, panelPos])

  useEffect(() => {
    const handle = (e) => { if (panelRef.current && !panelRef.current.contains(e.target)) onClose() }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [onClose])

  useEffect(() => {
    const handle = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handle)
    return () => window.removeEventListener('keydown', handle)
  }, [onClose])

  useEffect(() => () => clearTimeout(confirmTimerRef.current), [])

  const handleDeleteRequest = () => {
    setConfirmDelete(true)
    clearTimeout(confirmTimerRef.current)
    confirmTimerRef.current = setTimeout(() => setConfirmDelete(false), 2000)
  }
  const handleDeleteConfirm = () => {
    clearTimeout(confirmTimerRef.current)
    removeBand(bandIndex)
    onClose()
  }

  return createPortal(
    <div ref={panelRef} className="eqbp" style={{ borderLeftColor: `var(${colorVar})` }} onMouseDown={(e) => e.stopPropagation()}>
      <div className="eqbp-header">
        <span className="eqbp-header-dot" style={{ background: `var(${colorVar})` }} />
        <span className="eqbp-header-title">Band {bandIndex + 1}</span>
        <span className="eqbp-header-count">{bandCount} total</span>
        <button className="eqbp-close" onClick={onClose} title="Close"><X size={12} /></button>
      </div>

      <div className="eqbp-knobs">
        <button
          className={`eqbp-power${band.enabled ? ' active' : ''}`}
          title={band.enabled ? 'Disable band' : 'Enable band'}
          onClick={() => setBandParam(bandIndex, 'enabled', band.enabled ? 0 : 1)}
        >
          <Power size={12} />
        </button>
        <EqBandKnob
          value={band.freq} min={FREQ_MIN} max={FREQ_MAX} def={1000} skew={FREQ_SKEW}
          label="FREQ" fmt={formatFreqValue}
          onChange={(v) => setBandParam(bandIndex, 'freq', Math.round(v * 10) / 10)}
        />
        <EqBandKnob
          value={band.gain} min={-30} max={30} def={0}
          label="GAIN" fmt={formatGainValue}
          onChange={(v) => setBandParam(bandIndex, 'gain', Math.round(v * 10) / 10)}
        />
        <EqBandKnob
          value={band.q} min={0.1} max={30} def={0.707} skew={Q_SKEW}
          label="Q" fmt={fmtQ}
          onChange={(v) => setBandParam(bandIndex, 'q', Math.round(v * 100) / 100)}
        />
      </div>

      <div className="eqbp-section">
        <div className="eqbp-section-label">Filter Shape</div>
        <div className="eqbp-shape-buttons">
          {BAND_TYPES.map((label, i) => (
            <button
              key={label}
              className={`eqbp-shape-btn${band.type === i ? ' active' : ''}`}
              onClick={() => setBandParam(bandIndex, 'type', i)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="eqbp-section">
        <div className="eqbp-section-label">Channel</div>
        <div className="eqbp-channel-row">
          {CHANNEL_MODES.map((ch) => {
            const meta = CHANNEL_META[ch]
            const active = (band.channel || 'stereo') === ch
            return (
              <button
                key={ch}
                className={`eqbp-channel-btn${active ? ' active' : ''}`}
                style={active ? { color: `var(--xleth-eq-ch-${ch})`, boxShadow: `inset 0 -2px 0 var(--xleth-eq-ch-${ch})` } : undefined}
                onClick={() => setBandChannel(bandIndex, ch)}
                title={`${meta.label} only`}
              >
                {meta.short}
              </button>
            )
          })}
        </div>
      </div>

      <div className="eqbp-section">
        <div className="eqbp-section-label">Mode</div>
        <XlethSelect
          className="eqbp-mode-select"
          ariaLabel="Band mode"
          value={band.mode || 0}
          options={modeOptions}
          onChange={(value) => setBandParam(bandIndex, 'mode', value)}
        />
      </div>

      {band.mode !== 0 && (
        <div className="eqbp-extend">
          <SelectedBandInspector
            band={band}
            bandIndex={bandIndex}
            setBandParam={setBandParam}
            grValue={grValue}
          />
        </div>
      )}

      <div className="eqbp-footer">
        {confirmDelete ? (
          <div className="eqbp-confirm">
            <span>Delete band?</span>
            <button onClick={handleDeleteConfirm}>Y</button>
            <button onClick={() => { clearTimeout(confirmTimerRef.current); setConfirmDelete(false) }}>N</button>
          </div>
        ) : (
          <>
            <button onClick={() => duplicateBand(bandIndex)}><Copy size={12} /><span>Duplicate</span></button>
            <button className="danger" onClick={handleDeleteRequest}><Trash2 size={12} /><span>Delete</span></button>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
