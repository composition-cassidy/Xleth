export function flatTrackLayout(tracks = []) {
  return {
    rootOrder: tracks.map(track => ({ kind: 'track', id: track.id })),
    folders: [],
  }
}

export function normalizeTrackLayout(layout, tracks = []) {
  if (!layout || !Array.isArray(layout.rootOrder) || !Array.isArray(layout.folders)) {
    return flatTrackLayout(tracks)
  }
  const trackIds = new Set(tracks.map(track => track.id))
  const folders = new Map()
  for (const folder of layout.folders) {
    if (!folder || folders.has(folder.id) || typeof folder.name !== 'string'
      || !folder.name.trim() || !Array.isArray(folder.trackIds)) return flatTrackLayout(tracks)
    folders.set(folder.id, {
      id: folder.id,
      name: folder.name,
      collapsed: folder.collapsed === true,
      trackIds: [...folder.trackIds],
    })
  }
  const seenTracks = new Set()
  const seenFolders = new Set()
  for (const item of layout.rootOrder) {
    if (!item || (item.kind !== 'track' && item.kind !== 'folder')) return flatTrackLayout(tracks)
    if (item.kind === 'track') {
      if (!trackIds.has(item.id) || seenTracks.has(item.id)) return flatTrackLayout(tracks)
      seenTracks.add(item.id)
    } else {
      const folder = folders.get(item.id)
      if (!folder || seenFolders.has(item.id)) return flatTrackLayout(tracks)
      seenFolders.add(item.id)
      for (const trackId of folder.trackIds) {
        if (!trackIds.has(trackId) || seenTracks.has(trackId)) return flatTrackLayout(tracks)
        seenTracks.add(trackId)
      }
    }
  }
  if (seenTracks.size !== trackIds.size || seenFolders.size !== folders.size) {
    return flatTrackLayout(tracks)
  }
  return {
    rootOrder: layout.rootOrder.map(item => ({ kind: item.kind, id: item.id })),
    folders: [...folders.values()],
  }
}

export function folderMapForLayout(layout) {
  return new Map((layout?.folders ?? []).map(folder => [folder.id, folder]))
}

export function trackMapForList(tracks = []) {
  return new Map(tracks.map(track => [track.id, track]))
}

export function flattenTrackIds(layout) {
  const folders = folderMapForLayout(layout)
  const ids = []
  for (const item of layout?.rootOrder ?? []) {
    if (item.kind === 'track') ids.push(item.id)
    else ids.push(...(folders.get(item.id)?.trackIds ?? []))
  }
  return ids
}

export function visibleTracksForLayout(layout, tracks = []) {
  const byId = trackMapForList(tracks)
  const folders = folderMapForLayout(layout)
  const out = []
  for (const item of layout?.rootOrder ?? []) {
    if (item.kind === 'track') {
      const track = byId.get(item.id)
      if (track) out.push(track)
      continue
    }
    const folder = folders.get(item.id)
    if (!folder || folder.collapsed) continue
    for (const trackId of folder.trackIds) {
      const track = byId.get(trackId)
      if (track) out.push(track)
    }
  }
  return out
}

export function nextFolderName(folders = []) {
  const used = new Set(folders.map(folder => folder.name))
  let number = 1
  while (used.has(`Folder ${number}`)) number += 1
  return `Folder ${number}`
}

export function rootIndexForSelectedTracks(layout, selectedTrackIds) {
  const selected = selectedTrackIds instanceof Set ? selectedTrackIds : new Set(selectedTrackIds ?? [])
  const folders = folderMapForLayout(layout)
  for (let index = 0; index < (layout?.rootOrder?.length ?? 0); index += 1) {
    const item = layout.rootOrder[index]
    if (item.kind === 'track' && selected.has(item.id)) return index
    if (item.kind === 'folder'
      && (folders.get(item.id)?.trackIds ?? []).some(trackId => selected.has(trackId))) return index
  }
  return layout?.rootOrder?.length ?? 0
}

export function updateTrackSelection({
  selectedTrackIds,
  visibleTrackIds,
  trackId,
  anchorTrackId = null,
  toggle = false,
  range = false,
}) {
  const selected = selectedTrackIds instanceof Set ? selectedTrackIds : new Set(selectedTrackIds ?? [])
  const visible = Array.isArray(visibleTrackIds) ? visibleTrackIds : []
  const index = visible.indexOf(trackId)
  if (range && anchorTrackId != null) {
    const anchor = visible.indexOf(anchorTrackId)
    if (anchor >= 0 && index >= 0) {
      const [start, end] = anchor < index ? [anchor, index] : [index, anchor]
      return { selectedTrackIds: new Set(visible.slice(start, end + 1)), anchorTrackId }
    }
  }
  if (toggle) {
    const next = new Set(selected)
    if (next.has(trackId)) next.delete(trackId)
    else next.add(trackId)
    return { selectedTrackIds: next, anchorTrackId: trackId }
  }
  return { selectedTrackIds: new Set([trackId]), anchorTrackId: trackId }
}

export function moveTracksInLayout(layout, trackIds, target) {
  const moved = new Set(trackIds)
  const next = {
    rootOrder: layout.rootOrder.map(item => ({ ...item })),
    folders: layout.folders.map(folder => ({ ...folder, trackIds: [...folder.trackIds] })),
  }
  const folders = folderMapForLayout(next)
  const removedRootBefore = target.kind === 'root'
    ? next.rootOrder.slice(0, target.index ?? next.rootOrder.length)
      .filter(item => item.kind === 'track' && moved.has(item.id)).length
    : 0
  let removedMembersBefore = 0
  if (target.kind === 'folder') {
    const targetFolder = folders.get(target.folderId)
    removedMembersBefore = (targetFolder?.trackIds ?? [])
      .slice(0, target.index ?? targetFolder?.trackIds?.length ?? 0)
      .filter(id => moved.has(id)).length
  }
  next.rootOrder = next.rootOrder.filter(item => item.kind !== 'track' || !moved.has(item.id))
  for (const folder of next.folders) folder.trackIds = folder.trackIds.filter(id => !moved.has(id))

  if (target.kind === 'folder') {
    const folder = folders.get(target.folderId)
    if (!folder) return layout
    const requested = (target.index ?? folder.trackIds.length) - removedMembersBefore
    const index = Math.max(0, Math.min(requested, folder.trackIds.length))
    folder.trackIds.splice(index, 0, ...trackIds)
  } else {
    const requested = (target.index ?? next.rootOrder.length) - removedRootBefore
    const index = Math.max(0, Math.min(requested, next.rootOrder.length))
    next.rootOrder.splice(index, 0, ...trackIds.map(id => ({ kind: 'track', id })))
  }
  return next
}

export function moveFolderInLayout(layout, folderId, targetRootIndex) {
  const next = {
    rootOrder: layout.rootOrder.map(item => ({ ...item })),
    folders: layout.folders.map(folder => ({ ...folder, trackIds: [...folder.trackIds] })),
  }
  const source = next.rootOrder.findIndex(item => item.kind === 'folder' && item.id === folderId)
  if (source < 0) return layout
  const [item] = next.rootOrder.splice(source, 1)
  const requested = source < targetRootIndex ? targetRootIndex - 1 : targetRootIndex
  const index = Math.max(0, Math.min(requested, next.rootOrder.length))
  next.rootOrder.splice(index, 0, item)
  return next
}
