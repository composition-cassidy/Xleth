import React from 'react'
import styles from './ChainHead.module.css'

/**
 * The start of a device chain: which track it is (its name, vertical, on the track's identity
 * colour edge). The same head and the same identity colour in the Audio and the Video lane:
 * the sound and the picture of one track read as one instrument.
 *
 * Props: name, identityColor (CSS colour or undefined for Master).
 */
export default function ChainHead({ name, identityColor }) {
  return (
    <div
      className={styles.head}
      style={identityColor ? { '--chain-id': identityColor } : undefined}
      data-testid="xleth-device-chain-head"
    >
      <span className={styles.name} title={name}>{name}</span>
    </div>
  )
}
