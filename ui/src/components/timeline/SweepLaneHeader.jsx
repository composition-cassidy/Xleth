import { IconButton, Select } from '../../ui-kit'
import { iconComponent } from '../../ui-kit/icons'
import useSweepKeysStore, { DEFAULT_SWEEP_CHANNEL } from '../../stores/useSweepKeysStore.js'
import { SWEEP_CHANNEL_OPTIONS } from '../../lensRoam/roamKeyModel.js'
import styles from './RoamLaneHeader.module.css'

const IcX = iconComponent('x')

/**
 * The label cell of a Pattern track's Sweep lane: the parameter the lane draws and a
 * close button. It is the Roam lane's header minus Auto-key (see RoamLaneHeader), on
 * the same styles. Lane state is session view state (stores/useSweepKeysStore).
 */
export default function SweepLaneHeader({ row, color, trackName }) {
  const trackId = row.parentTrackId
  const channel = useSweepKeysStore((s) => s.channelByTrack[trackId]) ?? DEFAULT_SWEEP_CHANNEL
  const setChannel = useSweepKeysStore((s) => s.setChannel)
  const setLaneOpen = useSweepKeysStore((s) => s.setLaneOpen)
  return (
    <div
      className={`track-header-sweep-lane ${styles.roamLane}`}
      style={{ height: row.height, borderLeftColor: color }}
      role="group"
      aria-label={`Sweep lane for ${trackName ?? 'track'}`}
    >
      <div className={styles.top}>
        <span className={styles.label}>Sweep</span>
        <IconButton
          size="sm" label="Hide Sweep lane" onClick={() => setLaneOpen(trackId, false)}
          hint="Hide this lane. The keys stay: they still move the picture."
        >
          <IcX size={12} aria-hidden="true" />
        </IconButton>
      </div>
      <Select
        size="sm" ariaLabel="Sweep parameter shown in the lane" value={channel} options={SWEEP_CHANNEL_OPTIONS}
        onChange={(c) => setChannel(trackId, c)}
        hint="Which Lens parameter this lane shows. Zoom multiplies the notes' framing; centre and rotation add to it."
        hintMods="Click: add a key · Drag: move · Alt: no snap · Shift: fine value · Right-click a key: delete"
      />
    </div>
  )
}
