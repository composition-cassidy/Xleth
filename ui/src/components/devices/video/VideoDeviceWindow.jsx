import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import useTrackIdentityColors from '../../inspector/useTrackIdentityColors.js'
import floatStyles from '../FloatingDevice.module.css'
import VideoChainDevice from './VideoChainDevice.jsx'
import useVideoTracks from './useVideoTracks.js'
import useVideoDeviceStore from './videoDeviceStore.js'

/**
 * The popped-out video device: the SAME device as the Video view, in a draggable
 * window (the audio FloatingDevice's window, its hard offset shadow drawn by the
 * frame). One at a time; the docked slot shows a return strip meanwhile.
 * Mounted once by the shell. Closes itself when its entry no longer exists.
 */
export default function VideoDeviceWindow() {
  const win = useVideoDeviceStore((s) => s.window)
  const closeWindow = useVideoDeviceStore((s) => s.closeWindow)
  const { tracks, loaded } = useVideoTracks()
  const identity = useTrackIdentityColors(tracks)
  const track = useMemo(() => (win ? tracks.find((t) => t.id === win.trackId) ?? null : null), [tracks, win])
  const fx = win?.kind === 'chain' ? track?.visualEffectChain?.[win.key] ?? null : null

  const [pos, setPos] = useState(() => ({ x: Math.round(window.innerWidth / 2 - 240), y: 80 }))
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

  useEffect(() => {
    if (win && loaded && win.kind === 'chain' && !fx) closeWindow()
  }, [win, loaded, fx, closeWindow])

  if (!win || !track) return null
  const dragHandleProps = {
    onPointerDown: (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      dragRef.current = { x: pos.x, y: pos.y, mx: e.clientX, my: e.clientY }
      document.addEventListener('pointermove', onPointerMove)
      document.addEventListener('pointerup', onPointerUp)
    },
  }

  return (
    <div className={floatStyles.window} style={{ left: pos.x, top: pos.y }} data-testid="video-device-window">
      {fx ? (
        <VideoChainDevice
          track={track}
          fx={fx}
          index={win.key}
          identityColor={identity[track.id]}
          presentation="floating"
          onClose={closeWindow}
          dragHandleProps={dragHandleProps}
        />
      ) : null}
    </div>
  )
}
