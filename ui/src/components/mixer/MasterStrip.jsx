import { useCallback, useEffect, useRef, useState } from 'react'
import { Fader, Meter, NumberBox, dbTaperScale, formatValue } from '../../ui-kit'
import useMixerStore from '../../stores/mixerStore.js'
import useEffectChainStore, { resolveFxMode } from '../../stores/effectChainStore.js'
import useFxChainDragStore from '../../stores/fxChainDragStore.js'
import InsertList from './InsertList.jsx'
import { METER_FLOOR_DB, subscribeMeter } from './mixerMeterBus.js'
import { GAIN_FORMAT, dbToGain, gainToDb } from './mixerMath.js'
import { VerticalName, openDevicesFor, useFxDropState, useMeterSubscribe } from './MixerStrip.jsx'
import styles from './MixerStrip.module.css'

const EMPTY_CHAIN = []
const MASTER_FX_KEY = 'master'
const NO_PEAK = '—'
/** The master's meter prints numerals (a track's prints ticks), so the name beside it needs this much more than a strip. */
const MASTER_NAME_W = 16

/** "−3.2 dB", or a dash while nothing has been measured. */
export function peakText(db) {
  return Number.isFinite(db) && db > METER_FLOOR_DB ? formatValue(db, 'dB', GAIN_FORMAT) : NO_PEAK
}

/**
 * The highest master level since the last reset, as a number. It reads the same
 * bus the meter beside it reads (the mixer's one peak poll): no timer, and "—"
 * until a level has actually arrived. Click or Enter resets it.
 */
function MasterPeak() {
  const valueRef = useRef(null)
  const holdRef = useRef(METER_FLOOR_DB)

  const paint = useCallback(() => {
    const el = valueRef.current
    if (!el) return
    const text = peakText(holdRef.current)
    if (el.textContent !== text) el.textContent = text
    el.parentElement?.setAttribute('aria-label', `Master peak since reset: ${text === NO_PEAK ? 'nothing measured' : text}. Activate to reset`)
    if (holdRef.current >= 0) el.parentElement?.setAttribute('data-over', 'true')
    else el.parentElement?.removeAttribute('data-over')
  }, [])

  useEffect(() => subscribeMeter(MASTER_FX_KEY, (levels) => {
    const now = Math.max(levels[0] ?? METER_FLOOR_DB, levels[1] ?? METER_FLOOR_DB)
    if (now > holdRef.current) {
      holdRef.current = now
      paint()
    }
  }), [paint])

  const reset = useCallback((e) => {
    e.stopPropagation()
    holdRef.current = METER_FLOOR_DB
    paint()
  }, [paint])

  return (
    <button
      type="button"
      className={styles.peak}
      aria-label="Master peak since reset: nothing measured. Activate to reset"
      data-hint="Highest master level since the last reset. Over 0 dB it is marked with the word Over."
      data-hint-mods="Click: reset"
      data-testid="master-peak"
      onClick={reset}
    >
      <span className={styles.peakLabel}>Peak</span>
      <span ref={valueRef} className={styles.peakValue}>{NO_PEAK}</span>
      <span className={styles.peakOver}>Over</span>
    </button>
  )
}

export default function MasterStrip({ stripW = 72, insertRowCount = 5, insertsOpen = false }) {
  const masterVolume = useMixerStore(s => s.master.volume)
  const setMasterVolume = useMixerStore(s => s.setMasterVolume)
  const selected = useMixerStore(s => s.selectedChainKey === MASTER_FX_KEY)
  const setSelectedChainKey = useMixerStore(s => s.setSelectedChainKey)
  const chain = useEffectChainStore(s => s.chains[MASTER_FX_KEY] ?? EMPTY_CHAIN)
  const fxMode = useEffectChainStore(s => resolveFxMode(s.fxModes, MASTER_FX_KEY))
  const fetchChain = useEffectChainStore(s => s.fetchChain)
  const openFxChainMenu = useFxChainDragStore(s => s.openMenu)
  const fxDrop = useFxDropState(MASTER_FX_KEY)
  const subscribe = useMeterSubscribe(MASTER_FX_KEY)
  const masterW = stripW + MASTER_NAME_W

  // Fill the chain cache for this strip's own insert list (see MixerStrip).
  useEffect(() => {
    fetchChain(MASTER_FX_KEY)
  }, [fetchChain])

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
  const handleOpenInsert = useCallback((deviceIndex) => openDevicesFor(MASTER_FX_KEY, null, deviceIndex), [])

  return (
    <div
      className={`${styles.strip} ${styles.master}`}
      style={{ '--strip-w': `${masterW}px` }}
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
        <span className={styles.numRow} aria-hidden="true">
          <span className={styles.num}>M</span>
        </span>
      </div>

      <InsertList name="Master" chain={chain} fxMode={fxMode} rows={insertRowCount} expanded={insertsOpen} onOpen={handleOpenInsert} />

      {/* Where a track has M / S / V and pan + width. The master has neither; the same two
          rows hold its peak readout, so its fader and meter line up with every strip's. */}
      <MasterPeak />

      <div className={styles.field}>
        <NumberBox
          label="Master volume" hideLabel fill={false} width={masterW - 7} scale={dbTaperScale} unit="dB"
          formatOptions={GAIN_FORMAT} defaultValue={0}
          value={db} onChange={handleLive} onCommit={handleCommit} hint="Master volume"
        />
      </div>

      <div className={styles.faderRow}>
        <Fader
          label="Master volume" scale={dbTaperScale} unit="dB" formatOptions={GAIN_FORMAT} defaultValue={0} width={28}
          value={db} onChange={handleLive} onCommit={handleCommit} hint="Master volume"
        />
        {/* The same tick set, at the same y, as every strip: same rows, same scale. Numerals
            are printed here too (the gutter is at the far left of a long mixer). */}
        <Meter label="Master" channels={2} tone="audio" clipLatch="latched" subscribe={subscribe} hint="Master level, in dB" />
        <VerticalName name="Master" />
      </div>
      <div className={styles.cableSpace} aria-hidden="true" />
      <div className={styles.outSpace} aria-hidden="true" />
    </div>
  )
}
