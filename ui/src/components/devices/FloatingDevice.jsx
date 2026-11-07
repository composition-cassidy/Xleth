import React, { useCallback, useEffect, useRef, useState } from 'react'
import useEffectChainStore from '../../stores/effectChainStore.js'
import EffectDevice from './EffectDevice.jsx'
import styles from './FloatingDevice.module.css'

// The popped-out window for a migrated device: the SAME device as the Devices
// tab (DeviceFrame + its body), in a draggable window mounted by
// EffectEditorHost. Opened by the device's pop-out button, the Mixer chain row
// and the FX Graph's Edit button, all through the effect's editor store.
//
// Bypass needs the chain entry (useEffectChainStore owns it). An effect opened
// from the FX Graph has none, so the activator shows its state but is disabled
// there: the graph owns that bypass.
export default function FloatingDevice({ useStore, pluginId, testId, halfWidth = 350 }) {
  const target = useStore((s) => s.target)
  const close = useStore((s) => s.close)
  const chainEntry = useEffectChainStore((s) => (
    target ? (s.chains[target.storeKey] ?? []).find((fx) => fx.nodeId === target.nodeId) ?? null : null
  ))

  const [pos, setPos] = useState(() => ({ x: Math.round(window.innerWidth / 2 - halfWidth), y: 80 }))
  const dragRef = useRef(null)

  const onPointerMove = useCallback((e) => {
    const d = dragRef.current
    if (!d) return
    setPos({
      x: Math.max(-400, Math.min(window.innerWidth - 100, d.x + e.clientX - d.mx)),
      y: Math.max(0, Math.min(window.innerHeight - 100, d.y + e.clientY - d.my)),
    })
  }, [])
  const onPointerUp = useCallback(() => {
    dragRef.current = null
    document.removeEventListener('pointermove', onPointerMove)
    document.removeEventListener('pointerup', onPointerUp)
  }, [onPointerMove])
  useEffect(() => onPointerUp, [onPointerUp])

  const onTitlePointerDown = (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    dragRef.current = { x: pos.x, y: pos.y, mx: e.clientX, my: e.clientY }
    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerup', onPointerUp)
  }

  if (!target) return null

  const effect = chainEntry ?? { pluginId, bypassed: false, nodeId: target.nodeId }
  return (
    <div className={styles.window} style={{ left: pos.x, top: pos.y }} data-testid={testId}>
      <EffectDevice
        effect={effect}
        storeKey={target.storeKey}
        presentation="floating"
        canBypass={chainEntry != null}
        onClose={close}
        dragHandleProps={{ onPointerDown: onTitlePointerDown }}
      />
    </div>
  )
}
