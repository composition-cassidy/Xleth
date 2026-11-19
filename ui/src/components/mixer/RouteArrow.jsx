import { memo, useCallback } from 'react'
import { Knob, hintAttrs } from '../../ui-kit'
import useMixerStore, { MASTER_OUTPUT_TARGET_ID, normalizeOutputTargetId } from '../../stores/mixerStore.js'
import { SEND_GAIN_MAX, formatSendGain, isRoutedTo, isSidechainedTo } from './routeSets.js'
import styles from './MixerStrip.module.css'

const EMPTY = []

/** "−6" → 0.501…: a typed send level is read as dB. */
function parseSendGain(text) {
  const s = String(text).trim().toLowerCase()
  if (s.startsWith('-inf')) return 0
  const db = parseFloat(s)
  return Number.isFinite(db) ? Math.min(SEND_GAIN_MAX, 10 ** (db / 20)) : null
}

/**
 * The routing arrow at the foot of a strip (FL Studio's "route to this track"
 * button). It always speaks for the SELECTED strip, the source:
 * - click: route the selected track here as well, or unroute it (multi-wiring;
 *   every track starts routed to Master only);
 * - Ctrl+click: route the selected track here only;
 * - right-click: sidechain the selected track here (a silent key: an effect on
 *   this track listens when its sidechain is set to external).
 * Lit white = audio routed here, yellow = sidechained here. A routed send also
 * shows its level dial next to the arrow.
 */
function RouteArrow({ targetTrackId, targetName }) {
  const targetId = normalizeOutputTargetId(targetTrackId)
  const selectedKey = useMixerStore(s => s.selectedChainKey)
  const sourceId = selectedKey != null && selectedKey !== 'master' ? Number(selectedKey) : null
  const sourceName = useMixerStore(s => (sourceId != null ? s.tracks[sourceId]?.name : null)) || (sourceId != null ? `Track ${sourceId}` : '')
  const sourceVisualOnly = useMixerStore(s => (sourceId != null ? Boolean(s.tracks[sourceId]?.visualOnly) : false))
  const primary = useMixerStore(s => (sourceId != null ? s.outputRoutes[sourceId] ?? MASTER_OUTPUT_TARGET_ID : null))
  const sends = useMixerStore(s => (sourceId != null ? s.sends[sourceId] ?? EMPTY : EMPTY))
  const sidechainRoutes = useMixerStore(s => s.sidechainRoutes)
  const toggleAudioRoute = useMixerStore(s => s.toggleAudioRoute)
  const toggleTrackSidechain = useMixerStore(s => s.toggleTrackSidechain)
  const setSendGain = useMixerStore(s => s.setSendGain)

  const isSelf = sourceId != null && sourceId === targetId
  const active = sourceId != null && !isSelf && !sourceVisualOnly
  const audio = active && isRoutedTo(primary, sends, targetId)
  const sidechain = active && targetId !== MASTER_OUTPUT_TARGET_ID && isSidechainedTo(sidechainRoutes, sourceId, targetId)
  const send = active ? sends.find(s => s.targetTrackId === targetId) : null

  // The row sits inside the strip, whose click selects it and whose right-click
  // opens the FX chain menu: neither may fire from here.
  const stop = useCallback((e) => e.stopPropagation(), [])
  const handleClick = useCallback((e) => {
    e.stopPropagation()
    if (!active) return
    toggleAudioRoute(sourceId, targetId, { only: e.ctrlKey || e.metaKey })
  }, [active, toggleAudioRoute, sourceId, targetId])
  const handleContextMenu = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    if (!active) return
    toggleTrackSidechain(sourceId, targetId)
  }, [active, toggleTrackSidechain, sourceId, targetId])
  const handleGain = useCallback((g) => setSendGain(sourceId, targetId, g), [setSendGain, sourceId, targetId])

  if (isSelf) {
    return (
      <div className={styles.route} onClick={stop} onContextMenu={stop} data-testid={`route-${targetId}`} data-self="true">
        <span className={styles.routeSelf} aria-hidden="true" />
      </div>
    )
  }

  const state = [audio ? 'routed' : 'not routed', sidechain ? 'sidechained' : null].filter(Boolean).join(', ')
  const hint = !active
    ? (sourceVisualOnly ? 'The selected track is visual only: it has no audio to route.' : 'Select a track, then click here to route it to this one.')
    : `${sourceName} → ${targetName}: ${state}. Click: route here too / unroute. Ctrl+click: route here only. Right-click: sidechain here.`

  return (
    <div className={styles.route} onClick={stop} onDoubleClick={stop} onContextMenu={stop} data-testid={`route-${targetId}`}>
      <button
        type="button"
        className={styles.routeArrow}
        aria-label={active ? `Route ${sourceName} to ${targetName}` : `Route to ${targetName}`}
        aria-pressed={audio}
        aria-disabled={!active || undefined}
        data-audio={audio || undefined}
        data-sidechain={sidechain || undefined}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        {...hintAttrs({ hint })}
      >
        <svg viewBox="0 0 12 10" width="12" height="10" aria-hidden="true">
          <path d="M6 1 L11 9 L1 9 Z" />
        </svg>
      </button>
      {send ? (
        <Knob
          className={styles.routeLevel}
          label={`Send level ${sourceName} to ${targetName}`}
          hideLabel hideValue minimal size={14} width={16}
          min={0} max={SEND_GAIN_MAX} defaultValue={1}
          value={send.gain} format={formatSendGain} parse={parseSendGain}
          onChange={handleGain} onCommit={handleGain}
          hint={`Level of ${sourceName} into ${targetName}`}
        />
      ) : null}
    </div>
  )
}

export default memo(RouteArrow)
