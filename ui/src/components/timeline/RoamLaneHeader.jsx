import { IconButton, Select, Toggle } from '../../ui-kit'
import { iconComponent } from '../../ui-kit/icons'
import useRoamKeysStore, { DEFAULT_ROAM_CHANNEL } from '../../stores/useRoamKeysStore.js'
import { ROAM_CHANNEL_OPTIONS } from '../../lensRoam/roamKeyModel.js'
import styles from './RoamLaneHeader.module.css'

const IcRecord = iconComponent('record')
const IcX = iconComponent('x')

/**
 * The label cell of a track's Roam key lane: the parameter the lane draws, the
 * Auto-key toggle (shared with the Roam inspector) and a close button. Lane
 * state is session view state (stores/useRoamKeysStore), never saved.
 */
export default function RoamLaneHeader({ row, color, trackName }) {
  const trackId = row.parentTrackId
  const channel = useRoamKeysStore((s) => s.channelByTrack[trackId]) ?? DEFAULT_ROAM_CHANNEL
  const autoKey = useRoamKeysStore((s) => s.autoKey)
  const setChannel = useRoamKeysStore((s) => s.setChannel)
  const setAutoKey = useRoamKeysStore((s) => s.setAutoKey)
  const setLaneOpen = useRoamKeysStore((s) => s.setLaneOpen)
  return (
    <div
      className={`track-header-roam-lane ${styles.roamLane}`}
      style={{ height: row.height, borderLeftColor: color }}
      role="group"
      aria-label={`Roam key lane for ${trackName ?? 'track'}`}
    >
      <div className={styles.top}>
        <span className={styles.label}>Roam</span>
        <Toggle
          size="sm" on={autoKey} onChange={setAutoKey} glyph={<IcRecord size={12} aria-hidden="true" />}
          aria-label="Auto-key"
          hint="Auto-key: moving, scaling or turning the cell in the viewer writes a key at the playhead."
          hintMods="The first key on a parameter also keys where it was a bar earlier."
        >
          Auto-key
        </Toggle>
        <IconButton
          size="sm" label="Hide Roam key lane" onClick={() => setLaneOpen(trackId, false)}
          hint="Hide this lane. The keys stay: they still move the cell."
        >
          <IcX size={12} aria-hidden="true" />
        </IconButton>
      </div>
      <Select
        size="sm" ariaLabel="Roam parameter shown in the lane" value={channel} options={ROAM_CHANNEL_OPTIONS}
        onChange={(c) => setChannel(trackId, c)}
        hint="Which Roam parameter this lane shows. Each parameter has its own keys."
        hintMods="Click: add a key · Drag: move · Alt: no snap · Shift: fine value · Right-click a key: delete"
      />
    </div>
  )
}
