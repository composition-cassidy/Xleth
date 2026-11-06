import React, { useCallback, useEffect, useRef, useState } from 'react'
import useCompressorStore from '../../stores/compressorStore.js'
import useEffectChainStore from '../../stores/effectChainStore.js'
import EffectDevice from '../devices/EffectDevice.jsx'
import styles from './CompressorPanel.module.css'

// The popped-out Compressor: the SAME device as the Devices tab (DeviceFrame +
// CompressorDevice), in a floating window mounted by EffectEditorHost. Opened by
// the device's pop-out button, the Mixer chain row and the FX Graph's Edit
// button, all through useCompressorStore.open(trackId, nodeId, storeKey).
//
// Bypass needs the chain entry (useEffectChainStore owns it). An effect opened
// from the FX Graph has none, so the activator shows its state but is disabled
// there: the graph owns that bypass.

const FALLBACK = { pluginId: 'compressor', bypassed: false }

export default function CompressorPanel() {
  const target = useCompressorStore((s) => s.target)
  const close = useCompressorStore((s) => s.close)
  const chainEntry = useEffectChainStore((s) => (
    target ? (s.chains[target.storeKey] ?? []).find((fx) => fx.nodeId === target.nodeId) ?? null : null
  ))

  const [pos, setPos] = useState(() => ({ x: Math.round(window.innerWidth / 2 - 350), y: 80 }))
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

  const effect = chainEntry ?? { ...FALLBACK, nodeId: target.nodeId }
  return (
    <div className={styles.window} style={{ left: pos.x, top: pos.y }} data-testid="compressor-window">
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
