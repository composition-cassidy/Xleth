import { useCallback, useState } from 'react'
import useSandboxStore from '../../stores/sandboxStore.js'

// ── Dropping audio into the Sandbox ─────────────────────────────────────────
//
// A project sample (dragged from the Samples tab) or an audio file (dragged
// from Explorer) becomes a new layer. The handlers are a hook so the whole
// body of the panel — the editor AND the layer list — is one drop target: the
// natural place to drop a new layer is the list of layers, and the natural
// place to drop the first one is the empty editor.

const DROPPABLE_AUDIO_EXT = /\.(wav|mp3|flac|aiff?|ogg|m4a|wma|opus)$/i

export function useSandboxSourceDrop() {
  const addSourceFromRegion = useSandboxStore((s) => s.addSourceFromRegion)
  // Shared with the separation strip — a stem and a dropped file enter the
  // workspace through the same door. See sandboxStore.addSourceFromFile.
  const addSourceFromFile = useSandboxStore((s) => s.addSourceFromFile)
  const [dragOver, setDragOver] = useState(false)

  const onDragOver = useCallback((e) => {
    const types = Array.from(e.dataTransfer.types || [])
    if (!types.includes('application/xleth-sample') && !types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDragOver(true)
  }, [])

  // dragleave also fires when the pointer crosses into a child, so only a
  // leave that actually exits the drop target clears the overlay.
  const onDragLeave = useCallback((e) => {
    if (e.currentTarget.contains(e.relatedTarget)) return
    setDragOver(false)
  }, [])

  const onDrop = useCallback((e) => {
    e.preventDefault()
    setDragOver(false)

    const raw = e.dataTransfer.getData('application/xleth-sample')
    if (raw) {
      try {
        const dropped = JSON.parse(raw)
        // Drag payloads (SampleRow/SampleThumbnail) key the region id as
        // `regionId`; addSourceFromRegion expects `id` (the shape the
        // context-menu "Open in Sample Sandbox" entry point already passes).
        const region = { ...dropped, id: dropped.regionId ?? dropped.id }
        addSourceFromRegion(region)
      } catch (err) {
        console.warn('[SampleSandbox] Bad drop payload:', err?.message || err)
      }
      return
    }

    const files = Array.from(e.dataTransfer.files || [])
    if (files.length === 0) return
    // Electron 41+ removed File.path; use webUtils via the preload bridge
    // (same fallback chain as ImportDropZone.jsx).
    const getPath = (f) => window.xleth?.getDroppedFilePath?.(f) || f.path || f.name
    const audioFiles = files.filter((f) => DROPPABLE_AUDIO_EXT.test(f.name))
    if (audioFiles.length === 0) {
      console.log('[SampleSandbox] Drop ignored — no supported audio files')
      return
    }
    for (const f of audioFiles) {
      const path = getPath(f)
      if (path) addSourceFromFile(path, f.name.replace(/\.[^.]+$/, ''))
    }
  }, [addSourceFromRegion, addSourceFromFile])

  return { dragOver, handlers: { onDragOver, onDragLeave, onDrop } }
}
