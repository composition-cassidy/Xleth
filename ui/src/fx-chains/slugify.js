// Filesystem-safe slug for an FX chain name.
//
// Kept byte-for-byte in step with slugifyChainName in
// ui/electron-main/fx-chains.js. THAT one is authoritative — it names the file.
// This copy exists so the renderer can predict the slug (to detect an overwrite
// and to select the freshly saved entry) without a round trip.

const RESERVED_WIN_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

export function slugifyChainName(name) {
  const base = String(name == null ? '' : name)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  let slug = base || 'chain'
  if (RESERVED_WIN_NAMES.has(slug)) slug = '_' + slug
  return slug
}

export default slugifyChainName
