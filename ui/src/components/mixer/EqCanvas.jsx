import React, { useMemo, memo, useRef, useState, useEffect } from 'react'
import { CHANNEL_META } from '../../stores/eqStore.js'
import { isFillableBandType, sampleBandResponseDb } from './eqBandCurve.js'
import {
  SVG_W, SVG_H, PAD_L, PAD_R, PAD_T, PLOT_W, PLOT_H,
  FREQ_MIN, FREQ_MAX, RESPONSE_SIZE,
  freqToX, dbToY_response, dbToY_analyzerWithRange,
  clamp, freqToNote, formatFreqValue, formatGainValue,
} from './eqGeometry.js'

const FREQ_GRID = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
const FREQ_LABELS = ['20', '50', '100', '200', '500', '1k', '2k', '5k', '10k', '20k']
const ANA_DB_LINES = [-80, -60, -40, -20, 0]

const channelColorVar = (channel) => `--xleth-eq-ch-${channel || 'stereo'}`

// Grid — flat dashed reference lines, no gradients.
const EqGrid = memo(function EqGrid({ dbZoom, rangeDb }) {
  const respLines = [-dbZoom, -dbZoom / 2, 0, dbZoom / 2, dbZoom]
  const botDb = 12 - rangeDb
  const visibleAnaLines = ANA_DB_LINES.filter(db => db >= botDb)
  return (
    <g className="eqc-grid">
      {FREQ_GRID.map((f, i) => {
        const x = freqToX(f)
        return (
          <g key={`f${f}`}>
            <line x1={x} y1={PAD_T} x2={x} y2={PAD_T + PLOT_H} className="eqc-grid-line" />
            <text x={x} y={SVG_H - 3} className="eqc-grid-label-x">{FREQ_LABELS[i]}</text>
          </g>
        )
      })}
      {visibleAnaLines.map(db => {
        const y = dbToY_analyzerWithRange(db, rangeDb)
        return (
          <g key={`ana${db}`}>
            <line x1={PAD_L} y1={y} x2={PAD_L + PLOT_W} y2={y} className="eqc-grid-line-ana" />
            <text x={PAD_L - 4} y={y + 3} className="eqc-grid-label-ana" textAnchor="end">{db}</text>
          </g>
        )
      })}
      {respLines.map(db => (
        <g key={`resp${db}`}>
          <line x1={PAD_L} y1={dbToY_response(db, dbZoom)} x2={PAD_L + PLOT_W} y2={dbToY_response(db, dbZoom)}
            className={db === 0 ? 'eqc-grid-line-zero' : 'eqc-grid-line-resp'} />
          <text x={PAD_L + PLOT_W + 4} y={dbToY_response(db, dbZoom) + 3} className="eqc-grid-label-resp" textAnchor="start">
            {db > 0 ? `+${db}` : db}
          </text>
        </g>
      ))}
    </g>
  )
})

// Flat band node — colored ring (channel tint), filled center, id/channel badge.
//
// The SVG stretches its 640x280 viewBox independently on X and Y to fill
// whatever box the panel gives it (preserveAspectRatio="none", so drag/wheel
// math stays a simple full-fill scale). A circle drawn with a plain equal
// radius in that viewBox would come out an ellipse on screen wherever the
// box's aspect ratio isn't 640:280 — vPerPx/hPerPx pre-warp every rx/ry (and
// vertical offsets) by the inverse of that stretch so nodes always render
// as true circles in real screen pixels, regardless of panel size.
function BandNode({ band, index, dbZoom, isSelected, isActive, hPerPx, vPerPx, onDragStart, onEnter, onLeave }) {
  const cx = freqToX(band.freq)
  const cy = dbToY_response(band.gain, dbZoom)
  const colorVar = `var(${channelColorVar(band.channel)})`
  const opacity = band.enabled ? 1 : 0.3
  const showBadge = (band.channel && band.channel !== 'stereo') || isActive

  return (
    <g
      className={`eqc-node${isSelected ? ' selected' : ''}`}
      opacity={opacity}
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onDragStart(index, e) }}
      onMouseEnter={() => onEnter(index)}
      onMouseLeave={() => onLeave(index)}
    >
      <ellipse cx={cx} cy={cy} rx={12 * hPerPx} ry={12 * vPerPx} fill="transparent" style={{ cursor: 'grab' }} />
      {isActive && (
        <rect
          x={cx - 10 * hPerPx} y={cy - 10 * vPerPx} width={20 * hPerPx} height={20 * vPerPx}
          fill="none" stroke={colorVar} strokeWidth={1} opacity={0.6} pointerEvents="none"
        />
      )}
      <ellipse
        cx={cx} cy={cy} rx={6 * hPerPx} ry={6 * vPerPx}
        fill={isActive ? 'var(--xleth-flat-text)' : 'var(--xleth-flat-panel)'}
        stroke={colorVar}
        strokeWidth={2}
        pointerEvents="none"
      />
      {showBadge && (
        <text x={cx} y={cy + 19 * vPerPx} className="eqc-node-badge" fill={colorVar} textAnchor="middle" pointerEvents="none">
          {band.channel && band.channel !== 'stereo' ? `${index + 1}·${CHANNEL_META[band.channel].short}` : index + 1}
        </text>
      )}
    </g>
  )
}

export default function EqCanvas({
  svgRef, bands, selectedBandIndex, dbZoom, rangeDb,
  responsePath, spectrumPaths, preSpectrumPaths, hoverReadout,
  hoveredIndex, onHoverBand,
  onWheel, onMouseDown, onMouseMove, onMouseLeave, onBandDragStart,
}) {
  // Selection gets the full detail chip (persists regardless of hover); a
  // plain hover only earns a small subtext label — full detail is for when
  // you actually want a closer look, not for casually mousing past a node.
  const selectedBand = selectedBandIndex >= 0 ? bands[selectedBandIndex] : null
  const hoverOnlyBand = hoveredIndex != null && hoveredIndex !== selectedBandIndex ? bands[hoveredIndex] : null

  // Tracks the SVG's real rendered pixel box so node markers can pre-warp
  // themselves against the viewBox's independent X/Y stretch — see the
  // BandNode comment above for why this is needed to keep them circular.
  const wrapRef = useRef(null)
  const [renderSize, setRenderSize] = useState({ w: SVG_W, h: SVG_H })
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r && r.width > 0 && r.height > 0) setRenderSize({ w: r.width, h: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const hPerPx = SVG_W / renderSize.w
  const vPerPx = SVG_H / renderSize.h

  const bandFills = useMemo(() => {
    const sampleFreqs = []
    for (let i = 0; i < RESPONSE_SIZE; i++) {
      const t = i / (RESPONSE_SIZE - 1)
      sampleFreqs.push(Math.exp(Math.log(FREQ_MIN) + t * (Math.log(FREQ_MAX) - Math.log(FREQ_MIN))))
    }
    const y0 = dbToY_response(0, dbZoom)
    return bands.map((b, i) => {
      if (!b.enabled || !isFillableBandType(b.type)) return null
      const resp = sampleBandResponseDb(b, sampleFreqs)
      let d = `M ${freqToX(sampleFreqs[0]).toFixed(2)} ${dbToY_response(clamp(resp[0], -dbZoom, dbZoom), dbZoom).toFixed(2)} `
      for (let k = 1; k < RESPONSE_SIZE; k++) {
        d += `L ${freqToX(sampleFreqs[k]).toFixed(2)} ${dbToY_response(clamp(resp[k], -dbZoom, dbZoom), dbZoom).toFixed(2)} `
      }
      for (let k = RESPONSE_SIZE - 1; k >= 0; k--) {
        d += `L ${freqToX(sampleFreqs[k]).toFixed(2)} ${y0.toFixed(2)} `
      }
      return { index: i, d, colorVar: channelColorVar(b.channel) }
    })
  }, [bands, dbZoom])

  return (
    <div className="eqc-wrap" ref={wrapRef}>
      <svg ref={svgRef} className="eqc-svg" viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        preserveAspectRatio="none" onWheel={onWheel}
        onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseLeave={onMouseLeave}>
        <rect x={PAD_L} y={PAD_T} width={PLOT_W} height={PLOT_H} className="eqc-plot-bg" />
        <EqGrid dbZoom={dbZoom} rangeDb={rangeDb} />

        {preSpectrumPaths?.fill && (
          <path d={preSpectrumPaths.fill} className="eqc-spectrum-pre-fill" />
        )}
        {preSpectrumPaths?.maxHold && (
          <path d={preSpectrumPaths.maxHold} className="eqc-spectrum-pre-hold" />
        )}
        {spectrumPaths?.fill && (
          <path d={spectrumPaths.fill} className="eqc-spectrum-fill" />
        )}
        {spectrumPaths?.maxHold && (
          <path d={spectrumPaths.maxHold} className="eqc-spectrum-hold" />
        )}

        {bandFills.map(f => f && (
          <path key={`fill-${f.index}`} d={f.d} fill={`var(${f.colorVar})`}
            opacity={selectedBandIndex === f.index ? 0.16 : 0.05} pointerEvents="none" />
        ))}

        {responsePath && <path d={responsePath} className="eqc-response-line" />}

        {bands.map((band, i) => (
          <BandNode
            key={i} band={band} index={i} dbZoom={dbZoom}
            isSelected={i === selectedBandIndex}
            isActive={i === selectedBandIndex || i === hoveredIndex}
            hPerPx={hPerPx} vPerPx={vPerPx}
            onDragStart={onBandDragStart}
            onEnter={onHoverBand}
            onLeave={() => onHoverBand(null)}
          />
        ))}
      </svg>

      {selectedBand && (
        <div
          className="eqc-chip"
          style={{
            left: `${clamp((freqToX(selectedBand.freq) / SVG_W) * 100, 14, 86)}%`,
            top: `${clamp(((dbToY_response(selectedBand.gain, dbZoom) - 74) / SVG_H) * 100, 2, 60)}%`,
            borderTopColor: `var(${channelColorVar(selectedBand.channel)})`,
          }}
        >
          <div className="eqc-chip-freq">{formatFreqValue(selectedBand.freq)}</div>
          <div className="eqc-chip-note">{freqToNote(selectedBand.freq)}</div>
          <div className="eqc-chip-gain">
            {formatGainValue(selectedBand.gain)}
            <span className="eqc-chip-q"> · Q {selectedBand.q.toFixed(2)}</span>
          </div>
          <div className="eqc-chip-channel" style={{ color: `var(${channelColorVar(selectedBand.channel)})` }}>
            {CHANNEL_META[selectedBand.channel || 'stereo'].label}
          </div>
        </div>
      )}

      {hoverOnlyBand && (
        <div
          className="eqc-hover-label"
          style={{
            left: `${clamp((freqToX(hoverOnlyBand.freq) / SVG_W) * 100, 4, 96)}%`,
            top: `${clamp(((dbToY_response(hoverOnlyBand.gain, dbZoom) - 26) / SVG_H) * 100, 2, 92)}%`,
          }}
        >
          {formatFreqValue(hoverOnlyBand.freq)} · {formatGainValue(hoverOnlyBand.gain)}
        </div>
      )}

      {hoverReadout && <div className="eqc-hover-readout">{hoverReadout}</div>}
    </div>
  )
}
