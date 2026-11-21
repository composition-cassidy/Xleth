import { Button, NumberBox, Select, Toggle } from '../../ui-kit'
import { iconComponent } from '../../ui-kit/icons'
import useRoamKeysStore, { DEFAULT_ROAM_CHANNEL } from '../../stores/useRoamKeysStore.js'
import { ticksFmt } from '../../lensRoam/lensFormats.js'
import { playheadTick } from '../../lensRoam/useLensRoam.js'
import {
  KEY_LIMITS, ROAM_CHANNEL_LABELS, ROAM_CHANNEL_OPTIONS, applyKeyOp, formatBarBeat,
  keyAtPlayhead, keysForRefs, keysOfChannel, moveKey, sameKeyRef, setInterpForRefs, upsertKey,
} from '../../lensRoam/roamKeyModel.js'
import { SCALE_SCALE, degFmt, cellFmt, scaleFmt } from './roamFormats.js'
import { Field, Fields, TRow, trackStyles as t } from '../inspector/TrackSection.jsx'
import BezierShapeSelect, { BEZIER_INTERP_OPTION } from './BezierShapeSelect.jsx'
import { requestMotionReveal } from '../timeline/motionReveal.js'

const IcRecord = iconComponent('record')

// Roam keys in the Inspector: the parameter the buttons work on, "Show in Motion view"
// (where every key is drawn and edited: the Edit view has no key lane any more,
// docs/XLETH_MOTION_VIEW_DESIGN.md R17), a "key at the playhead" button, and the selected
// key's numbers in a well. Auto-key sits in the section header (RoamAutoKeyToggle). Every
// edit is ONE commit of the whole key list (one undo step); nothing here previews through
// the engine.

const INTERP_OPTIONS = [
  { value: 'Hold', label: 'Hold', hint: "Keep this key's value until the next key, then step." },
  { value: 'Linear', label: 'Linear', hint: 'A straight line to the next key.' },
  { value: 'EaseOut', label: 'Ease out', hint: 'Fast off this key, settling into the next one.' },
  BEZIER_INTERP_OPTION,
]

const ROTATION_BOX = [-3600, 3600]

/** Format + NumberBox settings for a key's VALUE, per channel. */
function valueProps(channel) {
  if (channel === 'scale') {
    return { scale: SCALE_SCALE, format: scaleFmt.format, parse: scaleFmt.parse, defaultValue: 1 }
  }
  if (channel === 'rotationDeg') {
    // A key's rotation is unbounded (KEY_LIMITS); the box needs a finite scale to
    // drag on, so it spans ten turns each way at the old 2 px per degree.
    const [lo, hi] = ROTATION_BOX
    return { min: lo, max: hi, bipolar: true, centre: 0, format: degFmt.format, parse: degFmt.parse, defaultValue: 0, pxPerRange: 2 * (hi - lo) }
  }
  const [lo, hi] = KEY_LIMITS[channel]
  return { min: lo, max: hi, bipolar: true, centre: 0, format: cellFmt.format, parse: cellFmt.parse, defaultValue: 0, pxPerRange: 800 }
}

/**
 * @param {object} props
 * @param {number} props.trackId
 * @param {object} props.roam        useRoamValue(trackId)
 * @param {boolean} props.placed     the track has a cell (a grid slot or a fullscreen layer)
 * @param {string[]} [props.channels] the Roam channels offered (a Trail clone's added
 *                                    Roam: Offset X and Y only); default every channel
 */
export default function RoamKeys({ trackId, roam, placed, channels = null }) {
  const { base, committedKeys: keys, commitKeys, autoKey, keyed } = roam
  const options = channels ? ROAM_CHANNEL_OPTIONS.filter((o) => channels.includes(o.value)) : ROAM_CHANNEL_OPTIONS
  const stored = useRoamKeysStore((s) => s.channelByTrack[trackId]) ?? DEFAULT_ROAM_CHANNEL
  const channel = options.some((o) => o.value === stored) ? stored : (options[0]?.value ?? DEFAULT_ROAM_CHANNEL)
  const setChannel = useRoamKeysStore((s) => s.setChannel)
  const selected = useRoamKeysStore((s) => s.selected)
  const select = useRoamKeysStore((s) => s.select)
  const multi = useRoamKeysStore((s) => s.multi)

  const keyObj = selected && selected.trackId === trackId
    ? keys.find((k) => k.channel === selected.channel && Math.abs(k.pos - selected.pos) < 0.5) ?? null
    : null
  // The multi-selection's keys on this track, when the inspected key is one of them:
  // an interp or shape edit then applies to all of them (one commit).
  const groupRefs = keyObj && multi.length > 1
    && multi.some((r) => sameKeyRef(r, { trackId, channel: keyObj.channel, pos: keyObj.pos }))
    ? multi : null
  const groupCount = groupRefs ? keysForRefs(keys, groupRefs, trackId).length : 0

  const write = (next, sel = undefined) => {
    commitKeys(next)
    if (sel !== undefined) select(sel)
  }
  const updateKey = (patch) => {
    if (!keyObj) return
    if (patch.pos !== undefined) {
      const next = moveKey(keys, keyObj, { pos: patch.pos, value: patch.value ?? keyObj.value })
      const i = keys.findIndex((k) => k === keyObj)
      const moved = next[i]
      write(next, moved ? { trackId, channel: keyObj.channel, pos: moved.pos } : null)
      return
    }
    const next = patch.value !== undefined
      ? upsertKey(keys, { channel: keyObj.channel, pos: keyObj.pos, value: patch.value })
      : applyKeyOp(keys, { type: 'update', match: keyObj, patch })
    if (next) write(next)
  }
  const setInterp = (interp, bez = null) => {
    if (!keyObj) return
    if (groupRefs) {
      const next = setInterpForRefs(keys, groupRefs, trackId, interp, bez)
      if (next !== keys) write(next)
      return
    }
    updateKey(interp === 'Bezier' && bez ? { interp, bez } : { interp })
  }
  const keyHere = () => {
    const tick = Math.round(playheadTick())
    write(keyAtPlayhead(keys, base ?? {}, channel, tick), { trackId, channel, pos: tick })
  }

  const laneKeyCount = keysOfChannel(keys, channel).length

  return (
    <div className={t.keys} data-testid="roam-keys">
      {keyed.size > 0 && !autoKey && (
        <p className={t.note} data-testid="roam-keyed-note">
          {[...keyed].map((c) => ROAM_CHANNEL_LABELS[c]).join(', ')} {keyed.size === 1 ? 'is' : 'are'} keyed. Edit
          the keys in Motion view, or turn on Auto-key to write a key at the playhead.
        </p>
      )}
      <TRow label="Parameter">
        <Select
          size="sm" ariaLabel="Roam parameter to key" value={channel} options={options}
          onChange={(c) => setChannel(trackId, c)}
          hint="Which Roam parameter the buttons below work on. Each has its own keys."
        />
      </TRow>
      <TRow label="Keys">
        <Button
          size="sm" onClick={() => requestMotionReveal(trackId, ['roam'])} data-testid="roam-show-in-motion"
          hint={placed
            ? "Show this track's Roam rows in Motion view (`), where every key is drawn and edited."
            : "Show this track's Roam rows in Motion view (`). The track has no cell on the grid yet, so its Roam moves nothing until it is placed."}
        >
          Show in Motion view
        </Button>
      </TRow>
      <div className={t.actions}>
        <Button
          size="sm" onClick={keyHere}
          hint={`Write a ${ROAM_CHANNEL_LABELS[channel]} key at the playhead, holding what the cell is doing now.`}
        >
          Key at playhead
        </Button>
        <Button
          size="sm" onClick={() => { select(null); write([]) }} disabled={keys.length === 0}
          hint="Delete every key on this track. The cell returns to its base values."
        >
          Clear keys
        </Button>
        <span className={t.readout} data-testid="roam-key-count">
          {laneKeyCount === 0 ? `No ${ROAM_CHANNEL_LABELS[channel]} keys` : `${laneKeyCount} ${ROAM_CHANNEL_LABELS[channel]} key${laneKeyCount === 1 ? '' : 's'}`}
        </span>
      </div>
      {keyObj ? (
        <div className={t.well} data-testid="roam-key-inspector" aria-label={`${ROAM_CHANNEL_LABELS[keyObj.channel]} key`}>
          <div className={t.wellHead}>
            <span>
              {`${ROAM_CHANNEL_LABELS[keyObj.channel]} key `}
              <span className={t.readout} data-testid="roam-key-bar" data-hint="Where the key sits, as bar.beat.ticks">
                at {formatBarBeat(keyObj.pos)}
              </span>
            </span>
            <Button
              size="sm" onClick={() => { const next = applyKeyOp(keys, { type: 'remove', match: keyObj }); if (next) write(next, null) }}
              hint="Delete this key. Right-clicking a key in Motion view offers the same, for every selected key."
            >
              Delete key
            </Button>
          </div>
          <Fields>
            <Field label="Value" stretch>
              <NumberBox
                label="Key value" hideLabel width={96} value={keyObj.value}
                {...valueProps(keyObj.channel)}
                onCommit={(value) => updateKey({ value })}
                hint="The value this key holds. A keyed parameter follows its keys; the static value is ignored."
              />
            </Field>
            <Field label="Position" stretch>
              <NumberBox
                label="Key position" hideLabel width={96} value={keyObj.pos}
                min={0} max={Math.max(3840 * 64, keyObj.pos)} step={1} defaultValue={0} pxPerRange={4000}
                format={ticksFmt.format} parse={ticksFmt.parse}
                onCommit={(pos) => updateKey({ pos })}
                hint="Timeline ticks. 960 is a quarter note, 3840 a bar."
              />
            </Field>
            <Field label="Interp" stretch>
              <Select
                size="sm" ariaLabel="Key interpolation" value={keyObj.interp ?? 'Linear'} options={INTERP_OPTIONS}
                onChange={(interp) => setInterp(interp)}
                hint={groupRefs
                  ? `The shape of the segment leaving each of the ${groupCount} selected keys.`
                  : 'The shape of the segment leaving this key.'}
              />
            </Field>
            {keyObj.interp === 'Bezier' && (
              <Field label="Shape" stretch>
                <BezierShapeSelect bez={keyObj.bez} onChange={(bez) => setInterp('Bezier', bez)} />
              </Field>
            )}
          </Fields>
          {groupRefs && (
            <p className={t.note} data-testid="roam-key-group">
              {groupCount} keys selected on this track. Interp and shape apply to all of them; Motion view's right-click menu does the same.
            </p>
          )}
        </div>
      ) : (
        <p className={t.note} data-testid="roam-key-empty">
          Select a key on the motion path in the viewer to edit its value, position and interp here. Motion view shows every key.
        </p>
      )}
    </div>
  )
}

/**
 * Auto-key, for the Roam keys section header, so it stays reachable while the section
 * is folded.
 */
export function RoamAutoKeyToggle({ autoKey }) {
  const setAutoKey = useRoamKeysStore((s) => s.setAutoKey)
  return (
    <>
      <span className={t.actionLabel} aria-hidden="true">Auto-key</span>
      <Toggle
        size="sm" on={autoKey} onChange={setAutoKey} aria-label="Auto-key" glyph={<IcRecord size={12} aria-hidden="true" />}
        hint="Moving, scaling or turning the cell in the viewer writes a key at the playhead."
        hintMods="The first key on a parameter also keys where it was a bar earlier, so the cell glides in."
      >
        {autoKey ? 'On' : 'Off'}
      </Toggle>
    </>
  )
}
