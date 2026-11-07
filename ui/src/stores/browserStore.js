import { create } from 'zustand'

// Renderer-only Browser state: which tab is showing (so the collapsed rail can
// open the drawer straight onto one), whether selecting a row previews it, and
// the recent searches per tab. Per-viewer conveniences, so they live in
// localStorage and the Browser works without it.

const AUTO_PREVIEW_KEY = 'xleth-browser-auto-preview'
const HISTORY_KEY = 'xleth-browser-search-history'
export const HISTORY_LIMIT = 8

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw == null ? fallback : JSON.parse(raw)
  } catch {
    return fallback
  }
}

function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* private window: stay in memory */ }
}

function loadHistory() {
  const saved = readJson(HISTORY_KEY, null)
  const clean = (list) => (Array.isArray(list) ? list.filter((q) => typeof q === 'string').slice(0, HISTORY_LIMIT) : [])
  return { media: clean(saved?.media), samples: clean(saved?.samples) }
}

const useBrowserStore = create((set, get) => ({
  tab: 'media',
  autoPreview: readJson(AUTO_PREVIEW_KEY, true) !== false,
  history: loadHistory(),

  setTab: (tab) => {
    if (tab !== 'media' && tab !== 'samples') return
    set({ tab })
    console.log(`[Browser] Tab → ${tab}`)
  },

  setAutoPreview: (value) => {
    set({ autoPreview: !!value })
    writeJson(AUTO_PREVIEW_KEY, !!value)
    console.log(`[Browser] Auto-preview → ${value ? 'on' : 'off'}`)
  },

  /** Remember a committed search, most recent first, no duplicates. */
  pushHistory: (tab, query) => {
    const q = String(query ?? '').trim()
    if (!q) return
    const history = get().history
    const next = { ...history, [tab]: [q, ...history[tab].filter((x) => x !== q)].slice(0, HISTORY_LIMIT) }
    set({ history: next })
    writeJson(HISTORY_KEY, next)
  },

  clearHistory: (tab) => {
    const next = { ...get().history, [tab]: [] }
    set({ history: next })
    writeJson(HISTORY_KEY, next)
  },
}))

export default useBrowserStore
