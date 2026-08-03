export function buildMixerFolderLayout(trackLayout, tracksById = {}) {
  const folders = new Map((trackLayout?.folders ?? []).map(folder => [folder.id, folder]))
  const items = []
  for (const item of trackLayout?.rootOrder ?? []) {
    if (item.kind === 'track' && tracksById[item.id]) {
      items.push({ kind: 'track', id: item.id })
    } else if (item.kind === 'folder') {
      const folder = folders.get(item.id)
      const trackIds = (folder?.trackIds ?? []).filter(id => tracksById[id])
      if (folder && trackIds.length > 0) items.push({ kind: 'folder', folder, trackIds })
    }
  }
  return { items, hasFolderHeaders: items.some(item => item.kind === 'folder') }
}
