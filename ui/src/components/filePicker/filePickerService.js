let activeOpener = null

export function setFilePickerOpener(opener) {
  activeOpener = typeof opener === 'function' ? opener : null
  return () => {
    if (activeOpener === opener) activeOpener = null
  }
}

export function normalizeLegacyPickerResult(value, options = {}) {
  if (!value) return { canceled: true }
  if (Array.isArray(value)) {
    return value.length > 0
      ? { canceled: false, path: value[0], paths: value }
      : { canceled: true }
  }
  if (typeof value === 'string') {
    return { canceled: false, path: value, paths: [value] }
  }
  if (value.canceled || value.cancelled) return { canceled: true }
  const paths = Array.isArray(value.paths)
    ? value.paths
    : Array.isArray(value.filePaths)
      ? value.filePaths
      : value.path
        ? [value.path]
        : value.filePath
          ? [value.filePath]
          : []
  if (paths.length === 0) return { canceled: true }
  return {
    canceled: false,
    path: paths[0],
    paths: options.mode === 'openFiles' ? paths : [paths[0]],
  }
}

export async function openFilePicker(options = {}) {
  if (activeOpener) return activeOpener(options)
  if (typeof options.legacyPicker === 'function') {
    return { ...normalizeLegacyPickerResult(await options.legacyPicker(), options), legacy: true }
  }
  return { canceled: true, unavailable: true }
}

export function getPickerPath(result) {
  return result && !result.canceled ? result.path || result.paths?.[0] || null : null
}

export function getPickerPaths(result) {
  if (!result || result.canceled) return []
  return Array.isArray(result.paths) ? result.paths : result.path ? [result.path] : []
}
