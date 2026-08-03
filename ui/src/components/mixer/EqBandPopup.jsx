// Floating per-band popup for the Parametric EQ.
//
// Replaces the old bottom band table + selected-band footer: clicking a band
// orb opens this panel anchored near the orb instead. Portaled to
// document.body (position: fixed) so it can overflow the .eq-panel's own
// bounds — it must never feel clipped or crammed against the window edge.

import React, { useState, useRef, useLayoutEffect, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Power, X, Copy, RotateCcw, Trash2 } from 'lucide-react'
import { BAND_TYPES, BAND_MODES, BAND_COLORS } from '../../stores/eqStore.js'
import { Q_FIELD } from './eqInspectorConfig.js'
import EqInspectorKnob from './EqInspectorKnob.jsx'
import SelectedBandInspector from './SelectedBandInspector.jsx'
import XlethSelect from '../common/XlethSelect.jsx'

const ANCHOR_OFFSET = 14
const VIEWPORT_MARGIN = 8

// Static — BAND_TYPES never changes at runtime.
const BAND_TYPE_OPTIONS = BAND_TYPES.map((label, i) => ({ value: i, label }))

export default function EqBandPopup({
  band, bandIndex, anchor,
  linPhase, oversample, grValue,
  setBandParam, removeBand, duplicateBand,
  onClose,
}) {
  const popRef = useRef(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const confirmTimerRef = useRef(null)
  const color = BAND_COLORS[bandIndex % BAND_COLORS.length]
  const modeOptions = BAND_MODES.map((label, i) => ({
    value: i,
    label,
    disabled: (i === 1 && linPhase) || (i === 2 && (linPhase || oversample > 0)),
  }))

  // Position near the orb, flipping/clamping to the actual viewport (not the
  // eq-panel's bounds) once the real rendered size is known.
  useLayoutEffect(() => {
    const el = popRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let left = anchor.x + ANCHOR_OFFSET
    let top = anchor.y + ANCHOR_OFFSET
    if (left + rect.width > window.innerWidth - VIEWPORT_MARGIN) {
      left = anchor.x - rect.width - ANCHOR_OFFSET
    }
    if (top + rect.height > window.innerHeight - VIEWPORT_MARGIN) {
      top = anchor.y - rect.height - ANCHOR_OFFSET
    }
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, window.innerWidth - rect.width - VIEWPORT_MARGIN))
    top = Math.max(VIEWPORT_MARGIN, Math.min(top, window.innerHeight - rect.height - VIEWPORT_MARGIN))
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }, [anchor.x, anchor.y, band.mode])

  // Outside click closes the popup (mirrors the theme/overflow popover convention).
  useEffect(() => {
    const handle = (e) => {
      if (popRef.current && !popRef.current.contains(e.target)) onClose()
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [onClose])

  useEffect(() => {
    const handle = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handle)
    return () => window.removeEventListener('keydown', handle)
  }, [onClose])

  useEffect(() => () => clearTimeout(confirmTimerRef.current), [])

  const handleDuplicate = () => duplicateBand(bandIndex)

  const handleReset = () => {
    setBandParam(bandIndex, 'freq', 1000)
    setBandParam(bandIndex, 'gain', 0)
    setBandParam(bandIndex, 'q', 0.707)
    setBandParam(bandIndex, 'type', 0)
    setBandParam(bandIndex, 'enabled', 1)
  }

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
    <div
      ref={popRef}
      className="eq-band-popup"
      style={{
        left: anchor.x + ANCHOR_OFFSET,
        top: anchor.y + ANCHOR_OFFSET,
        borderLeftColor: color,
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="eq-band-popup-header">
        <span className="eq-band-popup-color" style={{ background: color }} />
        <span className="eq-band-popup-title">Band {bandIndex + 1}</span>
        <button className="eq-band-popup-close" onClick={onClose} title="Close">
          <X size={13} />
        </button>
      </div>

      <div className="eq-band-popup-controls">
        <div className="eq-band-popup-primary">
          <button
            className={`eq-band-popup-power${band.enabled ? ' active' : ''}`}
            title={band.enabled ? 'Disable band' : 'Enable band'}
            onClick={() => setBandParam(bandIndex, 'enabled', band.enabled ? 0 : 1)}
          >
            <Power size={12} />
          </button>
          <EqInspectorKnob
            field={Q_FIELD}
            value={band.q}
            onChange={(key, value) => setBandParam(bandIndex, key, value)}
          />
        </div>

        <div className="eq-band-popup-selects">
          <XlethSelect
            className="eq-band-popup-select"
            ariaLabel="Band type"
            value={band.type}
            options={BAND_TYPE_OPTIONS}
            onChange={(value) => setBandParam(bandIndex, 'type', value)}
          />

          <XlethSelect
            className="eq-band-popup-select"
            ariaLabel="Band mode"
            value={band.mode || 0}
            options={modeOptions}
            onChange={(value) => setBandParam(bandIndex, 'mode', value)}
          />
        </div>
      </div>

      {/* Extends to reveal Dynamic/Spectral fields — reuses the existing
          inspector rather than rebuilding the knob grid. */}
      {band.mode !== 0 && (
        <div className="eq-band-popup-extend">
          <SelectedBandInspector
            band={band}
            bandIndex={bandIndex}
            setBandParam={setBandParam}
            grValue={grValue}
          />
        </div>
      )}

      <div className="eq-band-popup-footer">
        {confirmDelete ? (
          <div className="eq-band-popup-confirm">
            <span>Delete band?</span>
            <button onClick={handleDeleteConfirm}>Y</button>
            <button onClick={() => { clearTimeout(confirmTimerRef.current); setConfirmDelete(false) }}>N</button>
          </div>
        ) : (
          <>
            <button onClick={handleDuplicate}><Copy size={12} /><span>Duplicate</span></button>
            <button onClick={handleReset}><RotateCcw size={12} /><span>Reset</span></button>
            <button className="danger" onClick={handleDeleteRequest}><Trash2 size={12} /><span>Delete</span></button>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
