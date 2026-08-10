// Filesystem-safe slug of a preset's display name.
//
// Kept byte-for-byte in step with slugifyPresetName() in
// ui/electron-main/fx-presets.js. That copy is authoritative — it names the file
// on disk. This one lets the renderer preview the slug (e.g. "does a preset with
// this name already exist?") and is what the vitest slug tests exercise.
//
// Every run of non-alphanumeric collapses to a single dash and both ends are
// trimmed, so the output can never contain a reserved Windows character, a path
// separator, a traversal token, or a leading/trailing dot or space.

const RESERVED_WIN_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

export function slugifyPresetName(name) {
  const base = String(name == null ? '' : name)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  let slug = base || 'preset'
  if (RESERVED_WIN_NAMES.has(slug)) slug = '_' + slug
  return slug
}

// Same acceptance set the main-process store enforces for slugs it receives.
export function isSlugSafe(slug) {
  return typeof slug === 'string'
    && /^[a-z0-9_][a-z0-9_-]*$/.test(slug)
    && slug.length <= 80
}
