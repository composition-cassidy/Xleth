import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconButton, Menu, MenuItem, MenuSeparator, NumberBox, SegmentedControl, Select,
} from '../../ui-kit'
import {
  MAX_FLIP_STATES, MODIFIER_TYPES, MODIFIER_TYPE_LABELS, ORIENTATIONS, ORIENTATION_LABELS, resolveStateIndex,
} from '../../types/videoFlipTypes.js'
import {
  FLIP_STYLES, applyFlipStyle, clampInt, cloneFlipConfig, flipStyleOf, midiNoteLabel, nextStateId,
  parsePitchInput, previewPitches,
} from './videoFlipModel.js'
import RowToggle from './RowToggle.jsx'
import styles from './Inspector.module.css'
import { TRow as Row, TrackSection, trackStyles as t } from './TrackSection.jsx'
import { iconComponent } from '../../ui-kit/icons'

const IcPlus = iconComponent('plus')
const IcX = iconComponent('x')
const IcXFlip180 = iconComponent('xleth-flip-180')
const IcXFlip90ccw = iconComponent('xleth-flip-90ccw')
const IcXFlip90cw = iconComponent('xleth-flip-90cw')
const IcXFlipHorizontal = iconComponent('xleth-flip-horizontal')
const IcXFlipNone = iconComponent('xleth-flip-none')
const IcXFlipStyleCcw = iconComponent('xleth-flip-style-ccw')
const IcXFlipStyleCw = iconComponent('xleth-flip-style-cw')
const IcXFlipStyleHorizontal = iconComponent('xleth-flip-style-horizontal')
const IcXFlipVertical = iconComponent('xleth-flip-vertical')

const ORIENTATION_GLYPH = {
  none: IcXFlipNone,
  horizontal: IcXFlipHorizontal,
  vertical: IcXFlipVertical,
  'rotate-180': IcXFlip180,
  'rotate-90-cw': IcXFlip90cw,
  'rotate-90-ccw': IcXFlip90ccw,
}
const STYLE_GLYPH = { none: IcXFlipNone, horizontal: IcXFlipStyleHorizontal, clockwise: IcXFlipStyleCw, counterclockwise: IcXFlipStyleCcw }

function OrientationGlyph({ orientation, size = 14 }) {
  const G = ORIENTATION_GLYPH[orientation] ?? IcXFlipNone
  return <G size={size} aria-hidden="true" />
}

const MODIFIER_OPTIONS = MODIFIER_TYPES.map((t) => ({ value: t, label: MODIFIER_TYPE_LABELS[t] }))
const SUBDIVISION_OPTIONS = [{ value: 'beat', label: 'Beats' }, { value: 'bar', label: 'Bars' }]

/**
 * The track's video flip cycle (flip v2), as an Inspector section switched on from
 * its header (the body only exists while Flip is on): the flipping style (the
 * engine's four canonical cycles, or Custom), the cycle itself (1 to 12 states,
 * each one of six orientations), the advance rule, the start state, and a
 * preview of the next eight notes. One setVideoFlipConfig per discrete edit,
 * exactly as before; nothing is written while a menu is open.
 *
 * Props: track (with videoFlipConfig), onCommit(config).
 */
export default function VideoFlipSection({ track, onCommit }) {
  const [config, setConfig] = useState(() => cloneFlipConfig(track?.videoFlipConfig))
  useEffect(() => { setConfig(cloneFlipConfig(track?.videoFlipConfig)) }, [track?.videoFlipConfig])

  const commit = useCallback((next) => { setConfig(next); onCommit?.(next) }, [onCommit])
  const [menu, setMenu] = useState(null) // { index, x, y }
  const [pitchDraft, setPitchDraft] = useState('')
  const cellsRef = useRef(null)

  const off = !config.enabled
  const n = config.states.length
  const style = flipStyleOf(config)
  const modType = config.modifier?.type ?? 'every-note'
  const styleName = style === 'custom' ? 'Custom' : FLIP_STYLES.find((s) => s.value === style)?.label

  const setStates = (states, startStateIndex = config.startStateIndex) => commit({
    ...config, states, startStateIndex: clampInt(startStateIndex, 0, states.length - 1),
  })
  const setOrientation = (i, orientation) => setStates(config.states.map((s, k) => (k === i ? { ...s, orientation } : s)))
  const addState = () => {
    if (n >= MAX_FLIP_STATES) return
    setStates([...config.states, { id: nextStateId(config.states), orientation: 'none', label: '' }])
  }
  const removeState = (i) => {
    if (n <= 1) return
    let start = config.startStateIndex
    if (start >= i) start = Math.max(0, start - 1)
    setStates(config.states.filter((_, k) => k !== i), start)
  }
  // Reordering keeps the start mark on the same state.
  const moveState = (i, to) => {
    if (to < 0 || to >= n || to === i) return
    const startId = config.states[config.startStateIndex]?.id
    const states = [...config.states]
    const [s] = states.splice(i, 1)
    states.splice(to, 0, s)
    setStates(states, Math.max(0, states.findIndex((x) => x.id === startId)))
  }

  const setModifierType = (type) => {
    // Reset the config-shaped fields when the type changes, so no stale pitches leak into a beat rule.
    let mc = {}
    if (type === 'specific-pitches') mc = { pitches: config.modifier?.config?.pitches ?? [] }
    if (type === 'every-n-beats') {
      mc = {
        n: clampInt(config.modifier?.config?.n ?? 1, 1, 32),
        subdivision: config.modifier?.config?.subdivision === 'bar' ? 'bar' : 'beat',
      }
    }
    commit({ ...config, modifier: { type, config: mc } })
  }
  const setModConfig = (patch) => commit({
    ...config, modifier: { ...config.modifier, config: { ...config.modifier.config, ...patch } },
  })
  const pitches = config.modifier?.config?.pitches ?? []
  const addPitch = () => {
    const p = parsePitchInput(pitchDraft)
    if (p != null && !pitches.includes(p)) setModConfig({ pitches: [...pitches, p].sort((a, b) => a - b) })
    setPitchDraft('')
  }

  const preview = useMemo(() => {
    const ps = previewPitches(config)
    const states = resolveStateIndex(config, ps.map((pitch, i) => ({ tick: i * 960, pitch })), 960)
    return ps.map((pitch, i) => ({
      pitch, label: midiNoteLabel(pitch), state: states[i], orientation: config.states[states[i]]?.orientation ?? 'none',
    }))
  }, [config])

  const openMenu = (i) => (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    setMenu({ index: i, x: r.left, y: r.bottom + 2 })
  }

  return (
    <TrackSection
      id="flip" title="Video flip" testId="xleth-inspector-flip"
      summary={off ? null : `${styleName} · ${n} state${n === 1 ? '' : 's'}`}
      hint="Flip the picture per note through a cycle of orientations"
      actions={(
        <RowToggle
          label="Flip enabled"
          on={config.enabled}
          onChange={(next) => commit({ ...config, enabled: next })}
          hint="Flip the picture per note through the cycle below. Off renders every note unflipped."
          data-testid="xleth-flip-enabled"
        />
      )}
    >
      {off ? null : (
        <>
          <Row label="Style">
            <SegmentedControl
              size="sm"
              label="Flipping style"
              value={style}
              disabled={off}
              options={FLIP_STYLES.map((st) => {
                const G = STYLE_GLYPH[st.value]
                return { value: st.value, label: <G size={14} aria-hidden="true" />, ariaLabel: st.label, hint: `${st.label}: ${st.hint}` }
              })}
              onChange={(v) => commit(applyFlipStyle(config, v))}
            />
            <span className={t.value}>{styleName}</span>
          </Row>

          <Row label="Cycle">
            <div className={styles.flipCells} ref={cellsRef} role="list" aria-label="Flip states">
              {config.states.map((st, i) => (
                <button
                  key={st.id}
                  type="button"
                  role="listitem"
                  className={styles.flipCell}
                  data-start={i === config.startStateIndex || undefined}
                  disabled={off}
                  aria-label={`State ${i + 1}: ${ORIENTATION_LABELS[st.orientation]}${i === config.startStateIndex ? ', start' : ''}`}
                  data-hint={`State ${i + 1}: ${ORIENTATION_LABELS[st.orientation]}. Click to change, move or remove it.`}
                  onClick={openMenu(i)}
                >
                  <OrientationGlyph orientation={st.orientation} />
                  <span className={styles.flipCellIndex}>{i + 1}</span>
                </button>
              ))}
              <IconButton
                size="sm"
                label="Add a state"
                hint={n >= MAX_FLIP_STATES ? `At most ${MAX_FLIP_STATES} states` : 'Add a state to the end of the cycle'}
                disabled={off || n >= MAX_FLIP_STATES}
                onClick={addState}
              >
                <IcPlus aria-hidden="true" />
              </IconButton>
            </div>
          </Row>

          <Row label="Modifier">
            <Select size="sm" ariaLabel="Flip modifier" value={modType} options={MODIFIER_OPTIONS} disabled={off} onChange={setModifierType} />
          </Row>
          {modType === 'every-n-beats' && (
            <Row label="Every">
              <NumberBox
                label="Beats per advance" hideLabel width={64}
                value={clampInt(config.modifier.config?.n ?? 1, 1, 32)} min={1} max={32} step={1} defaultValue={1}
                format={(v) => String(Math.round(v))} parse={(t) => { const v = parseInt(t, 10); return Number.isFinite(v) ? v : null }}
                quantize={(v) => Math.round(v)} disabled={off}
                onCommit={(v) => setModConfig({ n: clampInt(v, 1, 32) })}
              />
              <Select
                size="sm" ariaLabel="Beats or bars" disabled={off}
                value={config.modifier.config?.subdivision === 'bar' ? 'bar' : 'beat'}
                options={SUBDIVISION_OPTIONS}
                onChange={(v) => setModConfig({ subdivision: v })}
              />
            </Row>
          )}
          {modType === 'specific-pitches' && (
            <Row label="Pitches">
              {pitches.length === 0 ? <span className={t.value}>None yet: the cycle will not advance</span> : null}
              {pitches.map((p) => (
                <span key={p} className={styles.pitchChip}>
                  {midiNoteLabel(p)}
                  <IconButton size="sm" label={`Remove ${midiNoteLabel(p)}`} disabled={off} onClick={() => setModConfig({ pitches: pitches.filter((x) => x !== p) })}>
                    <IcX aria-hidden="true" />
                  </IconButton>
                </span>
              ))}
              <input
                className={styles.textField}
                type="text"
                value={pitchDraft}
                disabled={off}
                placeholder="C4, D#5, 60"
                aria-label="Add a pitch"
                onChange={(e) => setPitchDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPitch() } }}
              />
              <IconButton size="sm" label="Add pitch" disabled={off} onClick={addPitch}>
                <IcPlus aria-hidden="true" />
              </IconButton>
            </Row>
          )}

          <Row label="Start state">
            <NumberBox
              label="Start state" hideLabel width={84}
              value={config.startStateIndex + 1} min={1} max={Math.max(1, n)} step={1} defaultValue={1}
              format={(v) => `${Math.round(v)} of ${n}`} parse={(t) => { const v = parseInt(t, 10); return Number.isFinite(v) ? v : null }}
              quantize={(v) => Math.round(v)} disabled={off || n <= 1}
              onCommit={(v) => {
                const idx = clampInt(v - 1, 0, n - 1)
                if (idx !== config.startStateIndex) commit({ ...config, startStateIndex: idx })
              }}
              hint="The state the first note uses"
            />
          </Row>

          <div className={`${styles.flipPreview} ${t.preview}`}>
            <span className={styles.previewCaption}>Next 8 notes, on example pitches</span>
            <ol className={styles.previewCells} aria-label="Preview of the next eight notes">
              {preview.map((it, i) => (
                <li
                  key={i}
                  className={styles.previewCell}
                  aria-label={`Note ${i + 1}, ${it.label}: state ${it.state + 1}, ${ORIENTATION_LABELS[it.orientation]}`}
                >
                  <span className={styles.previewNote}>{it.label}</span>
                  <OrientationGlyph orientation={it.orientation} size={14} />
                  <span className={styles.previewState}>{it.state + 1}</span>
                </li>
              ))}
            </ol>
          </div>

          {menu ? (
            <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)} label={`State ${menu.index + 1}`}>
              {ORIENTATIONS.map((o) => (
                <MenuItem
                  key={o}
                  checked={config.states[menu.index]?.orientation === o}
                  icon={<OrientationGlyph orientation={o} />}
                  onSelect={() => setOrientation(menu.index, o)}
                >
                  {ORIENTATION_LABELS[o]}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem disabled={menu.index === config.startStateIndex} onSelect={() => commit({ ...config, startStateIndex: menu.index })}>
                Start here
              </MenuItem>
              <MenuItem disabled={menu.index === 0} onSelect={() => moveState(menu.index, menu.index - 1)}>Move earlier</MenuItem>
              <MenuItem disabled={menu.index === n - 1} onSelect={() => moveState(menu.index, menu.index + 1)}>Move later</MenuItem>
              <MenuItem danger disabled={n <= 1} onSelect={() => removeState(menu.index)}>Remove</MenuItem>
            </Menu>
          ) : null}
        </>
      )}
    </TrackSection>
  )
}
