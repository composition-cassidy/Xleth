// The Landings section of the cue editor (docs/XLETH_LANDING_SPEC.md §8).
//
// A Landing is one track's move into its slot in the cue's snapshot, ending on
// the pin. This section lists the cue's landings and offers Add landing (tracks
// with a slot in the cue's snapshot that have none) and Reflow (a "Where it
// was" landing for every track that changes place).
//
// Master and detail: the list is one 24px row per landing (track, a one-line
// summary, remove) and scrolls past eight; the open landing's controls sit in a
// pane under it at the editor's full width, so a long list never squeezes a
// value field.
//
// It only AUTHORS: every control previews locally and hands ONE complete list
// to onSetCueLandings when the gesture ends (kit NumberBoxes commit on release,
// the compass and the curve on pointer-up). The engine renders the move. No
// motion here: this is the edit loop.
import { useCallback, useMemo, useRef, useState } from 'react'
import { Button, IconButton, Menu, MenuItem, NumberBox, Select, formatValue, THIN_SPACE } from '../../ui-kit'
import { iconComponent } from '../../ui-kit/icons'
import { GRANULARITY_BEATS, beatsToTicks, ticksToBeats } from '../../constants/timeline.js'
import LineSweepDirectionControl from './LineSweepDirectionControl.jsx'
import SnapshotTransitionBezierEditor from './SnapshotTransitionBezierEditor.jsx'
import {
  LANDING_DEFAULT_LEAD_IN_TICKS, LANDING_EASING_PRESETS, LANDING_FROM_OPTIONS, LANDING_MAX_LEAD_IN_TICKS,
  LANDING_MAX_PER_CUE, buildCueLandings, landingCandidates, landingEasingPreset, outgoingSnapshotId,
  snapLeadInBeats, trackIsPlaced,
} from './cueLandings.js'
import styles from './CueLandings.module.css'

const IcCaretDown = iconComponent('caret-down')
const IcCaretRight = iconComponent('caret-right')
const IcPlus = iconComponent('plus')
const IcX = iconComponent('x')

const MAX_LEAD_IN_BEATS = ticksToBeats(LANDING_MAX_LEAD_IN_TICKS)

// "1 beat", "0.5 beats": number, thin space, unit (DESIGN.md 6).
export function formatLeadInBeats(beats) {
  const rounded = Math.round(beats * 1000) / 1000
  return `${rounded}${THIN_SPACE}${rounded === 1 ? 'beat' : 'beats'}`
}
const parseNumber = (text) => {
  const n = parseFloat(String(text).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}
const PERCENT = {
  format: (v) => formatValue(v * 100, '%'),
  parse: (text) => { const n = parseNumber(text); return n === null ? null : n / 100 },
}
const quantizePercent = (v) => Math.min(1, Math.max(0, Math.round(v * 100) / 100))

const EASING_OPTIONS = [
  { value: 'custom', label: 'Custom', disabled: true },
  ...Object.entries(LANDING_EASING_PRESETS).map(([value, preset]) => ({ value, label: preset.label })),
]
const fromLabel = (from) => LANDING_FROM_OPTIONS.find((option) => option.value === from)?.label ?? 'Edge'

// One landing in the list.
function LandingRow({ landing, name, open, detailId, onToggle, onRemove }) {
  const Caret = open ? IcCaretDown : IcCaretRight
  return (
    <li className={`vmt-landing-row ${styles.row}${open ? ' is-open' : ''}`} data-track-id={landing.trackId}>
      <button
        type="button"
        className={`vmt-landing-toggle ${styles.rowToggle}`}
        aria-expanded={open}
        aria-controls={open ? detailId : undefined}
        onClick={onToggle}
        data-hint={`Landing: ${name}`}
        data-hint-mods="Click: show or hide its settings"
      >
        <Caret size={12} aria-hidden="true" />
        <span className={styles.name}>{name}</span>
        <span className={styles.summary}>
          {fromLabel(landing.from)} · {formatLeadInBeats(ticksToBeats(landing.leadInTicks))}
        </span>
      </button>
      <IconButton
        size="sm"
        className="vmt-landing-remove"
        onClick={onRemove}
        label={`Remove the landing for ${name}`}
        hint="Remove this landing: the track cuts to its slot on the pin"
      >
        <IcX size={14} aria-hidden="true" />
      </IconButton>
    </li>
  )
}

// The open landing's controls.
function LandingDetail({ landing, name, id, placedInOutgoing, snapGranularity, onPatch }) {
  const stepBeats = GRANULARITY_BEATS[snapGranularity] ?? GRANULARITY_BEATS['1/16']
  const quantizeLeadIn = useCallback((beats) => snapLeadInBeats(beats, snapGranularity), [snapGranularity])
  const fromOptions = useMemo(() => LANDING_FROM_OPTIONS.map((option) => (
    option.value === 'whereItWas' && !placedInOutgoing
      ? { ...option, disabled: true, hint: 'Where it was: this track is not in the outgoing snapshot' }
      : option
  )), [placedInOutgoing])
  const customBox = (key, label, caption) => (
    <NumberBox
      className={`vmt-landing-custom-${key}`}
      label={`${label} for ${name}`}
      caption={caption}
      value={landing.custom[key]}
      min={0}
      max={1}
      step={0.01}
      quantize={quantizePercent}
      format={PERCENT.format}
      parse={PERCENT.parse}
      width={103}
      hint={`${label} of the start rectangle, as a share of the frame`}
      onCommit={(value) => onPatch({ custom: { [key]: value } })}
    />
  )

  return (
    <div
      id={id}
      className={`vmt-landing-body ${styles.detail}`}
      role="group"
      aria-label={`Landing for ${name}`}
      data-track-id={landing.trackId}
    >
      <label className={styles.field}>
        <span>From</span>
        <Select
          size="sm"
          className="vmt-landing-from"
          value={landing.from}
          options={fromOptions}
          onChange={(from) => onPatch({ from })}
          ariaLabel={`Where ${name} starts from`}
          hint="From: where the move starts"
        />
      </label>
      {landing.from === 'edge' && (
        <LineSweepDirectionControl
          value={landing.edgeAngleDeg}
          ariaLabel={`Side ${name} enters from`}
          onCommit={(edgeAngleDeg) => onPatch({ edgeAngleDeg })}
        />
      )}
      {landing.from === 'custom' && (
        <div className={`vmt-landing-custom ${styles.customGrid}`} role="group" aria-label={`Start rectangle for ${name}`}>
          {customBox('x', 'Left', 'X')}
          {customBox('y', 'Top', 'Y')}
          {customBox('w', 'Width', 'W')}
          {customBox('h', 'Height', 'H')}
        </div>
      )}
      <NumberBox
        className="vmt-landing-lead-in"
        label="Lead-in"
        value={ticksToBeats(landing.leadInTicks)}
        min={0}
        max={MAX_LEAD_IN_BEATS}
        step={stepBeats}
        quantize={quantizeLeadIn}
        format={formatLeadInBeats}
        parse={parseNumber}
        width={208}
        hint="Lead-in: how long before the pin the move starts, in beats"
        hintMods="Snaps to the grid"
        onCommit={(beats) => onPatch({ leadInTicks: beatsToTicks(beats) })}
      />
      <NumberBox
        className="vmt-landing-from-opacity"
        label="From opacity"
        value={landing.fromOpacity}
        min={0}
        max={1}
        step={0.01}
        quantize={quantizePercent}
        format={PERCENT.format}
        parse={PERCENT.parse}
        width={208}
        hint="From opacity: how visible the track is when the move starts; it reaches 100 % on the pin"
        onCommit={(fromOpacity) => onPatch({ fromOpacity })}
      />
      <label className={styles.field}>
        <span>Easing</span>
        <Select
          size="sm"
          className="vmt-landing-easing"
          value={landingEasingPreset(landing.easing)}
          options={EASING_OPTIONS}
          onChange={(key) => {
            const preset = LANDING_EASING_PRESETS[key]
            if (preset) onPatch({ easing: { ...preset.curve } })
          }}
          ariaLabel={`Easing of the landing for ${name}`}
          hint="Easing: Land settles early, Glide eases both ends, Linear moves evenly"
        />
      </label>
      <SnapshotTransitionBezierEditor
        single
        easing={landing.easing}
        resetCurve={LANDING_EASING_PRESETS.land.curve}
        resetLabel="Reset to Land"
        summaryLabel="Curve"
        summaryHint="Easing curve: the shape of the move from its start to the pin"
        graphLabel={`Easing curve of the landing for ${name}`}
        onChange={(easing) => onPatch({ easing })}
      />
    </div>
  )
}

export default function CueLandingsSection({
  cue, cues = [], snapshots = [], defaultSnapshotId = '', tracks = [], snapGranularity = '1/16',
  onSetCueLandings, onReflowCueLandings,
}) {
  const [openTrackId, setOpenTrackId] = useState(null)
  const [menu, setMenu] = useState(null)
  const addRef = useRef(null)

  const landings = useMemo(() => buildCueLandings(cue.landings), [cue.landings])
  const trackName = useMemo(() => {
    const byId = new Map(tracks.map((track) => [track.id, track.name]))
    return (trackId) => byId.get(trackId) || `Track ${trackId}`
  }, [tracks])
  const outgoing = useMemo(() => {
    const id = outgoingSnapshotId(cues, cue.tick, defaultSnapshotId, snapshots)
    return snapshots.find((snapshot) => snapshot.id === id) || null
  }, [cues, cue.tick, defaultSnapshotId, snapshots])
  const candidates = useMemo(
    () => landingCandidates({ ...cue, landings }, snapshots, tracks),
    [cue, landings, snapshots, tracks],
  )
  const full = landings.length >= LANDING_MAX_PER_CUE
  const canWrite = typeof onSetCueLandings === 'function'
  const openLanding = landings.find((entry) => entry.trackId === openTrackId) || null
  const detailId = `vmt-landing-detail-${cue.tick}`

  const write = useCallback((patch) => {
    if (!canWrite) return
    onSetCueLandings(cue.tick, buildCueLandings(landings, patch))
  }, [canWrite, cue.tick, landings, onSetCueLandings])

  const openMenu = useCallback(() => {
    const rect = addRef.current?.getBoundingClientRect()
    setMenu({ x: rect ? rect.left : 0, y: rect ? rect.bottom + 2 : 0 })
  }, [])

  const addHint = full
    ? `A cue holds at most ${LANDING_MAX_PER_CUE} landings`
    : candidates.length === 0
      ? 'Every track with a slot in this snapshot already has a landing'
      : 'Add a landing for a track in this snapshot'

  return (
    <div className={`vmt-landings ${styles.section}`} role="group" aria-label="Landings">
      <div className={styles.head}>
        <span className={styles.title}>Landings</span>
        <span className={styles.count} aria-label={`${landings.length} of ${LANDING_MAX_PER_CUE} landings`}>
          {landings.length}{THIN_SPACE}/{THIN_SPACE}{LANDING_MAX_PER_CUE}
        </span>
        <Button
          size="sm"
          className="vmt-landings-reflow"
          disabled={typeof onReflowCueLandings !== 'function'}
          onClick={() => onReflowCueLandings?.(cue.tick, LANDING_DEFAULT_LEAD_IN_TICKS)}
          hint="Reflow: add a one-beat landing for every track that changes place at this cue"
        >
          Reflow
        </Button>
        <IconButton
          ref={addRef}
          size="sm"
          className="vmt-landings-add"
          disabled={!canWrite || full || candidates.length === 0}
          onClick={openMenu}
          label="Add landing"
          aria-haspopup="menu"
          aria-expanded={menu ? true : undefined}
          hint={addHint}
        >
          <IcPlus size={14} aria-hidden="true" />
        </IconButton>
      </div>

      {landings.length === 0 ? (
        <p className={`vmt-landings-empty ${styles.empty}`}>No landings. Every track cuts to its slot on the pin.</p>
      ) : (
        <ul className={styles.list}>
          {landings.map((landing) => (
            <LandingRow
              key={landing.trackId}
              landing={landing}
              name={trackName(landing.trackId)}
              open={openTrackId === landing.trackId}
              detailId={detailId}
              onToggle={() => setOpenTrackId((current) => (
                current === landing.trackId ? null : landing.trackId
              ))}
              onRemove={() => write({ trackId: landing.trackId, remove: true })}
            />
          ))}
        </ul>
      )}

      {openLanding && (
        <LandingDetail
          key={openLanding.trackId}
          id={detailId}
          landing={openLanding}
          name={trackName(openLanding.trackId)}
          placedInOutgoing={trackIsPlaced(outgoing, openLanding.trackId)}
          snapGranularity={snapGranularity}
          onPatch={(patch) => write({ trackId: openLanding.trackId, ...patch })}
        />
      )}

      {menu && (
        <Menu x={menu.x} y={menu.y} label="Add landing" onClose={() => setMenu(null)}>
          {candidates.map((candidate) => (
            <MenuItem
              key={candidate.trackId}
              onSelect={() => {
                // A track the outgoing snapshot already shows moves from where it
                // was; one that is new to the picture comes in from the edge.
                const from = trackIsPlaced(outgoing, candidate.trackId) ? 'whereItWas' : 'edge'
                write({ trackId: candidate.trackId, from })
                setOpenTrackId(candidate.trackId)
              }}
            >
              {candidate.name}
            </MenuItem>
          ))}
        </Menu>
      )}
    </div>
  )
}
