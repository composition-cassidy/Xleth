import { Button, NumberBox, Select, Toggle } from '../../ui-kit'
import { iconComponent } from '../../ui-kit/icons'
import useRoamKeysStore, { DEFAULT_ROAM_CHANNEL } from '../../stores/useRoamKeysStore.js'
import { ticksFmt } from '../../lensRoam/lensFormats.js'
import { playheadTick } from '../../lensRoam/useLensRoam.js'
import {
  KEY_LIMITS, ROAM_CHANNEL_LABELS, ROAM_CHANNEL_OPTIONS, applyKeyOp, formatBarBeat,
  keyAtPlayhead, keysOfChannel, moveKey, upsertKey,
} from '../../lensRoam/roamKeyModel.js'
import { SCALE_SCALE, degFmt, cellFmt, scaleFmt } from './roamFormats.js'
import styles from '../inspector/Inspector.module.css'
import lens from './lensRoam.module.css'

const IcRecord = iconComponent('record')

// Roam keys in the Inspector: Auto-key, the key lane's switch and parameter, a "key at
// the playhead" button (the typed alternative to clicking the lane), and the selected
// key's numbers. Every edit is ONE commit of the whole key list (one undo step), the
// same as the lane's drag; nothing here previews through the engine.

const INTERP_OPTIONS = [
  { value: 'Hold', label: 'Hold', hint: "Keep this key's value until the next key, then step." },
  { value: 'Linear', label: 'Linear', hint: 'A straight line to the next key.' },
  { value: 'EaseOut', label: 'Ease out', hint: 'Fast off this key, settling into the next one.' },
]

function Row({ label, children }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <div className={styles.rowControl}>{children}</div>
    </div>
  )
}

/** Format + NumberBox settings for a key's VALUE, per channel. */
function valueProps(channel) {
  if (channel === 'scale') {
    return { scale: SCALE_SCALE, format: scaleFmt.format, parse: scaleFmt.parse, defaultValue: 1 }
  }
  if (channel === 'rotationDeg') {
    const [lo, hi] = KEY_LIMITS.rotationDeg
    return { min: lo, max: hi, bipolar: true, centre: 0, format: degFmt.format, parse: degFmt.parse, defaultValue: 0, pxPerRange: 2880 }
  }
  const [lo, hi] = KEY_LIMITS[channel]
  return { min: lo, max: hi, bipolar: true, centre: 0, format: cellFmt.format, parse: cellFmt.parse, defaultValue: 0, pxPerRange: 800 }
}

/**
 * @param {object} props
 * @param {number} props.trackId
 * @param {object} props.roam        useRoamValue(trackId)
 * @param {boolean} props.placed     the track has a cell (a grid slot or a fullscreen layer)
 */
export default function RoamKeys({ trackId, roam, placed }) {
  const { base, committedKeys: keys, commitKeys, autoKey, keyed } = roam
  const channel = useRoamKeysStore((s) => s.channelByTrack[trackId]) ?? DEFAULT_ROAM_CHANNEL
  const setChannel = useRoamKeysStore((s) => s.setChannel)
  const setAutoKey = useRoamKeysStore((s) => s.setAutoKey)
  const laneOn = useRoamKeysStore((s) => s.laneOpen.has(trackId))
  const toggleLane = useRoamKeysStore((s) => s.toggleLane)
  const selected = useRoamKeysStore((s) => s.selected)
  const select = useRoamKeysStore((s) => s.select)

  const keyObj = selected && selected.trackId === trackId
    ? keys.find((k) => k.channel === selected.channel && Math.abs(k.pos - selected.pos) < 0.5) ?? null
    : null

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
  const keyHere = () => {
    const tick = Math.round(playheadTick())
    write(keyAtPlayhead(keys, base ?? {}, channel, tick), { trackId, channel, pos: tick })
  }

  const laneKeyCount = keysOfChannel(keys, channel).length

  return (
    <div data-testid="roam-keys">
      <Row label="Auto-key">
        <Toggle
          size="sm" on={autoKey} onChange={setAutoKey} glyph={<IcRecord size={12} aria-hidden="true" />}
          hint="Moving, scaling or turning the cell in the viewer writes a key at the playhead."
          hintMods="The first key on a parameter also keys where it was a bar earlier, so the cell glides in."
        >
          {autoKey ? 'On' : 'Off'}
        </Toggle>
      </Row>
      {keyed.size > 0 && !autoKey && (
        <p className={lens.note} data-testid="roam-keyed-note">
          {[...keyed].map((c) => ROAM_CHANNEL_LABELS[c]).join(', ')} {keyed.size === 1 ? 'is' : 'are'} keyed. Edit
          the keys in the lane, or turn on Auto-key to write a key at the playhead.
        </p>
      )}
      <Row label="Key lane">
        <Toggle
          size="sm" on={laneOn} onChange={() => toggleLane(trackId)} disabled={!placed}
          hint={placed ? 'Show the key lane under this track in the arrangement.' : 'This track has no cell on the grid, so it has nothing to move.'}
        >
          {laneOn ? 'Shown' : 'Hidden'}
        </Toggle>
      </Row>
      <Row label="Parameter">
        <Select
          size="sm" ariaLabel="Roam parameter to key" value={channel} options={ROAM_CHANNEL_OPTIONS}
          onChange={(c) => setChannel(trackId, c)}
          hint="Which Roam parameter the lane and the buttons below work on. Each has its own keys."
        />
      </Row>
      <div className={lens.actions}>
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
      </div>
      <p className={lens.note} data-testid="roam-key-count">
        {laneKeyCount === 0 ? `No ${ROAM_CHANNEL_LABELS[channel]} keys.` : `${laneKeyCount} ${ROAM_CHANNEL_LABELS[channel]} key${laneKeyCount === 1 ? '' : 's'}.`}
      </p>
      {keyObj ? (
        <div data-testid="roam-key-inspector" aria-label={`${ROAM_CHANNEL_LABELS[keyObj.channel]} key`}>
          <Row label={`${ROAM_CHANNEL_LABELS[keyObj.channel]} key`}>
            <NumberBox
              label="Key value" hideLabel width={96} value={keyObj.value}
              {...valueProps(keyObj.channel)}
              onCommit={(value) => updateKey({ value })}
              hint="The value this key holds. A keyed parameter follows its keys; the static value is ignored."
            />
          </Row>
          <Row label="Position">
            <NumberBox
              label="Key position" hideLabel width={96} value={keyObj.pos}
              min={0} max={Math.max(3840 * 64, keyObj.pos)} step={1} defaultValue={0} pxPerRange={4000}
              format={ticksFmt.format} parse={ticksFmt.parse}
              onCommit={(pos) => updateKey({ pos })}
              hint="Timeline ticks. 960 is a quarter note, 3840 a bar."
            />
            <span className={lens.readout} data-testid="roam-key-bar">bar.beat.ticks {formatBarBeat(keyObj.pos)}</span>
          </Row>
          <Row label="Interp">
            <Select
              size="sm" ariaLabel="Key interpolation" value={keyObj.interp ?? 'Linear'} options={INTERP_OPTIONS}
              onChange={(interp) => updateKey({ interp })}
              hint="The shape of the segment leaving this key."
            />
          </Row>
          <div className={lens.actions}>
            <Button
              size="sm" onClick={() => { const next = applyKeyOp(keys, { type: 'remove', match: keyObj }); if (next) write(next, null) }}
              hint="Delete this key. Right-clicking a key in the lane does the same."
            >
              Delete key
            </Button>
          </div>
        </div>
      ) : (
        <p className={lens.note} data-testid="roam-key-empty">
          Select a key in the lane or on the motion path to edit its value, position and interp.
        </p>
      )}
    </div>
  )
}
