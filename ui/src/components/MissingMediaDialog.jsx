import React, { useEffect, useState } from 'react'
import { getPickerPath, openFilePicker } from './filePicker/filePickerService.js'
import { AUDIO_EXTENSIONS, dirname, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from './filePicker/filePickerHelpers.js'
import { Button, Dialog, DialogList, DialogListItem, DialogText } from '../ui-kit'

const MEDIA_FILTERS = [
  { name: 'Media Files', extensions: [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...IMAGE_EXTENSIONS] },
  { name: 'Video Files', extensions: VIDEO_EXTENSIONS },
  { name: 'Audio Files', extensions: AUDIO_EXTENSIONS },
  { name: 'All Files', extensions: ['*'] },
]

function itemKey(item, index) {
  return `${item?.sourceId ?? '_'}:${item?.regionId ?? '_'}:${item?.filePath ?? index}`
}

function displayPath(item) {
  return item?.filePath || item?.path || ''
}

async function relinkMissingItem(item, filePath) {
  const project = window.xleth?.project
  if (!project) throw new Error('Project bridge unavailable.')
  if (item.regionId != null && ['swappedAudio', 'audio', 'regionAudio'].includes(item.kind)) {
    if (typeof project.relinkRegionAudio !== 'function') throw new Error('Region relink API unavailable.')
    return project.relinkRegionAudio(item.regionId, filePath)
  }
  if (item.sourceId != null) {
    if (typeof project.relinkSource !== 'function') throw new Error('Source relink API unavailable.')
    return project.relinkSource(item.sourceId, await project.prepareImport(filePath))
  }
  if (item.regionId != null) {
    if (typeof project.relinkRegionAudio !== 'function') throw new Error('Region relink API unavailable.')
    return project.relinkRegionAudio(item.regionId, filePath)
  }
  throw new Error('This missing media item has no source or region id.')
}

export default function MissingMediaDialog({ media, onClose }) {
  const [items, setItems] = useState([])
  const [busyKey, setBusyKey] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    setItems((media || []).map((item, index) => ({ ...item, __key: itemKey(item, index) })))
    setMessage('')
  }, [media])

  if (!items || items.length === 0) return null

  const relink = async (item) => {
    setMessage('')
    const picked = await openFilePicker({
      mode: 'openFile',
      title: 'Relink Missing Media',
      subtitle: item.displayName || displayPath(item) || 'Choose the replacement media file.',
      actionLabel: 'Relink',
      initialDirectory: dirname(displayPath(item)),
      filters: MEDIA_FILTERS,
      legacyPicker: () => window.xleth?.project?.openImportDialog?.(),
    })
    const filePath = getPickerPath(picked)
    if (!filePath) return

    setBusyKey(item.__key)
    try {
      await relinkMissingItem(item, filePath)
      setItems(prev => {
        const next = prev.filter(entry => entry.__key !== item.__key)
        if (next.length === 0) queueMicrotask(() => onClose?.())
        return next
      })
      setMessage(`Relinked ${item.displayName || filePath}.`)
    } catch (err) {
      setMessage(`Relink failed: ${err?.message || err}`)
    } finally {
      setBusyKey('')
    }
  }

  return (
    <Dialog
      title={`Missing media (${items.length})`}
      width="lg"
      onClose={onClose}
      actions={<Button size="lg" onClick={onClose}>Ignore all</Button>}
    >
      <DialogText>Relink each file or ignore the list for now.</DialogText>

      <DialogList label="Missing media files">
        {items.map((item) => (
          <DialogListItem
            key={item.__key}
            label={item.displayName || displayPath(item) || 'Missing media'}
            detail={item.error ? `${displayPath(item)} — ${item.error}` : displayPath(item)}
          >
            <Button size="sm" onClick={() => relink(item)} disabled={busyKey === item.__key}>
              {busyKey === item.__key ? 'Relinking…' : 'Relink'}
            </Button>
          </DialogListItem>
        ))}
      </DialogList>

      {message && <div role="status"><DialogText tone="secondary">{message}</DialogText></div>}
    </Dialog>
  )
}
