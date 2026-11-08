import React from 'react'
import { IconButton, SourceAudioIcon, SourceVideoIcon } from '../../ui-kit'
import useVideoDeviceStore from './video/videoDeviceStore.js'
import styles from './ChainHead.module.css'

/**
 * The start of a device chain: which track it is (its name, vertical, on the
 * track's identity colour edge) and the Audio | Video switch. The same head and
 * the same identity colour on both sides: the sound and the picture of one track
 * read as one instrument.
 *
 * Props: name, identityColor (CSS colour or undefined for Master), videoDisabled.
 */
export default function ChainHead({ name, identityColor, videoDisabled = false }) {
  const view = useVideoDeviceStore((s) => s.view)
  const setView = useVideoDeviceStore((s) => s.setView)
  return (
    <div
      className={styles.head}
      style={identityColor ? { '--chain-id': identityColor } : undefined}
      data-testid="xleth-device-chain-head"
    >
      <div className={styles.switch} role="group" aria-label="Chain view">
        <IconButton
          size="sm"
          label="Audio effects"
          hint={`Show ${name}'s audio effects`}
          pressed={view === 'audio'}
          onClick={() => setView('audio')}
          data-chain-view="audio"
        >
          <SourceAudioIcon aria-hidden="true" />
        </IconButton>
        <IconButton
          size="sm"
          label="Video effects"
          hint={videoDisabled ? 'Master has no picture. Select a track to see its video effects.' : `Show ${name}'s video effects`}
          pressed={view === 'video'}
          onClick={() => setView('video')}
          data-chain-view="video"
        >
          <SourceVideoIcon aria-hidden="true" />
        </IconButton>
      </div>
      <span className={styles.name} title={name}>{name}</span>
    </div>
  )
}
