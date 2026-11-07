import { useCallback, useState } from 'react'
import { Button, Fader, Meter, NumberBox, dbTaperScale } from '../../ui-kit'
import useMixerStore from '../../stores/mixerStore.js'
import useEffectChainStore, { resolveFxMode } from '../../stores/effectChainStore.js'
import useFxChainDragStore from '../../stores/fxChainDragStore.js'
import { dbToGain, gainToDb, insertLabel } from './mixerMath.js'
import { openDevicesFor, useFxDropState, useMeterSubscribe } from './MixerStrip.jsx'
import styles from './MixerStrip.module.css'

const EMPTY_CHAIN = []
const MASTER_FX_KEY = 'master'

export default function MasterStrip({ stripW = 84 }) {
  const masterVolume = useMixerStore(s => s.master.volume)
  const setMasterVolume = useMixerStore(s => s.setMasterVolume)
  const selected = useMixerStore(s => s.selectedChainKey === MASTER_FX_KEY)
  const setSelectedChainKey = useMixerStore(s => s.setSelectedChainKey)
  const chain = useEffectChainStore(s => s.chains[MASTER_FX_KEY] ?? EMPTY_CHAIN)
  const fxMode = useEffectChainStore(s => resolveFxMode(s.fxModes, MASTER_FX_KEY))
  const openFxChainMenu = useFxChainDragStore(s => s.openMenu)
  const fxDrop = useFxDropState(MASTER_FX_KEY)
  const subscribe = useMeterSubscribe(MASTER_FX_KEY)

  // Live drag frames stay local (never cross the bridge); the store, and the IPC
  // call inside setMasterVolume, is only touched once, on commit.
  const [liveDb, setLiveDb] = useState(null)
  const handleLive = useCallback((db) => setLiveDb(db), [])
  const handleCommit = useCallback((db) => {
    setLiveDb(null)
    setMasterVolume(dbToGain(db))
  }, [setMasterVolume])
  const db = liveDb != null ? liveDb : gainToDb(masterVolume)

  const handleSelect = useCallback(() => setSelectedChainKey(MASTER_FX_KEY), [setSelectedChainKey])
  const handleContextMenu = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    openFxChainMenu(MASTER_FX_KEY, e.clientX, e.clientY)
  }, [openFxChainMenu])

  return (
    <div
      className={`${styles.strip} ${styles.master}`}
      style={{ '--strip-w': `${stripW}px` }}
      data-selected={selected}
      data-fx-drop={fxDrop}
      data-fx-key={MASTER_FX_KEY}
      data-testid="master-strip"
      role="group"
      aria-label="Master"
      aria-selected={selected}
      onClick={handleSelect}
      onContextMenu={handleContextMenu}
    >
      <div className={styles.head}>
        <span className={styles.name}>Master</span>
      </div>

      <Button
        size="sm"
        className={styles.inserts}
        aria-label={`Master: ${insertLabel(chain, fxMode)}. Open in Devices`}
        hint="Inserts on the master bus. Opens the Devices tab."
        onClick={(e) => { e.stopPropagation(); openDevicesFor(MASTER_FX_KEY, null) }}
      >
        {insertLabel(chain, fxMode)}
      </Button>

      <div className={styles.field}>
        <NumberBox
          label="Master volume" hideLabel width={stripW - 8} scale={dbTaperScale} unit="dB" defaultValue={0}
          value={db} onChange={handleLive} onCommit={handleCommit} hint="Master volume"
        />
      </div>

      <div className={styles.faderRow}>
        <Fader
          label="Master volume" scale={dbTaperScale} unit="dB" defaultValue={0} width={28}
          value={db} onChange={handleLive} onCommit={handleCommit} hint="Master volume"
        />
        <Meter label="Master" channels={2} subscribe={subscribe} hint="Master level" />
      </div>
      <div className={styles.cableSpace} aria-hidden="true" />
    </div>
  )
}
