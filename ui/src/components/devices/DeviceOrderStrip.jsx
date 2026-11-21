import React from 'react'
import { getEffectChainRowKey } from '../mixer/EffectChainPanel.jsx'
import { deviceName } from './deviceNames.js'
import styles from './DeviceOrderStrip.module.css'

// The whole chain as small chips, in signal order, so a device can be reordered without
// dragging a wide panel across the others. Dragging and Alt+Arrow are owned by DeviceChain
// (the strip shares its drag state); a plain click on a chip scrolls its device into view.
//
// shortcut: one line that scrolls sideways, no wrap, because the drop index comes from the
// pointer's x alone; upgrade to a wrapping grid if chains of 15+ devices become common.
export default function DeviceOrderStrip({ chain, vstPlugins, stripRef, onChipPointerDown, onChipKeyDown, onChipClick }) {
  return (
    <div className={styles.strip} ref={stripRef} role="toolbar" aria-label="Device order">
      {chain.map((effect, index) => {
        const live = Number.isInteger(effect.nodeId) && effect.nodeId >= 0
        const name = deviceName(effect, vstPlugins)
        return (
          <button
            type="button"
            key={getEffectChainRowKey(effect, index)}
            className={styles.chip}
            data-device-index={index}
            data-device-node={effect.nodeId}
            data-bypassed={effect.bypassed ? true : undefined}
            data-hint={live ? `${name}: drag to reorder, Alt+Left/Right to move` : name}
            aria-label={`${name}, position ${index + 1} of ${chain.length}${effect.bypassed ? ', off' : ''}`}
            onPointerDown={live ? onChipPointerDown(effect, index) : undefined}
            onKeyDown={live ? onChipKeyDown(effect, index) : undefined}
            onClick={() => onChipClick(effect)}
          >
            <span className={styles.pos}>{index + 1}</span>
            <span className={styles.name}>{name}</span>
          </button>
        )
      })}
    </div>
  )
}
