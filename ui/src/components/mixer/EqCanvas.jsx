import React, { useMemo, memo, useRef, useState, useEffect } from 'react'
import { formatValue } from '../../ui-kit'
import { CHANNEL_META } from '../../stores/eqStore.js'
import { isFillableBandType, sampleBandResponseDb } from './eqBandCurve.js'
import { CORE_UPWARD_HINT, coreBandFillDb, coreSpectralStatus, isActiveSpectral } from './eqCoreSpectral.js'
import {
  SVG_W, SVG_H, PAD_L, PAD_T, PLOT_W, PLOT_H,
  FREQ_MIN, FREQ_MAX, RESPONSE_SIZE,
  freqToX, dbToY_response, dbToY_analyzerWithRange,
  clamp, freqToNote,
} from './eqGeometry.js'
import styles from './EqCanvas.module.css'

const FREQ_GRID = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
const FREQ_LABELS = ['20', '50', '100', '200', '500', '1k', '2k', '5k', '10k', '20k']
const ANA_DB_LINES = [-80, -60, -40, -20, 0]

// The ruler speaks two vocabularies at once: Hz with the nearest note name along
// the bottom, and the band names along the top (short enough to fit the
// 20 Hz to 20 kHz log axis at the display's width).
const BAND_NAMES = [
  { name: 'SUB', lo: 20, hi: 60 },
  { name: 'BASS', lo: 60, hi: 250 },
  { name: 'LOW MID', lo: 250, hi: 500 },
  { name: 'MID', lo: 500, hi: 2000 },
  { name: 'HI MID', lo: 2000, hi: 4000 },
  { name: 'PRS', lo: 4000, hi: 6000 },
  { name: 'TREBLE', lo: 6000, hi: 20000 },
]
const noteName = (f) => freqToNote(f).split(' ')[0]

const channelColorVar = (channel) => `--xleth-eq-ch-${channel || 'stereo'}`
const ROUTED_TRACE_ORDER = ['left', 'right', 'mid', 'side']

// Text in a viewBox that is stretched independently on X and Y would squash.
// Each label is placed in viewBox units and counter-scaled by the real pixel
// ratio, so it is a true 10px glyph at any display size.
function Txt({ x, y, h, v, anchor = 'middle', className, children }) {
  return (
    <text
      transform={`translate(${x} ${y}) scale(${h} ${v})`}
      textAnchor={anchor}
      className={className}
    >
      {children}
    </text>
  )
}

const EqGrid = memo(function EqGrid({ dbZoom, rangeDb, h, v }) {
  const respLines = [-dbZoom, -dbZoom / 2, 0, dbZoom / 2, dbZoom]
  const botDb = 12 - rangeDb
  const visibleAnaLines = ANA_DB_LINES.filter((db) => db >= botDb)
  return (
    <g>
      {BAND_NAMES.map((b) => {
        const x0 = freqToX(b.lo)
        const x1 = freqToX(b.hi)
        return (
          <g key={b.name}>
            {b.lo > FREQ_MIN ? <line x1={x0} y1={PAD_T} x2={x0} y2={PAD_T + 14 * v} className={styles.bandEdge} /> : null}
            <Txt x={(x0 + x1) / 2} y={PAD_T + 11 * v} h={h} v={v} className={styles.bandName}>{b.name}</Txt>
          </g>
        )
      })}
      {FREQ_GRID.map((f, i) => {
        const x = freqToX(f)
        const last = i === FREQ_GRID.length - 1
        const first = i === 0
        return (
          <g key={`f${f}`}>
            <line x1={x} y1={PAD_T} x2={x} y2={PAD_T + PLOT_H} className={styles.gridLine} />
            <Txt x={x} y={SVG_H - 4 * v} h={h} v={v} anchor={last ? 'end' : first ? 'start' : 'middle'} className={styles.label}>
              {FREQ_LABELS[i]}
              {last ? null : <tspan className={styles.labelDim}>{` ${noteName(f)}`}</tspan>}
            </Txt>
          </g>
        )
      })}
      {visibleAnaLines.map((db) => {
        const y = dbToY_analyzerWithRange(db, rangeDb)
        return (
          <g key={`ana${db}`}>
            <line x1={PAD_L} y1={y} x2={PAD_L + PLOT_W} y2={y} className={styles.gridAna} />
            <Txt x={PAD_L - 4 * h} y={y + 3.5 * v} h={h} v={v} anchor="end" className={`${styles.label} ${styles.labelDim}`}>{db}</Txt>
          </g>
        )
      })}
      {respLines.map((db) => {
        const y = dbToY_response(db, dbZoom)
        return (
          <g key={`resp${db}`}>
            <line x1={PAD_L} y1={y} x2={PAD_L + PLOT_W} y2={y} className={db === 0 ? styles.gridZero : styles.gridResp} />
            <Txt x={PAD_L + PLOT_W - 4 * h} y={y - 3 * v} h={h} v={v} anchor="end" className={styles.label}>
              {db > 0 ? `+${db}` : db}
            </Txt>
          </g>
        )
      })}
    </g>
  )
})

// Numbered band token: a ring in the band's channel colour with its number
// inside (never colour alone), counter-scaled so it is a true circle.
// inactiveHint: the band is on but does nothing (an upward Spectral band on
// the Core engine): dimmed like a band that is off, and the hint says why.
function BandNode({ band, index, dbZoom, isSelected, isActive, inactiveHint, hPerPx, vPerPx, onDragStart, onContextMenu, onEnter, onLeave }) {
  const cx = freqToX(band.freq)
  const cy = dbToY_response(band.gain, dbZoom)
  const colorVar = `var(${channelColorVar(band.channel)})`
  const opacity = band.enabled && !inactiveHint ? 1 : 0.35
  const routed = band.channel && band.channel !== 'stereo'

  return (
    <g
      className={`${styles.node}${isSelected ? ' selected' : ''}`}
      opacity={opacity}
      data-band={index}
      data-inactive={inactiveHint ? 'core-upward' : undefined}
      data-hint={inactiveHint || undefined}
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onDragStart(index, e) }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu?.(index, e) }}
      onMouseEnter={() => onEnter(index)}
      onMouseLeave={() => onLeave(index)}
    >
      <ellipse cx={cx} cy={cy} rx={13 * hPerPx} ry={13 * vPerPx} fill="transparent" />
      {isSelected && (
        <ellipse
          cx={cx} cy={cy} rx={12 * hPerPx} ry={12 * vPerPx}
          fill="none" stroke={colorVar} strokeWidth={1} vectorEffect="non-scaling-stroke" pointerEvents="none"
        />
      )}
      <ellipse
        cx={cx} cy={cy} rx={9 * hPerPx} ry={9 * vPerPx}
        fill={isSelected || isActive ? colorVar : 'var(--ui-g1)'}
        stroke={colorVar}
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
        pointerEvents="none"
      />
      <Txt x={cx} y={cy + 4 * vPerPx} h={hPerPx} v={vPerPx} className={styles.nodeNumber}>
        {index + 1}
      </Txt>
      {routed && (
        <text
          transform={`translate(${cx} ${cy + 22 * vPerPx}) scale(${hPerPx} ${vPerPx})`}
          className={styles.nodeBadge}
          fill={colorVar}
          textAnchor="middle"
        >
          {CHANNEL_META[band.channel].short}
        </text>
      )}
    </g>
  )
}

// coreSpectral: the Spectral bands run on the Core engine (spectral_engine = 1).
// Their fills then show the Core region (capped depth, nothing for an upward
// band) and an upward band's token is dimmed. Off (the default): every band
// draws exactly as before.
export default function EqCanvas({
  svgRef, bands, selectedBandIndex, dbZoom, rangeDb,
  responsePaths, spectrumPaths, preSpectrumPaths, hoverReadout,
  hoveredIndex, onHoverBand,
  onWheel, onMouseDown, onMouseMove, onMouseLeave, onBandDragStart, onBandContextMenu,
  coreSpectral = false, sampleRate = 48000,
}) {
  // A plain hover earns a small subtext label; the selected band's numbers live
  // in the device's Band section, large.
  const hoverOnlyBand = hoveredIndex != null && hoveredIndex !== selectedBandIndex ? bands[hoveredIndex] : null

  // The SVG's real rendered pixel box, so tokens and text can pre-warp against
  // the viewBox's independent X/Y stretch and stay circular and legible.
  const wrapRef = useRef(null)
  const [renderSize, setRenderSize] = useState({ w: SVG_W, h: SVG_H })
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return undefined
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
      const core = coreSpectral && isActiveSpectral(b)
      if (!core && (!b.enabled || !isFillableBandType(b.type))) return null
      const resp = core ? coreBandFillDb(b, sampleFreqs, sampleRate) : sampleBandResponseDb(b, sampleFreqs)
      if (!resp) return null
      let d = `M ${freqToX(sampleFreqs[0]).toFixed(2)} ${dbToY_response(clamp(resp[0], -dbZoom, dbZoom), dbZoom).toFixed(2)} `
      for (let k = 1; k < RESPONSE_SIZE; k++) {
        d += `L ${freqToX(sampleFreqs[k]).toFixed(2)} ${dbToY_response(clamp(resp[k], -dbZoom, dbZoom), dbZoom).toFixed(2)} `
      }
      for (let k = RESPONSE_SIZE - 1; k >= 0; k--) {
        d += `L ${freqToX(sampleFreqs[k]).toFixed(2)} ${y0.toFixed(2)} `
      }
      return { index: i, d, colorVar: channelColorVar(b.channel) }
    })
  }, [bands, dbZoom, coreSpectral, sampleRate])

  const upward = useMemo(
    () => (coreSpectral ? new Set(coreSpectralStatus(bands).upward) : null),
    [bands, coreSpectral],
  )

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <svg
        ref={svgRef}
        className={styles.svg}
        viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        preserveAspectRatio="none"
        role="application"
        aria-label="EQ curve. Click the curve to add a band, drag a numbered token to move it, scroll over it to change Q, right-click it for its type."
        data-wheel-owner="true"
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
      >
        <rect x={PAD_L} y={PAD_T} width={PLOT_W} height={PLOT_H} className={styles.plotBg} />
        <EqGrid dbZoom={dbZoom} rangeDb={rangeDb} h={hPerPx} v={vPerPx} />

        {preSpectrumPaths?.fill && <path d={preSpectrumPaths.fill} className={styles.specPreFill} />}
        {preSpectrumPaths?.maxHold && <path d={preSpectrumPaths.maxHold} className={styles.specPreHold} />}
        {spectrumPaths?.fill && <path d={spectrumPaths.fill} className={styles.specFill} />}
        {spectrumPaths?.maxHold && <path d={spectrumPaths.maxHold} className={styles.specHold} />}

        {bandFills.map((f) => f && (
          <path
            key={`fill-${f.index}`} d={f.d} fill={`var(${f.colorVar})`}
            opacity={selectedBandIndex === f.index ? 0.16 : 0.05} pointerEvents="none"
          />
        ))}

        {/* One curve per routing group. Routed ones (in their channel tint)
            first so the standard Stereo curve stays on top. The eqc-* class
            names are stable hooks for tests. */}
        {ROUTED_TRACE_ORDER.map((ch) => responsePaths?.[ch] && (
          <path
            key={`resp-${ch}`} d={responsePaths[ch]}
            className={`${styles.responseLine} ${ch === 'mid' || ch === 'side' ? styles.dashed : ''} eqc-response-line eqc-response-line-${ch}`}
            style={{ stroke: `var(${channelColorVar(ch)})` }}
          />
        ))}
        {responsePaths?.stereo && <path d={responsePaths.stereo} className={`${styles.responseLine} eqc-response-line`} />}

        {bands.map((band, i) => (
          <BandNode
            key={i} band={band} index={i} dbZoom={dbZoom}
            isSelected={i === selectedBandIndex}
            isActive={i === hoveredIndex}
            inactiveHint={upward?.has(i) ? CORE_UPWARD_HINT : null}
            hPerPx={hPerPx} vPerPx={vPerPx}
            onDragStart={onBandDragStart}
            onContextMenu={onBandContextMenu}
            onEnter={onHoverBand}
            onLeave={() => onHoverBand(null)}
          />
        ))}
      </svg>

      {hoverOnlyBand && (
        <div
          className={styles.hoverLabel}
          style={{
            left: `${clamp((freqToX(hoverOnlyBand.freq) / SVG_W) * 100, 4, 96)}%`,
            top: `${clamp(((dbToY_response(hoverOnlyBand.gain, dbZoom) - 14) / SVG_H) * 100, 2, 92)}%`,
          }}
        >
          {formatValue(hoverOnlyBand.freq, 'Hz')} · {formatValue(hoverOnlyBand.gain, 'dB', { signed: true })}
        </div>
      )}

      {hoverReadout && <div className={styles.hoverReadout}>{hoverReadout}</div>}
    </div>
  )
}
