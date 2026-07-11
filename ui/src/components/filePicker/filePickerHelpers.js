export const AUDIO_EXTENSIONS = ['wav', 'mp3', 'flac', 'ogg', 'aac', 'm4a']
export const VIDEO_EXTENSIONS = ['mp4', 'avi', 'mov', 'mkv', 'webm', 'wmv']
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp']

export function normalizeSlashes(value) {
  return String(value || '').replace(/\//g, '\\')
}

export function basename(filePath) {
  const text = String(filePath || '').replace(/[\\/]+$/, '')
  const parts = text.split(/[\\/]/)
  return parts[parts.length - 1] || text
}

export function dirname(filePath) {
  const text = String(filePath || '')
  if (!text) return ''
  const normalized = text.replace(/[\\/]+$/, '')
  if (/^[a-zA-Z]:$/.test(normalized)) return `${normalized}\\`
  if (/^[a-zA-Z]:\\?$/.test(normalized)) return normalized.slice(0, 2) + '\\'
  const index = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'))
  if (index < 0) return ''
  if (index === 2 && /^[a-zA-Z]:/.test(normalized)) return normalized.slice(0, 3)
  if (index === 0) return normalized.slice(0, 1)
  return normalized.slice(0, index)
}

export function joinPath(parent, child) {
  const base = String(parent || '')
  const name = String(child || '')
  if (!base) return name
  if (!name) return base
  if (/[\\/]$/.test(base)) return `${base}${name}`
  return `${base}\\${name}`
}

export function extensionOf(filePath) {
  const name = basename(filePath)
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index + 1).toLowerCase() : ''
}

export function normalizeFilterExtensions(filters) {
  if (!Array.isArray(filters)) return []
  const out = []
  for (const filter of filters) {
    if (!filter || !Array.isArray(filter.extensions)) continue
    for (const ext of filter.extensions) {
      const clean = String(ext || '').replace(/^\./, '').toLowerCase()
      if (clean) out.push(clean)
    }
  }
  return Array.from(new Set(out))
}

export function fileMatchesFilters(entryOrPath, filters) {
  const extensions = normalizeFilterExtensions(filters)
  if (extensions.length === 0 || extensions.includes('*')) return true
  const isDirectory = typeof entryOrPath === 'object' && entryOrPath?.isDirectory
  if (isDirectory) return true
  const ext = extensionOf(typeof entryOrPath === 'string' ? entryOrPath : entryOrPath?.path || entryOrPath?.name)
  return extensions.includes(ext)
}

export function preferredExtension(filters, defaultExtension = '') {
  const cleanDefault = String(defaultExtension || '').replace(/^\./, '').toLowerCase()
  if (cleanDefault) return cleanDefault
  return normalizeFilterExtensions(filters).find(ext => ext !== '*') || ''
}

export function ensureSaveExtension(filePath, filters, defaultExtension = '') {
  const ext = extensionOf(filePath)
  const allowed = normalizeFilterExtensions(filters).filter(item => item !== '*')
  if (ext && (allowed.length === 0 || allowed.includes(ext))) return filePath
  const preferred = preferredExtension(filters, defaultExtension)
  if (!preferred) return filePath
  return `${filePath}.${preferred}`
}

export function formatFileSize(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  const digits = unit === 0 || size >= 10 ? 0 : 1
  const text = size.toFixed(digits).replace(/\.0$/, '')
  return `${text} ${units[unit]}`
}

export function formatDuration(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value < 0) return ''
  const total = Math.round(value)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')} sec`
}

export function formatLength(entry, durationSeconds) {
  if (!entry || entry.isDirectory) return ''
  if (durationSeconds != null) return formatDuration(durationSeconds)
  return formatFileSize(entry.size)
}

export function samePath(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase()
}

export function uniqueParentDirectories(items) {
  const seen = new Set()
  const out = []
  for (const item of Array.isArray(items) ? items : []) {
    const dir = dirname(item?.filePath || item?.path || '')
    if (!dir) continue
    const key = dir.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ label: basename(dir) || dir, path: dir })
  }
  return out
}
