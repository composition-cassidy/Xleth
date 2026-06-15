import React from 'react'
import useMixerStore from '../../stores/mixerStore.js'
import EffectChainPanel from './EffectChainPanel.jsx'

export default function SelectedEffectRack() {
  const reactiveSelectedChainKey = useMixerStore(s => s.selectedChainKey)
  const reactiveTracks = useMixerStore(s => s.tracks)
  const renderingWithoutDom = typeof document === 'undefined'
  const mixerState = renderingWithoutDom ? useMixerStore.getState() : null
  const selectedChainKey = mixerState ? mixerState.selectedChainKey : reactiveSelectedChainKey
  const tracks = mixerState ? mixerState.tracks : reactiveTracks

  const selectedTrack = selectedChainKey && selectedChainKey !== 'master'
    ? tracks[Number(selectedChainKey)] ?? null
    : null
  const isMasterSelected = selectedChainKey === 'master'
  const title = isMasterSelected ? 'MASTER' : selectedTrack?.name

  return (
    <aside className="selected-effect-rack" aria-label="Selected mixer effect rack">
      <div className="selected-effect-rack-header">
        <div
          className={`selected-effect-rack-title ${title ? '' : 'selected-effect-rack-title--empty'}`}
          title={title || 'No mixer track selected'}
        >
          {title || 'No track selected'}
        </div>
      </div>

      {isMasterSelected ? (
        <EffectChainPanel master mode="editable" />
      ) : selectedTrack ? (
        <EffectChainPanel trackId={selectedTrack.id} mode="editable" />
      ) : (
        <div className="selected-effect-rack-empty" role="status">
          Select a mixer track
        </div>
      )}
    </aside>
  )
}
