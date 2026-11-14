import { Button, NumberBox, SegmentedControl, Select } from '../../ui-kit'
import { channelNumberProps, pctFmt, ticksFmt } from '../../lensRoam/lensFormats.js'
import { NOTE_ANCHORS, anchorReached, noteSpan, reanchorKey } from '../../lensRoam/lensKeyModel.js'
import styles from '../inspector/Inspector.module.css'
import lens from './lensRoam.module.css'

// The selected key's numbers: value, anchor, position, interpolation. The same
// edit the lane's drag makes, typed. Every field is ONE commit (one undo step);
// nothing previews through the engine.

const CHANNEL_NAMES = { zoom: 'Zoom', centerX: 'Center X', centerY: 'Center Y', rotationDeg: 'Rotate' }

const ANCHOR_OPTIONS = [
  { value: 'Head', label: 'Head', hint: 'Ticks after the note starts. Fixed length: it does not stretch with the note.' },
  { value: 'Body', label: 'Body', hint: 'A fraction of the span between the head and the tail. Stretches with the note.' },
  { value: 'Tail', label: 'Tail', hint: 'Ticks before the end of the note. Fixed length.' },
]

const INTERP_OPTIONS = [
  { value: 'Hold', label: 'Hold', hint: 'Keep this key\'s value until the next key, then step.' },
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

/**
 * @param {object} props
 * @param {object|null} props.keyObj    the selected own key
 * @param {'note'|'event'} props.kind
 * @param {object} [props.zones]        normalized zones (note)
 * @param {number} props.lengthTicks    the note's / event's length
 * @param {(op: object) => void} props.onOp
 * @param {(key: object|null) => void} props.onSelect
 */
export default function LensKeyInspector({ keyObj, kind, zones, lengthTicks, onOp, onSelect }) {
  if (!keyObj) {
    return <p className={lens.note} data-testid="lens-key-empty">Select a key to edit its value, anchor and position.</p>
  }
  const absolute = kind === 'event'
  const span = kind === 'note' ? noteSpan(lengthTicks, zones) : null
  const update = (patch) => {
    onOp({ type: 'update', match: keyObj, patch })
    onSelect({ ...keyObj, ...patch })
  }
  const reached = !span || anchorReached(span, keyObj.anchor, keyObj.pos)

  const posProps = keyObj.anchor === 'Body'
    ? { min: 0, max: 1, format: pctFmt.format, parse: pctFmt.parse, defaultValue: 0.5 }
    : {
        min: 0,
        max: keyObj.anchor === 'Origin' ? Math.max(1, lengthTicks) : keyObj.anchor === 'Tail' ? zones?.tailTicks ?? 240 : zones?.headTicks ?? 120,
        format: ticksFmt.format, parse: ticksFmt.parse, defaultValue: 0, step: 1,
      }
  const posHint = {
    Head: 'How many ticks after the note starts. 960 ticks is a quarter note.',
    Body: 'How far through the body, from its start (0 %) to its end (100 %).',
    Tail: 'How many ticks before the end of the note. 0 is the last frame.',
    Origin: 'How many ticks after the event starts. 960 ticks is a quarter note.',
  }[keyObj.anchor]

  return (
    <div data-testid="lens-key-inspector" aria-label={`${CHANNEL_NAMES[keyObj.channel]} key`}>
      <Row label={`${CHANNEL_NAMES[keyObj.channel]} key`}>
        <NumberBox
          label="Key value" hideLabel width={88} value={keyObj.value}
          {...channelNumberProps(keyObj.channel, absolute)}
          onCommit={(value) => update({ value })}
          hint={absolute
            ? 'The value this key holds. A keyed channel follows its keys; the static value is ignored.'
            : keyObj.channel === 'zoom'
              ? 'The multiplier this key applies on top of the base zoom.'
              : 'How far this key moves the picture, added to the base.'}
        />
      </Row>
      {kind === 'note' && (
        <Row label="Anchor">
          <SegmentedControl
            size="sm" label="Key anchor" options={ANCHOR_OPTIONS} value={keyObj.anchor}
            onChange={(anchor) => {
              if (NOTE_ANCHORS.includes(anchor) && anchor !== keyObj.anchor) {
                const moved = reanchorKey(keyObj, anchor, span)
                update({ anchor: moved.anchor, pos: moved.pos })
              }
            }}
            hint="Which part of the note the key is measured from. Alt-drag across a band edge does the same."
          />
        </Row>
      )}
      <Row label="Position">
        <NumberBox
          label="Key position" hideLabel width={88} value={keyObj.pos}
          {...posProps}
          onCommit={(pos) => update({ pos })}
          hint={posHint}
        />
      </Row>
      <Row label="Interp">
        <Select
          size="sm" ariaLabel="Key interpolation" value={keyObj.interp ?? 'Linear'} options={INTERP_OPTIONS}
          onChange={(interp) => update({ interp })}
          hint="The shape of the segment leaving this key."
        />
      </Row>
      {!reached && (
        <p className={lens.note} data-testid="lens-key-unreached">
          This key is cut off at this note length (Cut). A longer note plays it.
        </p>
      )}
      <div className={lens.actions}>
        <Button
          size="sm"
          onClick={() => { onOp({ type: 'remove', match: keyObj }); onSelect(null) }}
          hint="Delete this key. Right-click a key or press Delete does the same."
        >
          Delete key
        </Button>
      </div>
    </div>
  )
}
