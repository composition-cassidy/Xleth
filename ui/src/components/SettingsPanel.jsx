import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Film, Image as ImageIcon, RefreshCw, X } from 'lucide-react'
import {
  GLOBAL_STRETCH_METHOD_OPTIONS,
  sanitizeGlobalStretchMethod,
} from '../constants/globalStretchMethods.js'
import AudioPerformanceDiagnosticsPanel from './debug/AudioPerformanceDiagnosticsPanel.jsx'
import XlethSelect from './common/XlethSelect.jsx'
import VstBrowser from './mixer/VstBrowser.jsx'
import ShortcutsSection from './settings/ShortcutsSection.jsx'
import LogsSection from './settings/LogsSection.jsx'
import { ThemeContext } from '../theming/runtime/ThemeProvider'
import { resolveTheme, writeThemeToRoot } from '../theming/runtime/applyTheme'
import {
  APPEARANCE_THEME_SLUG,
  DEFAULT_APPEARANCE_ACCENT,
  DEFAULT_APPEARANCE_CONTRAST,
  DEFAULT_APPEARANCE_DARKNESS,
  DEFAULT_APPEARANCE_HUE,
  DEFAULT_APPEARANCE_SATURATION,
  buildAppearanceTheme,
  normalizeAccentHex,
} from '../theming/runtime/appearanceTheme'
import {
  BACKDROP_FX_PRESETS,
  BACKDROP_FX_QUALITIES,
  useBackdropFxSettingsStore,
} from '../backdrop/backdropFxSettings.js'
import { useQuickLaunchersStore } from '../stores/quickLaunchersStore.js'
import {
  useClipVideoFxDefaultsStore,
} from '../stores/clipVideoFxDefaultsStore.js'
import { clipHasVideo, planClipVideoFxApply } from './timeline/clipVideoFxApply.js'
import { timelineEvents } from '../timelineEvents.js'
import {
  BACKDROP_MEDIA_SOURCE_TYPES,
  backdropMediaFromBackdropState,
  useBackdropMediaSettingsStore,
} from '../backdrop/backdropMediaSettings.js'
import { getPickerPath, openFilePicker } from './filePicker/filePickerService.js'
import { IMAGE_EXTENSIONS } from './filePicker/filePickerHelpers.js'

const VALID_NAMING_FORMATS = ['sampleNameOnly', 'categoryAndName', 'sourceAndName', 'fullLegacy']

const FALLBACK_AUDIO_BUFFER_SIZES = [128, 256, 512, 1024, 2048]

// Output device, buffer size and sample rate are all hardware properties of
// this machine, not of the project — persisted through the same generic
// settings store other per-machine prefs on this panel use (xleth-settings.json),
// never into project.json. main.js's applyEngineDefaults() restores all three
// from this same store before the window is ever shown, so by the time this
// panel is opened the engine is already running with the saved config — this
// panel only needs to save on change, never re-apply on mount.
const SETTINGS_KEY_AUDIO_DEVICE = 'audioOutputDevice'
const SETTINGS_KEY_AUDIO_BUFFER = 'audioBufferSize'
const SETTINGS_KEY_AUDIO_RATE   = 'audioSampleRate'

// ─── Shell structure: two tabs, each with its own short sub-nav ─────────────
//
// The split is by WHAT A SETTING BELONGS TO, which is also what determines
// whether it travels: Project settings are saved into the project and move
// with it, Application settings are this installation's and stay behind. A
// flat list of nine peers could not say that, and it left single-row pages
// (Transport's one dropdown, Advanced's one dropdown) looking like whole
// topics — both are now sections inside Project, where they are read in the
// context they actually apply to.
export const SETTINGS_TABS = [
  { id: 'project', label: 'Project', summary: 'Settings saved with this project.' },
  { id: 'application', label: 'Application', summary: 'Settings for this installation of XLETH.' },
]

export const SETTINGS_CATEGORIES = [
  { id: 'project', tab: 'project', label: 'General', summary: 'Clip handling, playback and safety defaults' },
  { id: 'clipfx', tab: 'project', label: 'Clip FX', summary: 'Default Vibrato and Scratch video companion FX' },
  { id: 'audio', tab: 'application', label: 'Audio', summary: 'Output device, buffer size, and realtime diagnostics' },
  { id: 'plugins', tab: 'application', label: 'Plugins', summary: 'Scan and manage VST3 plugins' },
  { id: 'graphics', tab: 'application', label: 'Graphics', summary: 'GPU and preview diagnostics' },
  { id: 'appearance', tab: 'application', label: 'Appearance', summary: 'Accent color, brightness, and workspace backdrop' },
  { id: 'shortcuts', tab: 'application', label: 'Shortcuts', summary: 'View and customise keyboard shortcuts' },
  { id: 'launchers', tab: 'application', label: 'Launchers', summary: 'Quick-launch external tools from the toolbar' },
  { id: 'logs', tab: 'application', label: 'Logs', summary: 'Export this session\'s console log' },
]

// Categories that used to be their own page. Kept so an existing deep link
// (or a persisted "last open category") still lands somewhere sensible
// instead of silently falling back to the first page.
const MERGED_CATEGORY_ALIASES = {
  transport: 'project',
  advanced: 'project',
}

const AUTOSAVE_OPTIONS = [
  { value: 0, label: 'Off' },
  { value: 1, label: '1 min' },
  { value: 5, label: '5 min' },
  { value: 15, label: '15 min' },
  { value: 30, label: '30 min' },
]

const SPACEBAR_OPTIONS = [
  { value: 'play-pause', label: 'Play / Pause' },
  { value: 'play-stop', label: 'Play / Stop' },
]

const VIDEO_MODE_OPTIONS = [
  { value: 'auto', label: 'Auto (recommended)' },
  { value: 'software', label: 'Software' },
  { value: 'hardware', label: 'Hardware only' },
]

// Preview-proxy codec (engine ProxyCodec). Persisted in app settings as
// 'proxyCodec' and pushed to the engine at startup (main.js applyEngineDefaults).
const PROXY_CODEC_OPTIONS = [
  { value: 'h264', label: 'H.264 (recommended)' },
  { value: 'intra', label: 'All-intra (DNxHR / MJPEG): high quality' },
]

const NAMING_FORMAT_OPTIONS = [
  { value: 'sampleNameOnly', label: 'Sample name only' },
  { value: 'categoryAndName', label: 'Category + sample name' },
  { value: 'sourceAndName', label: 'Source + sample name' },
  { value: 'fullLegacy', label: 'Full legacy' },
]

function getXleth() {
  return typeof window !== 'undefined' ? window.xleth : undefined
}

function getInitialBackdropState() {
  const current = getXleth()?.backdrop?.current
  return current || { capability: null, preference: 'acrylic', mode: 'off' }
}

function normalizeBackdropPreference(value) {
  return ['off', 'acrylic', 'image'].includes(value) ? value : 'acrylic'
}

function normalizeCategory(category) {
  if (SETTINGS_CATEGORIES.some(item => item.id === category)) return category
  return MERGED_CATEGORY_ALIASES[category] || 'project'
}

function tabForCategory(category) {
  return SETTINGS_CATEGORIES.find(item => item.id === category)?.tab || 'project'
}

// PROXY context only. This creates a fresh off-screen WebGL context inside
// Settings. The authoritative WebGL info still comes from VideoPreview's
// window.__xlethVisualPreviewDiag.
function collectProxyWebGLInfo() {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 4
    canvas.height = 4
    const gl = canvas.getContext('webgl', { failIfMajorPerformanceCaveat: false })
      || canvas.getContext('experimental-webgl')
    if (!gl) return { error: 'getContext returned null in SettingsPanel probe' }
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    return {
      vendor: gl.getParameter(gl.VENDOR),
      renderer: gl.getParameter(gl.RENDERER),
      version: gl.getParameter(gl.VERSION),
      glsl: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
      unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      extensions: gl.getSupportedExtensions() || [],
    }
  } catch (e) {
    return { error: String(e && e.message || e) }
  }
}

function snapshotPreviewDiag() {
  const live = typeof window !== 'undefined' ? window.__xlethVisualPreviewDiag : null
  if (!live) return null
  return {
    mode: live.mode,
    drawApi: live.drawApi,
    lastTickAction: live.lastTickAction,
    lastTickAtMsAgo: live.lastTickAt > 0
      ? Math.round(performance.now() - live.lastTickAt)
      : null,
    shm: { ...live.shm },
    texUploadSuccess: live.texUploadSuccess,
    texUploadFailures: live.texUploadFailures,
    lastTexUploadError: live.lastTexUploadError,
    contextLostCount: live.contextLostCount,
    contextRestoredCount: live.contextRestoredCount,
    clearColorRgb: live.clearColorRgb ? [...live.clearColorRgb] : null,
    // Opt-in pixel-content verification (renderer stages). Shallow-cloned so the
    // IPC structured-clone to main does not carry live references.
    pixelDiagEnabled: !!live.pixelDiagEnabled,
    glErrorAfterUpload: live.glErrorAfterUpload,
    glErrorAfterDraw: live.glErrorAfterDraw,
    pixelStats: live.pixelStats ? JSON.parse(JSON.stringify(live.pixelStats)) : {},
    webgl: live.webgl ? {
      ...live.webgl,
      extensions: Array.isArray(live.webgl.extensions)
        ? [...live.webgl.extensions]
        : null,
    } : null,
  }
}

function SettingsSection({ title, children, index = 0, className = '' }) {
  return (
    <section
      className={`settings-panel-section ${className}`.trim()}
      style={{ '--settings-card-index': index }}
    >
      <div className="settings-panel-section-title">{title}</div>
      {children}
    </section>
  )
}

function SettingsRow({ label, htmlFor, description, children }) {
  return (
    <div className="settings-panel-row">
      <div className="settings-panel-row-copy">
        {htmlFor ? (
          <label className="settings-panel-label" htmlFor={htmlFor}>{label}</label>
        ) : (
          <div className="settings-panel-label">{label}</div>
        )}
        {description && <div className="settings-panel-field-copy">{description}</div>}
      </div>
      <div className="settings-panel-control">
        {children}
      </div>
    </div>
  )
}

export default function SettingsPanel({ onClose, initialCategory = 'project' }) {
  const backdropVideoInputRef = useRef(null)
  const themeContext = useContext(ThemeContext)
  const appearanceAppliedRef = useRef(null)
  const appearancePersistTimerRef = useRef(null)
  const [accentColor, setAccentColor] = useState(DEFAULT_APPEARANCE_ACCENT)
  const [brightness, setBrightness] = useState(DEFAULT_APPEARANCE_DARKNESS)
  const [chromeHue, setChromeHue] = useState(DEFAULT_APPEARANCE_HUE)
  const [chromeSaturation, setChromeSaturation] = useState(DEFAULT_APPEARANCE_SATURATION)
  const [textContrast, setTextContrast] = useState(DEFAULT_APPEARANCE_CONTRAST)
  const [activeCategory, setActiveCategory] = useState(() => normalizeCategory(initialCategory))
  const [projectStretchMethod, setProjectStretchMethod] = useState(null)
  const [defaultStretchMethod, setDefaultStretchMethod] = useState(null)
  const [formantPreserve, setFormantPreserve] = useState(false)
  const [spacebarMode, setSpacebarMode] = useState('play-pause')
  const [autosaveInterval, setAutosaveInterval] = useState(5)
  const [gpuStatus, setGpuStatus] = useState({ state: 'loading', adapters: [] })
  const [hwEncoderStatus, setHwEncoderStatus] = useState({ state: 'loading', encoders: [] })
  const [videoMode, setVideoMode] = useState('auto')
  const [proxyCodec, setProxyCodec] = useState('h264')
  // Engine-reported state: { requested, effective, h264Available } or null.
  const [proxyCodecState, setProxyCodecState] = useState(null)
  // "Delete regenerable files when closing a project" — default off. `error` is set
  // when the engine did not confirm the value (the bridge call is optional-chained
  // everywhere, so a missing call would otherwise leave UI and engine disagreeing).
  const [purgeOnClose, setPurgeOnClose] = useState(false)
  const [purgeOnCloseError, setPurgeOnCloseError] = useState('')
  const [diagState, setDiagState] = useState({ status: 'idle', message: '', path: '' })
  const [namingFormat, setNamingFormat] = useState('sampleNameOnly')
  const [audioDevices, setAudioDevices] = useState([])
  const [audioSelectedDevice, setAudioSelectedDevice] = useState('')
  const [audioRescanning, setAudioRescanning] = useState(false)
  const [audioSampleRates, setAudioSampleRates] = useState([])
  const [audioBufferSizes, setAudioBufferSizes] = useState(FALLBACK_AUDIO_BUFFER_SIZES)
  const [audioDefaultBufferSize, setAudioDefaultBufferSize] = useState(null)
  const [audioBufferSize, setAudioBufferSizeState] = useState(null)
  const [audioSampleRate, setAudioSampleRateState] = useState(null)
  const [backdropState, setBackdropState] = useState(getInitialBackdropState)
  const backdropFxSettings = useBackdropFxSettingsStore((state) => state.settings)
  const hydrateBackdropFxSettings = useBackdropFxSettingsStore((state) => state.hydrate)
  const setBackdropFxSettings = useBackdropFxSettingsStore((state) => state.setSettings)
  const backdropMediaSettings = useBackdropMediaSettingsStore((state) => state.settings)
  const hydrateBackdropMediaSettings = useBackdropMediaSettingsStore((state) => state.hydrate)
  const setBackdropMediaSettings = useBackdropMediaSettingsStore((state) => state.setSettings)
  const syncBackdropMediaFromState = useBackdropMediaSettingsStore((state) => state.syncFromBackdropState)

  const launchers = useQuickLaunchersStore((s) => s.launchers)
  const hydrateLaunchers = useQuickLaunchersStore((s) => s.hydrate)
  const addLauncher = useQuickLaunchersStore((s) => s.addLauncher)
  const removeLauncher = useQuickLaunchersStore((s) => s.removeLauncher)
  const updateLauncher = useQuickLaunchersStore((s) => s.updateLauncher)
  const [pendingLauncher, setPendingLauncher] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [editDraft, setEditDraft] = useState(null)

  const clipVideoFxDefaults = useClipVideoFxDefaultsStore((s) => s.defaults)
  const hydrateClipVideoFxDefaults = useClipVideoFxDefaultsStore((s) => s.hydrate)
  const setClipVideoFxDefaults = useClipVideoFxDefaultsStore((s) => s.setDefaults)
  // One snapshot of the open project (clips + the region/source maps needed to
  // tell a video clip from an audio-only one), taken when the category opens and
  // refreshed after an apply. The candidate count then recomputes locally as the
  // user drags a slider instead of round-tripping the engine per keystroke.
  const [clipFxProject, setClipFxProject] = useState(null)
  const [clipFxStatus, setClipFxStatus] = useState({ state: 'idle', message: '' })

  useEffect(() => {
    setActiveCategory(normalizeCategory(initialCategory))
  }, [initialCategory])

  useEffect(() => {
    const handler = (event) => {
      if (event.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    if (activeCategory === 'launchers') hydrateLaunchers()
  }, [activeCategory, hydrateLaunchers])

  const refreshAudioDeviceInfo = useCallback(async () => {
    const info = await getXleth()?.audio?.getDeviceInfo?.()
    if (!info) return
    setAudioBufferSizeState(info.bufferSize ?? null)
    setAudioSampleRateState(info.sampleRate ?? null)
    if (Array.isArray(info.bufferSizes) && info.bufferSizes.length > 0)
      setAudioBufferSizes(info.bufferSizes)
    setAudioDefaultBufferSize(typeof info.defaultBufferSize === 'number' ? info.defaultBufferSize : null)
  }, [])

  useEffect(() => {
    if (activeCategory !== 'audio') return
    async function loadAudio() {
      const xl = getXleth()
      const list = await xl?.audio?.getOutputDevices?.() ?? []
      setAudioDevices(list)
      const current = await xl?.audio?.getCurrentOutputDevice?.() ?? ''
      setAudioSelectedDevice(current)
      const rates = await xl?.audio?.getSupportedSampleRates?.() ?? []
      setAudioSampleRates(rates)
      await refreshAudioDeviceInfo()
    }
    loadAudio()
  }, [activeCategory, refreshAudioDeviceInfo])

  useEffect(() => {
    const xl = getXleth()

    xl?.timeline?.getGlobalStretchMethod?.()
      .then(m => setProjectStretchMethod(sanitizeGlobalStretchMethod(m)))
      .catch(() => setProjectStretchMethod(1))

    Promise.all([
      xl?.settings?.get?.('defaultGlobalStretchMethod')?.catch(() => null) ?? Promise.resolve(null),
      xl?.settings?.get?.('globalStretchMethod')?.catch(() => null) ?? Promise.resolve(null),
    ]).then(([preferred, legacy]) => {
      setDefaultStretchMethod(sanitizeGlobalStretchMethod(preferred ?? legacy ?? 1))
    }).catch(() => setDefaultStretchMethod(1))

    xl?.engine?.getGlobalFormantPreserve?.()
      .then(v => setFormantPreserve(!!v))
      .catch(() => {})

    xl?.settings?.get?.('spacebarMode')?.then(v => {
      setSpacebarMode(v === 'play-stop' ? 'play-stop' : 'play-pause')
    }).catch(() => {})

    xl?.settings?.get?.('autosaveInterval')?.then(v => {
      setAutosaveInterval(v != null ? Number(v) : 5)
    }).catch(() => {})

    xl?.settings?.get?.('videoMode')?.then(v => {
      setVideoMode(['auto', 'software', 'hardware'].includes(v) ? v : 'auto')
    }).catch(() => {})

    // The engine is the source of truth for what is actually in effect (it
    // holds the setting pushed at startup); the settings store is only read as
    // a fallback if the engine call is unavailable.
    xl?.proxy?.getCodec?.()?.then(state => {
      if (state && (state.requested === 'h264' || state.requested === 'intra')) {
        setProxyCodec(state.requested)
        setProxyCodecState(state)
      }
    }).catch(() => {
      xl?.settings?.get?.('proxyCodec')?.then(v => {
        if (v === 'h264' || v === 'intra') setProxyCodec(v)
      }).catch(() => {})
    })

    xl?.settings?.get?.('purgeRegenerableOnClose')?.then(v => {
      setPurgeOnClose(v === true)
    }).catch(() => {})

    xl?.settings?.get?.('sampleNamingFormat')?.then(v => {
      if (VALID_NAMING_FORMATS.includes(v)) setNamingFormat(v)
    }).catch(() => {})

    xl?.settings?.get?.('appearanceAccent')?.then(v => {
      if (typeof v === 'string' && v.trim()) setAccentColor(normalizeAccentHex(v))
    }).catch(() => {})

    xl?.settings?.get?.('appearanceDarkness')?.then(v => {
      const n = Number(v)
      if (Number.isFinite(n)) setBrightness(Math.min(100, Math.max(0, n)))
    }).catch(() => {})

    xl?.settings?.get?.('appearanceHue')?.then(v => {
      const n = Number(v)
      if (Number.isFinite(n)) setChromeHue(Math.min(359, Math.max(0, n)))
    }).catch(() => {})

    xl?.settings?.get?.('appearanceSaturation')?.then(v => {
      const n = Number(v)
      if (Number.isFinite(n)) setChromeSaturation(Math.min(300, Math.max(0, n)))
    }).catch(() => {})

    xl?.settings?.get?.('appearanceContrast')?.then(v => {
      const n = Number(v)
      if (Number.isFinite(n)) setTextContrast(Math.min(160, Math.max(60, n)))
    }).catch(() => {})

    if (xl?.gpu?.getAvailableGpus) {
      xl.gpu.getAvailableGpus()
        .then(list => {
          const adapters = Array.isArray(list) ? list : []
          setGpuStatus({
            state: adapters.length > 0 ? 'detected' : 'none',
            adapters,
          })
        })
        .catch(err => {
          console.warn('[Settings] gpu.getAvailableGpus failed:', err?.message || err)
          setGpuStatus({ state: 'error', adapters: [], error: String(err?.message || err) })
        })
    } else {
      setGpuStatus({ state: 'unavailable', adapters: [] })
    }

    if (xl?.video?.getAvailableEncoders) {
      xl.video.getAvailableEncoders('h264')
        .then(list => {
          const encoders = Array.isArray(list) ? list : []
          const hw = encoders.filter(e => e.isHardware && e.isAvailable)
          setHwEncoderStatus({ state: hw.length > 0 ? 'available' : 'none', encoders: hw })
        })
        .catch(err => {
          console.warn('[Settings] video.getAvailableEncoders failed:', err?.message || err)
          setHwEncoderStatus({ state: 'error', encoders: [], error: String(err?.message || err) })
        })
    } else {
      setHwEncoderStatus({ state: 'unavailable', encoders: [] })
    }
  }, [])

  useEffect(() => {
    void hydrateBackdropFxSettings()
  }, [hydrateBackdropFxSettings])

  useEffect(() => {
    void hydrateBackdropMediaSettings()
  }, [hydrateBackdropMediaSettings])

  useEffect(() => {
    const xl = getXleth()
    const applyBackdropState = (state) => {
      if (!state) return
      setBackdropState(state)
      syncBackdropMediaFromState(state)
    }

    applyBackdropState(xl?.backdrop?.current)
    xl?.backdrop?.getState?.()
      .then(applyBackdropState)
      .catch((err) => console.warn('[Settings] backdrop.getState failed:', err?.message || err))

    return xl?.backdrop?.onModeChanged?.(applyBackdropState)
  }, [syncBackdropMediaFromState])

  const activeCategoryDef = useMemo(
    () => SETTINGS_CATEGORIES.find(category => category.id === activeCategory) || SETTINGS_CATEGORIES[0],
    [activeCategory]
  )

  // The tab is derived from the selected category rather than held as its own
  // state. Keeping a second source of truth invites the pair to disagree — a
  // deep link straight to a category, or an alias resolving into the other
  // tab, would otherwise land on a page its own tab strip says is not showing.
  const activeTab = activeCategoryDef.tab
  const activeTabDef = useMemo(
    () => SETTINGS_TABS.find(tab => tab.id === activeTab) || SETTINGS_TABS[0],
    [activeTab]
  )
  const visibleCategories = useMemo(
    () => SETTINGS_CATEGORIES.filter(category => category.tab === activeTab),
    [activeTab]
  )

  // Switching tabs selects that tab's first page, which is what makes the tab
  // itself clickable at all — there is no "tab with nothing selected" state.
  const selectTab = useCallback((tabId) => {
    const first = SETTINGS_CATEGORIES.find(category => category.tab === tabId)
    if (first) setActiveCategory(first.id)
  }, [])

  function formatAdapterLine(a) {
    const vendor = a.vendor || 'Unknown'
    const name = (a.name || '').trim() || '(unnamed)'
    const vram = a.vramMB > 0 ? ` - ${a.vramMB} MB VRAM` : ''
    const venHex = a.vendorId ? `VEN_${a.vendorId.toString(16).toUpperCase().padStart(4, '0')}` : ''
    const devHex = a.deviceId ? ` DEV_${a.deviceId.toString(16).toUpperCase().padStart(4, '0')}` : ''
    const ids = (venHex || devHex) ? ` (${venHex}${devHex})` : ''
    const tags = []
    if (a.isDefault) tags.push('default')
    if (a.isDiscrete !== undefined) tags.push(a.isDiscrete ? 'discrete' : 'integrated')
    const tagStr = tags.length ? ` [${tags.join(', ')}]` : ''
    return `${vendor}: ${name}${vram}${ids}${tagStr}`
  }

  function gpuSummaryText() {
    if (gpuStatus.state === 'loading') return 'Detecting graphics adapters...'
    if (gpuStatus.state === 'unavailable') return 'Graphics adapter detection unavailable in this build.'
    if (gpuStatus.state === 'error') return `Graphics adapter detection failed: ${gpuStatus.error || 'unknown error'}`
    if (gpuStatus.state === 'none' || gpuStatus.adapters.length === 0) {
      return 'No graphics adapters detected - hardware video encode/decode and OpenGL compositor unavailable.'
    }
    const vendors = Array.from(new Set(gpuStatus.adapters.map(a => a.vendor || 'Unknown')))
    const vendorStr = vendors.join(' + ')
    if (hwEncoderStatus.state === 'loading') return `Graphics adapter detected: ${vendorStr} - checking hardware video encoder...`
    if (hwEncoderStatus.state === 'none') {
      return `Graphics adapter detected: ${vendorStr} - no hardware video encoder available, software video encode/decode will be used.`
    }
    if (hwEncoderStatus.state === 'available') {
      const names = hwEncoderStatus.encoders.map(e => e.displayName || e.name).join(', ')
      return `Graphics adapter detected: ${vendorStr} - hardware video encoder available (${names}).`
    }
    return `Graphics adapter detected: ${vendorStr}`
  }

  function gpuSummaryTone() {
    if (gpuStatus.state === 'none' || gpuStatus.state === 'error') return 'warning'
    if (gpuStatus.state === 'detected') {
      if (hwEncoderStatus.state === 'none') return 'warning'
      if (hwEncoderStatus.state === 'available') return 'success'
    }
    return 'default'
  }

  async function applyProjectStretchMethod(m) {
    const method = sanitizeGlobalStretchMethod(m)
    console.log('[UISettings] project globalStretchMethod changed:', method)
    setProjectStretchMethod(method)
    await getXleth()?.timeline?.setGlobalStretchMethod?.(method)
    window.dispatchEvent(new CustomEvent('xleth:globalStretchMethod-changed', {
      detail: { method },
    }))
  }

  async function applyDefaultStretchMethod(m) {
    const method = sanitizeGlobalStretchMethod(m)
    setDefaultStretchMethod(method)
    await getXleth()?.settings?.set?.('defaultGlobalStretchMethod', method)
  }

  async function applyFormant(v) {
    console.log('[UISettings] globalFormantPreserve changed:', v)
    setFormantPreserve(v)
    await getXleth()?.engine?.setGlobalFormantPreserve?.(v)
    await getXleth()?.settings?.set?.('globalFormantPreserve', v)
  }

  async function applySpacebarMode(mode) {
    setSpacebarMode(mode)
    await getXleth()?.settings?.set?.('spacebarMode', mode)
    window.dispatchEvent(new CustomEvent('xleth:spacebarMode-changed', { detail: { mode } }))
  }

  async function applyAutosaveInterval(minutes) {
    setAutosaveInterval(minutes)
    await getXleth()?.settings?.set?.('autosaveInterval', minutes)
    await getXleth()?.autosave?.restart?.()
  }

  async function applyVideoMode(mode) {
    setVideoMode(mode)
    await getXleth()?.settings?.set?.('videoMode', mode)
  }

  async function applyProxyCodec(codec) {
    setProxyCodec(codec)
    const xl = getXleth()
    await xl?.settings?.set?.('proxyCodec', codec)
    try {
      const state = await xl?.proxy?.setCodec?.(codec)
      if (state) setProxyCodecState(state)
    } catch (e) {
      console.error('[SettingsPanel] proxy.setCodec failed:', e)
    }
  }

  async function applyPurgeOnClose(enabled) {
    setPurgeOnClose(enabled)
    setPurgeOnCloseError('')
    const xl = getXleth()
    await xl?.settings?.set?.('purgeRegenerableOnClose', enabled)
    // The engine performs the purge, so it must hold the value too. It echoes the
    // value in force; anything else means the call never landed.
    try {
      if (typeof xl?.project?.setPurgeOnClose !== 'function') {
        throw new Error('window.xleth.project.setPurgeOnClose is not exposed')
      }
      const inForce = await xl.project.setPurgeOnClose(enabled)
      if (inForce !== enabled) throw new Error(`engine reports ${JSON.stringify(inForce)}`)
    } catch (e) {
      console.error('[SettingsPanel] project.setPurgeOnClose failed:', e)
      setPurgeOnCloseError('Could not apply this setting to the engine. Files will not be deleted on close until it is fixed.')
    }
  }

  // ── Clip video-companion FX defaults ──────────────────────────────────────

  const loadClipFxProject = useCallback(async () => {
    const xl = getXleth()
    if (!xl?.timeline?.getClips) { setClipFxProject(null); return null }
    try {
      const [clips, regions, sources] = await Promise.all([
        xl.timeline.getClips(),
        xl.timeline.getRegions(),
        xl.timeline.getSources(),
      ])
      const regionsById = {}
      ;(regions || []).forEach((r) => { regionsById[r.id] = r })
      const sourcesById = {}
      ;(sources || []).forEach((src) => { sourcesById[src.id] = src })
      const next = { clips: clips || [], regionsById, sourcesById }
      setClipFxProject(next)
      return next
    } catch (err) {
      console.warn('[ClipVideoFxDefaults] project snapshot failed:', err?.message || err)
      setClipFxProject(null)
      return null
    }
  }, [])

  // Declared after loadClipFxProject: the dep array is evaluated during render,
  // so a useEffect above the useCallback would hit its temporal dead zone.
  useEffect(() => {
    if (activeCategory !== 'clipfx') return
    hydrateClipVideoFxDefaults()
    loadClipFxProject()
    setClipFxStatus({ state: 'idle', message: '' })
  }, [activeCategory, hydrateClipVideoFxDefaults, loadClipFxProject])

  const clipFxCandidates = useMemo(() => (
    clipFxProject
      ? planClipVideoFxApply({
          clips: clipFxProject.clips,
          regionsById: clipFxProject.regionsById,
          sourcesById: clipFxProject.sourcesById,
          defaults: clipVideoFxDefaults,
        })
      : []
  ), [clipFxProject, clipVideoFxDefaults])

  async function applyClipVideoFxDefault(patch) {
    await setClipVideoFxDefaults(patch)
    // The candidate count is derived, so editing a default never leaves a stale
    // 'applied to N clips' line standing next to a different N.
    setClipFxStatus({ state: 'idle', message: '' })
  }

  async function applyClipVideoFxToProject() {
    const snapshot = await loadClipFxProject()
    if (!snapshot) {
      setClipFxStatus({ state: 'error', message: 'No project is open.' })
      return
    }
    const edits = planClipVideoFxApply({
      clips: snapshot.clips,
      regionsById: snapshot.regionsById,
      sourcesById: snapshot.sourcesById,
      defaults: clipVideoFxDefaults,
    })
    if (edits.length === 0) {
      setClipFxStatus({ state: 'done', message: 'Nothing to apply — every video clip already has it on.' })
      return
    }
    setClipFxStatus({ state: 'applying', message: `Applying to ${edits.length} clip(s)…` })
    try {
      const updated = await getXleth()?.timeline?.setClipModulationBatch?.(edits)
      const count = Array.isArray(updated) ? updated.length : edits.length
      // One batch call is one undo entry; the timeline refetches off this event.
      timelineEvents.dispatchEvent(new CustomEvent('timeline-clips-changed'))
      await loadClipFxProject()
      setClipFxStatus({
        state: 'done',
        message: `Applied to ${count} clip(s). Ctrl+Z undoes the whole sweep.`,
      })
    } catch (err) {
      console.error('[ClipVideoFxDefaults] apply failed:', err)
      setClipFxStatus({ state: 'error', message: err?.message || 'Apply failed.' })
    }
  }


  async function applyBackdropMediaSource(value) {
    const next = ['none', 'acrylic', 'image', 'video'].includes(value) ? value : 'none'
    const settings = await setBackdropMediaSettings({ sourceType: next, lastError: '' })
    setBackdropState(backdropMediaFromBackdropState({
      mode: settings.sourceType === 'none'
        ? 'off'
        : settings.sourceType === 'acrylic'
          ? 'native-acrylic'
          : settings.sourceType,
      preference: settings.sourceType,
      imagePath: settings.imagePath,
      videoPath: settings.videoPath,
      lastError: settings.lastError,
    }, settings))
  }

  async function chooseWorkspaceBackdropImage() {
    try {
      const picked = await openFilePicker({
        mode: 'openFile',
        title: 'Choose Workspace Backdrop',
        subtitle: 'Select a PNG, JPEG, or WebP image for the workspace.',
        actionLabel: 'Use Image',
        filters: [{ name: 'Images', extensions: IMAGE_EXTENSIONS }],
        legacyPicker: async () => {
          const state = await getXleth()?.backdrop?.chooseImage?.()
          return state?.imagePath || null
        },
      })
      const filePath = getPickerPath(picked)
      if (!filePath) return
      const settings = await setBackdropMediaSettings({
        sourceType: 'image',
        imagePath: filePath,
        lastError: '',
      })
      const state = getXleth()?.backdrop?.current || {
        capability: backdropState?.capability || null,
        preference: 'image',
        mode: 'image',
        imagePath: settings.imagePath || filePath,
        imageUrl: null,
        videoPath: settings.videoPath || null,
        videoUrl: null,
        lastError: settings.lastError || null,
      }
      setBackdropState(state)
      syncBackdropMediaFromState(state)
    } catch (err) {
      console.warn('[Settings] workspace backdrop image chooser failed:', err?.message || err)
    }
  }

  async function chooseWorkspaceBackdropVideo() {
    try {
      const picked = await openFilePicker({
        mode: 'openFile',
        title: 'Choose Workspace Background Video',
        subtitle: 'Select an MP4 video loop for the workspace.',
        actionLabel: 'Use Video',
        filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
        legacyPicker: async () => {
          const state = await getXleth()?.backdrop?.chooseVideo?.()
          return state?.videoPath || null
        },
      })
      const filePath = getPickerPath(picked)
      if (filePath) {
        const settings = await setBackdropMediaSettings({
          sourceType: 'video',
          videoPath: filePath,
          lastError: '',
        })
        const state = getXleth()?.backdrop?.current || {
          capability: backdropState?.capability || null,
          preference: 'video',
          mode: 'video',
          imagePath: settings.imagePath || null,
          imageUrl: null,
          videoPath: settings.videoPath || filePath,
          videoUrl: null,
          lastError: settings.lastError || null,
        }
        setBackdropState(state)
        syncBackdropMediaFromState(state)
        return
      }
      if (picked?.unavailable) backdropVideoInputRef.current?.click()
    } catch (err) {
      console.warn('[Settings] workspace backdrop video chooser failed:', err?.message || err)
    }
  }

  async function handleBackdropVideoFileChange(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const xl = getXleth()
    const filePath = xl?.getDroppedFilePath?.(file)
      || xl?.file?.getPathForFile?.(file)
      || ''
    if (!filePath) {
      await setBackdropMediaSettings({
        sourceType: 'video',
        lastError: 'Video backdrop could not be selected. The file path was unavailable.',
      })
      return
    }
    const next = await setBackdropMediaSettings({
      sourceType: 'video',
      videoPath: filePath,
      lastError: '',
    })
    setBackdropState({
      capability: backdropState?.capability || null,
      preference: 'video',
      mode: 'video',
      imagePath: next.imagePath || null,
      imageUrl: null,
      videoPath: next.videoPath || null,
      videoUrl: null,
      lastError: next.lastError || null,
    })
  }

  async function applyNamingFormat(v) {
    const validated = VALID_NAMING_FORMATS.includes(v) ? v : 'sampleNameOnly'
    setNamingFormat(validated)
    await getXleth()?.settings?.set?.('sampleNamingFormat', validated)
  }

  // ── Audio output device / buffer size / sample rate ───────────────────────

  async function applyAudioDeviceChange(name) {
    setAudioSelectedDevice(name)
    const result = await getXleth()?.audio?.setOutputDevice?.(name)
    if (result && !result.ok) {
      console.error('[Settings] audio.setOutputDevice failed:', result.error)
      return
    }
    await getXleth()?.settings?.set?.(SETTINGS_KEY_AUDIO_DEVICE, name)
    // A device switch can change the supported-rate list and the reopened
    // device's actual buffer/rate/latency — refresh everything this section shows.
    const rates = await getXleth()?.audio?.getSupportedSampleRates?.() ?? []
    setAudioSampleRates(rates)
    await refreshAudioDeviceInfo()
  }

  async function applyAudioRescan() {
    if (audioRescanning) return
    setAudioRescanning(true)
    try {
      const list = await getXleth()?.audio?.rescanDevices?.() ?? []
      setAudioDevices(list)
      const current = await getXleth()?.audio?.getCurrentOutputDevice?.() ?? ''
      setAudioSelectedDevice(current)
      const rates = await getXleth()?.audio?.getSupportedSampleRates?.() ?? []
      setAudioSampleRates(rates)
      await refreshAudioDeviceInfo()
    } finally {
      setAudioRescanning(false)
    }
  }

  async function applyAudioBufferSize(value) {
    const size = parseInt(value, 10)
    setAudioBufferSizeState(size) // optimistic — live latency value updates immediately
    const result = await getXleth()?.audio?.setBufferSize?.(size)
    if (result && !result.ok) {
      console.error('[Settings] audio.setBufferSize failed:', result.error)
      await refreshAudioDeviceInfo()
      return
    }
    await getXleth()?.settings?.set?.(SETTINGS_KEY_AUDIO_BUFFER, size)
    await refreshAudioDeviceInfo()
  }

  async function applyAudioSampleRate(value) {
    const rate = parseFloat(value)
    const result = await getXleth()?.audio?.setSampleRate?.(rate)
    if (result && !result.ok) {
      console.error('[Settings] audio.setSampleRate failed:', result.error)
      await refreshAudioDeviceInfo()
      return
    }
    await getXleth()?.settings?.set?.(SETTINGS_KEY_AUDIO_RATE, rate)
    await refreshAudioDeviceInfo()
  }

  function applyBackdropFxSettings(patch) {
    void setBackdropFxSettings(patch)
  }

  const applyAppearance = useCallback((accent, darkness, options = {}) => {
    const file = buildAppearanceTheme(accent, darkness, options)

    // Live apply. Prefer the ThemeProvider so its applied-token tracking stays
    // in sync; fall back to writing :root directly when no provider is mounted
    // (e.g. unit tests rendering SettingsPanel in isolation).
    if (themeContext?.setTheme) {
      void themeContext.setTheme(APPEARANCE_THEME_SLUG, file)
    } else {
      const { values } = resolveTheme(file)
      writeThemeToRoot(values, appearanceAppliedRef.current ?? undefined)
      appearanceAppliedRef.current = values
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('xleth-theme-changed'))
      }
    }

    // Persist (debounced) so the choice survives a reload. The full token file
    // is saved as a user theme and marked active; the raw knobs are stored so
    // the controls reopen at the right positions.
    if (appearancePersistTimerRef.current) clearTimeout(appearancePersistTimerRef.current)
    appearancePersistTimerRef.current = setTimeout(() => {
      const xl = getXleth()
      void xl?.theme?.saveUser?.(APPEARANCE_THEME_SLUG, file)
      void xl?.settings?.set?.('activeTheme', APPEARANCE_THEME_SLUG)
      void xl?.settings?.set?.('appearanceAccent', accent)
      void xl?.settings?.set?.('appearanceDarkness', darkness)
      void xl?.settings?.set?.('appearanceHue', options.hue ?? DEFAULT_APPEARANCE_HUE)
      void xl?.settings?.set?.('appearanceSaturation', options.saturation ?? DEFAULT_APPEARANCE_SATURATION)
      void xl?.settings?.set?.('appearanceContrast', options.contrast ?? DEFAULT_APPEARANCE_CONTRAST)
    }, 400)
  }, [themeContext])

  // Every control feeds the same builder, so each handler passes the full knob
  // set with its own value substituted. Keeps one source of truth for what the
  // theme currently is, rather than four partial update paths.
  const appearanceOptions = useCallback((patch = {}) => ({
    hue: chromeHue,
    saturation: chromeSaturation,
    contrast: textContrast,
    ...patch,
  }), [chromeHue, chromeSaturation, textContrast])

  useEffect(() => () => {
    if (appearancePersistTimerRef.current) clearTimeout(appearancePersistTimerRef.current)
  }, [])

  function handleAccentChange(event) {
    const next = normalizeAccentHex(event.target.value)
    setAccentColor(next)
    applyAppearance(next, brightness, appearanceOptions())
  }

  function handleBrightnessChange(event) {
    const next = Math.min(100, Math.max(0, Number(event.target.value)))
    setBrightness(next)
    applyAppearance(accentColor, next, appearanceOptions())
  }

  function handleChromeHueChange(event) {
    const next = Math.min(359, Math.max(0, Number(event.target.value)))
    setChromeHue(next)
    applyAppearance(accentColor, brightness, appearanceOptions({ hue: next }))
  }

  function handleChromeSaturationChange(event) {
    const next = Math.min(300, Math.max(0, Number(event.target.value)))
    setChromeSaturation(next)
    applyAppearance(accentColor, brightness, appearanceOptions({ saturation: next }))
  }

  function handleTextContrastChange(event) {
    const next = Math.min(160, Math.max(60, Number(event.target.value)))
    setTextContrast(next)
    applyAppearance(accentColor, brightness, appearanceOptions({ contrast: next }))
  }

  async function exportVisualPreviewDiagnostic() {
    const exporter = getXleth()?.diag?.exportVisualPreviewLog
    if (!exporter) {
      setDiagState({ status: 'error', message: 'Diagnostic export unavailable in this build.', path: '' })
      return
    }
    try {
      const picked = await openFilePicker({
        mode: 'saveFile',
        title: 'Export Visual Preview Diagnostic',
        subtitle: 'Choose where to write the diagnostic text file.',
        actionLabel: 'Export',
        defaultName: 'xleth-visual-preview-diagnostic.txt',
        defaultExtension: 'txt',
        filters: [{ name: 'Text Log', extensions: ['txt'] }],
      })
      const destPath = getPickerPath(picked)
      if (!destPath && !picked?.unavailable) {
        setDiagState({ status: 'idle', message: '', path: '' })
        return
      }
      setDiagState({ status: 'working', message: 'Collecting diagnostic...', path: '' })
      const preview = snapshotPreviewDiag()
      const extras = {
        preview,
        proxyWebgl: collectProxyWebGLInfo(),
        previewWasMounted: !!preview,
      }
      const result = await exporter(destPath ? { ...extras, destPath } : extras)
      if (result?.cancelled) {
        setDiagState({ status: 'idle', message: '', path: '' })
      } else if (result?.error) {
        setDiagState({ status: 'error', message: result.error, path: '' })
      } else if (result?.path) {
        setDiagState({ status: 'ok', message: 'Diagnostic written to:', path: result.path })
      } else {
        setDiagState({ status: 'error', message: 'Unknown export result.', path: '' })
      }
    } catch (e) {
      setDiagState({ status: 'error', message: String(e?.message || e), path: '' })
    }
  }

  const audioDeviceOptions = useMemo(
    () => audioDevices.map(device => ({ value: device, label: device })),
    [audioDevices]
  )

  const audioBufferSizeOptions = useMemo(() => {
    const opts = []
    if (typeof audioDefaultBufferSize === 'number')
      opts.push({ value: audioDefaultBufferSize, label: `Default (${audioDefaultBufferSize} samples)` })
    for (const size of audioBufferSizes) {
      if (size === audioDefaultBufferSize) continue
      opts.push({ value: size, label: `${size} samples` })
    }
    return opts
  }, [audioBufferSizes, audioDefaultBufferSize])

  const audioSampleRateOptions = useMemo(
    () => audioSampleRates.map(rate => ({ value: rate, label: `${Math.round(rate)} Hz` })),
    [audioSampleRates]
  )

  // Live estimate: recomputed on every render from local state, so it updates
  // the instant a buffer size is picked rather than waiting on the device
  // round trip. bufferSize / sampleRate is the resulting output latency.
  const audioLiveLatencyMs = (typeof audioBufferSize === 'number' && typeof audioSampleRate === 'number' && audioSampleRate > 0)
    ? (audioBufferSize / audioSampleRate) * 1000
    : null

  const stretchOptions = projectStretchMethod == null
    ? [{ value: '', label: 'Loading...' }]
    : GLOBAL_STRETCH_METHOD_OPTIONS
  const defaultStretchOptions = defaultStretchMethod == null
    ? [{ value: '', label: 'Loading...' }]
    : GLOBAL_STRETCH_METHOD_OPTIONS

  const renderProject = () => (
    <>
      <SettingsSection title="Clip Processing" index={0}>
        <SettingsRow
          label="Global Clip Processing"
          htmlFor="settings-project-stretch-method"
          description="Applies to this project."
        >
          <XlethSelect
            id="settings-project-stretch-method"
            value={projectStretchMethod ?? ''}
            options={stretchOptions}
            onChange={nextValue => applyProjectStretchMethod(Number(nextValue))}
            disabled={projectStretchMethod == null}
            ariaLabel="Global Clip Processing"
            className="settings-panel-select settings-panel-select--stretch-method"
          />
        </SettingsRow>
        {projectStretchMethod === 5 && (
          <div className="settings-panel-hint settings-panel-hint--inline">
            Best for speech and vocal samples. Processes offline - parameter changes apply after a short analysis step.
          </div>
        )}
        <SettingsRow
          label="New Project Default"
          htmlFor="settings-default-stretch-method"
          description="Used only for newly created blank projects."
        >
          <XlethSelect
            id="settings-default-stretch-method"
            value={defaultStretchMethod ?? ''}
            options={defaultStretchOptions}
            onChange={nextValue => applyDefaultStretchMethod(Number(nextValue))}
            disabled={defaultStretchMethod == null}
            ariaLabel="New Project Default"
            className="settings-panel-select settings-panel-select--stretch-method"
          />
        </SettingsRow>
        {defaultStretchMethod === 5 && (
          <div className="settings-panel-hint settings-panel-hint--inline">
            Best for speech and vocal samples. Processes offline - parameter changes apply after a short analysis step.
          </div>
        )}
        <SettingsRow
          label="Formant Preservation"
          htmlFor="settings-formant-preserve"
          description="Preserves vocal character during global clip processing when supported."
        >
          <input
            id="settings-formant-preserve"
            type="checkbox"
            className="settings-panel-checkbox"
            checked={formantPreserve}
            onChange={e => applyFormant(e.target.checked)}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Playback" index={1}>
        <SettingsRow
          label="Spacebar behavior"
          htmlFor="settings-spacebar-mode"
          description="Play/Pause holds position when stopped. Play/Stop returns to where playback started."
        >
          <XlethSelect
            id="settings-spacebar-mode"
            value={spacebarMode}
            options={SPACEBAR_OPTIONS}
            onChange={applySpacebarMode}
            ariaLabel="Spacebar behavior"
            className="settings-panel-select"
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Project Safety" index={2}>
        <SettingsRow
          label="Autosave"
          htmlFor="settings-autosave-interval"
          description="Automatically save recovery points while editing this project."
        >
          <XlethSelect
            id="settings-autosave-interval"
            value={autosaveInterval}
            options={AUTOSAVE_OPTIONS}
            onChange={nextValue => applyAutosaveInterval(Number(nextValue))}
            ariaLabel="Autosave"
            className="settings-panel-select"
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Export Naming" index={3}>
        <SettingsRow
          label="Filename Format"
          htmlFor="settings-filename-format"
          description="Controls generated sample/export names without changing project editing state."
        >
          <XlethSelect
            id="settings-filename-format"
            value={namingFormat}
            options={NAMING_FORMAT_OPTIONS}
            onChange={applyNamingFormat}
            ariaLabel="Filename Format"
            className="settings-panel-select"
          />
        </SettingsRow>
      </SettingsSection>
    </>
  )

  const renderClipFx = () => {
    const d = clipVideoFxDefaults
    const videoClipCount = clipFxProject
      ? clipFxProject.clips.filter(c => clipHasVideo(c, clipFxProject.regionsById, clipFxProject.sourcesById)).length
      : null
    const nothingEnabled = !d.swirlEnabled && !d.waveEnabled

    return (
      <>
        <SettingsSection title="Swirl with Vibrato" index={0}>
          <SettingsRow
            label="Swirl with Vibrato"
            htmlFor="settings-clipfx-swirl-enabled"
            description="Include Swirl when applying defaults to the project. On a clip, Swirl only moves while that clip's Vibrato is on."
          >
            <input
              id="settings-clipfx-swirl-enabled"
              type="checkbox"
              className="settings-panel-checkbox"
              checked={d.swirlEnabled}
              onChange={e => applyClipVideoFxDefault({ swirlEnabled: e.target.checked })}
            />
          </SettingsRow>
          <SettingsRow
            label="Swirl"
            htmlFor="settings-clipfx-swirl-amount"
            description="Rotation the Vibrato LFO drives. Negative swirls the other way."
          >
            <div className="settings-panel-range-row">
              <input
                id="settings-clipfx-swirl-amount"
                type="range"
                min="-1"
                max="1"
                step="0.01"
                className="settings-panel-range"
                value={d.swirlAmount}
                onChange={e => applyClipVideoFxDefault({ swirlAmount: Number(e.target.value) })}
                aria-label="Default Swirl amount"
              />
              <span className="settings-panel-range-value">{d.swirlAmount.toFixed(2)}</span>
            </div>
          </SettingsRow>
        </SettingsSection>

        <SettingsSection title="Wave with Scratch" index={1}>
          <SettingsRow
            label="Wave with Scratch"
            htmlFor="settings-clipfx-wave-enabled"
            description="Include Wave when applying defaults to the project. On a clip, Wave only moves while that clip's Scratch is on."
          >
            <input
              id="settings-clipfx-wave-enabled"
              type="checkbox"
              className="settings-panel-checkbox"
              checked={d.waveEnabled}
              onChange={e => applyClipVideoFxDefault({ waveEnabled: e.target.checked })}
            />
          </SettingsRow>
          <SettingsRow
            label="Wave"
            htmlFor="settings-clipfx-wave-amount"
            description="Displacement the Scratch curve drives."
          >
            <div className="settings-panel-range-row">
              <input
                id="settings-clipfx-wave-amount"
                type="range"
                min="-1"
                max="1"
                step="0.01"
                className="settings-panel-range"
                value={d.waveAmount}
                onChange={e => applyClipVideoFxDefault({ waveAmount: Number(e.target.value) })}
                aria-label="Default Wave amount"
              />
              <span className="settings-panel-range-value">{d.waveAmount.toFixed(2)}</span>
            </div>
          </SettingsRow>
          <SettingsRow
            label="Freq"
            htmlFor="settings-clipfx-wave-frequency"
            description="Ripples across the frame."
          >
            <div className="settings-panel-range-row">
              <input
                id="settings-clipfx-wave-frequency"
                type="range"
                min="0.25"
                max="64"
                step="0.25"
                className="settings-panel-range"
                value={d.waveFrequency}
                onChange={e => applyClipVideoFxDefault({ waveFrequency: Number(e.target.value) })}
                aria-label="Default Wave frequency"
              />
              <span className="settings-panel-range-value">{d.waveFrequency.toFixed(2)}x</span>
            </div>
          </SettingsRow>
          <SettingsRow
            label="Smear"
            htmlFor="settings-clipfx-smear-amount"
            description="Trails the displaced pixels along the wave."
          >
            <div className="settings-panel-range-row">
              <input
                id="settings-clipfx-smear-amount"
                type="range"
                min="-1"
                max="1"
                step="0.01"
                className="settings-panel-range"
                value={d.smearAmount}
                onChange={e => applyClipVideoFxDefault({ smearAmount: Number(e.target.value) })}
                aria-label="Default Smear amount"
              />
              <span className="settings-panel-range-value">{d.smearAmount.toFixed(2)}</span>
            </div>
          </SettingsRow>
          <SettingsRow
            label="Reverse Wave with Scratch"
            htmlFor="settings-clipfx-reverse-wave"
            description="Flips the wave direction while the Scratch curve runs backwards."
          >
            <input
              id="settings-clipfx-reverse-wave"
              type="checkbox"
              className="settings-panel-checkbox"
              checked={d.reverseWaveWithScratch}
              onChange={e => applyClipVideoFxDefault({ reverseWaveWithScratch: e.target.checked })}
            />
          </SettingsRow>
        </SettingsSection>

        <SettingsSection title="Apply to Project" index={2}>
          <SettingsRow
            label="Apply to video clips without it on"
            description={
              nothingEnabled
                ? 'Turn on Swirl or Wave above to have something to apply.'
                : videoClipCount == null
                  ? 'Reading the open project.'
                  : `${clipFxCandidates.length} of ${videoClipCount} video clip(s) would change. Clips that already have it on are left alone.`
            }
          >
            <button
              type="button"
              className="settings-panel-button"
              onClick={applyClipVideoFxToProject}
              disabled={nothingEnabled || clipFxStatus.state === 'applying' || clipFxCandidates.length === 0}
            >
              {clipFxStatus.state === 'applying' ? 'Applying...' : 'Apply to Project'}
            </button>
          </SettingsRow>
          {clipFxStatus.message && (
            <div className="settings-panel-hint settings-panel-hint--inline">{clipFxStatus.message}</div>
          )}
          <div className="settings-panel-hint settings-panel-hint--inline">
            These values also seed a clip&apos;s Swirl/Wave the first time you switch it on from the clip menu.
          </div>
        </SettingsSection>
      </>
    )
  }

  const renderAudio = () => (
    <>
      <SettingsSection title="Output Device" index={0}>
        <SettingsRow
          label="Output device"
          htmlFor="settings-audio-output-device"
          description="The audio driver and device Xleth plays through."
        >
          <div className="settings-panel-inline-row">
            <XlethSelect
              id="settings-audio-output-device"
              value={audioSelectedDevice}
              options={audioDeviceOptions}
              onChange={applyAudioDeviceChange}
              ariaLabel="Audio output device"
              className="settings-panel-select"
            />
            <button
              type="button"
              className="settings-panel-button settings-panel-button--icon"
              onClick={applyAudioRescan}
              disabled={audioRescanning}
              title="Rescan for connected audio devices"
            >
              <RefreshCw size={14} aria-hidden="true" className={audioRescanning ? 'settings-panel-spin' : ''} />
              <span>{audioRescanning ? 'Rescanning...' : 'Rescan'}</span>
            </button>
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Buffer & Latency" index={1}>
        <SettingsRow
          label="Buffer size"
          htmlFor="settings-audio-buffer-size"
          description="Trade latency for playback stability. Lower is snappier but more prone to crackle."
        >
          <XlethSelect
            id="settings-audio-buffer-size"
            value={audioBufferSize ?? ''}
            options={audioBufferSizeOptions}
            onChange={applyAudioBufferSize}
            ariaLabel="Buffer size"
            className="settings-panel-select"
          />
        </SettingsRow>
        <SettingsRow
          label="Sample rate"
          htmlFor="settings-audio-sample-rate"
          description="The device's operating sample rate."
        >
          <XlethSelect
            id="settings-audio-sample-rate"
            value={audioSampleRate ?? ''}
            options={audioSampleRateOptions}
            onChange={applyAudioSampleRate}
            ariaLabel="Sample rate"
            className="settings-panel-select"
          />
        </SettingsRow>
        <SettingsRow label="Output latency">
          <span className="settings-panel-value">
            {typeof audioLiveLatencyMs === 'number' ? `${audioLiveLatencyMs.toFixed(1)} ms` : '—'}
          </span>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Audio Diagnostics" index={2} className="settings-panel-section--wide">
        <AudioPerformanceDiagnosticsPanel />
      </SettingsSection>
    </>
  )

  const renderPlugins = () => (
    <SettingsSection title="VST3 Plugin Library" index={0} className="settings-panel-section--vst-browser">
      <VstBrowser embedded />
    </SettingsSection>
  )

  const renderGraphics = () => (
    <>
      <SettingsSection title="Graphics Adapter" index={0}>
        <SettingsRow label="Graphics adapter">
          <span
            className={`settings-panel-value settings-panel-value--${gpuSummaryTone()}`}
            data-gpu-state={gpuStatus.state}
            data-hw-encoder-state={hwEncoderStatus.state}
          >
            {gpuSummaryText()}
          </span>
        </SettingsRow>
        {gpuStatus.adapters.length > 0 && (
          <ul className="settings-panel-hint settings-panel-list">
            {gpuStatus.adapters.map((a, i) => (
              <li key={i}>{formatAdapterLine(a)}</li>
            ))}
          </ul>
        )}
        <div className="settings-panel-hint">
          Confirm Xleth detects your graphics adapter correctly. NVIDIA, AMD, and Intel adapters are supported for hardware video encode/decode. If no hardware video encoder is found, Xleth uses software video encode/decode.
        </div>
      </SettingsSection>

      <SettingsSection title="Video Pipeline" index={1}>
        <SettingsRow
          label="Video encode/decode"
          htmlFor="settings-video-mode"
          description="Auto uses hardware acceleration if available, falling back to software."
        >
          <XlethSelect
            id="settings-video-mode"
            value={videoMode}
            options={VIDEO_MODE_OPTIONS}
            onChange={applyVideoMode}
            ariaLabel="Video encode/decode"
            className="settings-panel-select"
          />
        </SettingsRow>
        <div className="settings-panel-hint">
          Software always uses CPU-based encode/decode. Hardware only uses GPU acceleration and fails loudly if unavailable. Display compositing always uses OpenGL regardless of this setting.
        </div>
      </SettingsSection>

      <SettingsSection title="Preview Proxies" index={2}>
        <SettingsRow
          label="Proxy codec"
          htmlFor="settings-proxy-codec"
          description="Format of the small preview copies Xleth makes of your video sources."
        >
          <XlethSelect
            id="settings-proxy-codec"
            value={proxyCodec}
            options={PROXY_CODEC_OPTIONS}
            onChange={applyProxyCodec}
            ariaLabel="Proxy codec"
            className="settings-panel-select"
          />
        </SettingsRow>
        <div className="settings-panel-hint">
          H.264 proxies take about a tenth of the disk space. All-intra proxies seek instantly but are 10 to 20 times larger. The choice applies to new proxies. When H.264 is selected, opening a project converts its older all-intra proxies in the background.
        </div>
        {proxyCodecState && proxyCodecState.requested === 'h264' && !proxyCodecState.h264Available && (
          <div className="settings-panel-hint settings-panel-hint--warning">
            No H.264 encoder is available on this system (Windows N editions need the Media Feature Pack), so new proxies use all-intra.
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="Regenerable Files" index={3}>
        <SettingsRow
          label="Delete regenerable files when closing a project"
          htmlFor="settings-purge-on-close"
          description="Removes preview proxies, thumbnails and waveform caches when you close or switch projects, or quit."
        >
          <input
            id="settings-purge-on-close"
            type="checkbox"
            className="settings-panel-checkbox"
            checked={purgeOnClose}
            onChange={e => applyPurgeOnClose(e.target.checked)}
          />
        </SettingsRow>
        <div className="settings-panel-hint">
          Saves disk space between sessions. Your source media and project file are never touched. Xleth rebuilds
          whatever the project needs in the background the next time you open it — you can keep working meanwhile,
          and the first playback may be slower until the previews are back. Previews whose source media is offline
          are kept, because they cannot be rebuilt. File &gt; Clean up project removes leftovers on demand.
        </div>
        {purgeOnCloseError && (
          <div className="settings-panel-hint settings-panel-hint--warning">
            {purgeOnCloseError}
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="Visual Preview Diagnostics" index={4}>
        <SettingsRow
          label="Visual preview diagnostic"
          description="Saves a plain-text report of the main preview and grid pipeline."
        >
          <button
            type="button"
            className="settings-panel-button"
            onClick={exportVisualPreviewDiagnostic}
            disabled={diagState.status === 'working'}
          >
            {diagState.status === 'working' ? 'Exporting...' : 'Export Visual Preview Diagnostic Log...'}
          </button>
        </SettingsRow>
        <div className="settings-panel-hint">
          Send this file to support if the main preview is blank, black, or frozen. The Sample Selector preview and imported-video popup use a different code path.
        </div>
        {diagState.status === 'ok' && (
          <div className="settings-panel-hint settings-panel-hint--success">
            {diagState.message} {diagState.path}
          </div>
        )}
        {diagState.status === 'error' && (
          <div className="settings-panel-hint settings-panel-hint--warning">
            Export failed: {diagState.message}
          </div>
        )}
      </SettingsSection>
    </>
  )

  const renderAppearance = () => {
    const backdropFxDisabled = !backdropFxSettings.enabled
    const studioGridOverlayDisabled = backdropFxDisabled || backdropFxSettings.preset !== 'subtle-glass'
    const backdropMediaSource = backdropMediaSettings.sourceType
    const activeMediaPath = backdropMediaSource === 'video'
      ? backdropMediaSettings.videoPath
      : backdropMediaSource === 'image'
        ? backdropMediaSettings.imagePath || backdropState?.imagePath
        : ''
    const mediaStatus = backdropMediaSettings.lastError || backdropState?.lastError || ''
    return (
      <>
        <SettingsSection title="Theme" index={0}>
          <SettingsRow
            label="Accent color"
            htmlFor="settings-appearance-accent"
            description="Highlights, active controls, and selection across the app."
          >
            <div className="settings-panel-color-row">
              <input
                id="settings-appearance-accent"
                type="color"
                className="settings-panel-color-input"
                value={accentColor}
                onChange={handleAccentChange}
                aria-label="Accent color"
              />
              <span className="settings-panel-range-value">{accentColor.toUpperCase()}</span>
            </div>
          </SettingsRow>
          <SettingsRow
            label="Brightness"
            htmlFor="settings-appearance-brightness"
            description="Lowest is near-black with light text; highest is light grey with dark text."
          >
            <div className="settings-panel-range-row">
              <input
                id="settings-appearance-brightness"
                type="range"
                min="0"
                max="100"
                step="1"
                className="settings-panel-range"
                value={brightness}
                onChange={handleBrightnessChange}
                aria-label="Brightness"
              />
              <span className="settings-panel-range-value">{brightness}%</span>
            </div>
          </SettingsRow>
          <SettingsRow
            label="Hue"
            htmlFor="settings-appearance-hue"
            description="Tints panels, text, and borders. Independent of the accent, so a warm chrome can carry a cool accent."
          >
            <div className="settings-panel-range-row">
              <input
                id="settings-appearance-hue"
                type="range"
                min="0"
                max="359"
                step="1"
                className="settings-panel-range settings-panel-range--hue"
                value={chromeHue}
                onChange={handleChromeHueChange}
                aria-label="Hue"
              />
              <span className="settings-panel-range-value">{chromeHue}&deg;</span>
            </div>
          </SettingsRow>
          <SettingsRow
            label="Saturation"
            htmlFor="settings-appearance-saturation"
            description="How strongly the hue reads. 0% is neutral grey; the default 100% is a faint cast."
          >
            <div className="settings-panel-range-row">
              <input
                id="settings-appearance-saturation"
                type="range"
                min="0"
                max="300"
                step="5"
                className="settings-panel-range settings-panel-range--saturation"
                // Track previews the chosen hue so the control shows what it does.
                style={{
                  '--range-track-image': `linear-gradient(to right, hsl(${chromeHue} 0% 45%), hsl(${chromeHue} 60% 45%))`,
                }}
                value={chromeSaturation}
                onChange={handleChromeSaturationChange}
                aria-label="Saturation"
              />
              <span className="settings-panel-range-value">{chromeSaturation}%</span>
            </div>
          </SettingsRow>
          <SettingsRow
            label="Text contrast"
            htmlFor="settings-appearance-contrast"
            description="Separation between text and its background. Body text stays above the WCAG AA floor at every setting."
          >
            <div className="settings-panel-range-row">
              <input
                id="settings-appearance-contrast"
                type="range"
                min="60"
                max="160"
                step="5"
                className="settings-panel-range"
                value={textContrast}
                onChange={handleTextContrastChange}
                aria-label="Text contrast"
              />
              <span className="settings-panel-range-value">{textContrast}%</span>
            </div>
          </SettingsRow>
        </SettingsSection>

        <SettingsSection title="Backdrop Media" index={1}>
          <SettingsRow
            label="Source"
            htmlFor="settings-backdrop-media-source"
            description="Workspace chrome behind panels."
          >
            <XlethSelect
              id="settings-backdrop-media-source"
              value={backdropMediaSource}
              options={BACKDROP_MEDIA_SOURCE_TYPES}
              onChange={applyBackdropMediaSource}
              ariaLabel="Backdrop Media source"
              className="settings-panel-select"
            />
          </SettingsRow>
          {backdropMediaSource === 'image' && (
            <SettingsRow
              label="Image file"
              description="Copies PNG, JPEG, or WebP files into XLETH/art."
            >
              <button
                type="button"
                className="settings-panel-button settings-panel-button--icon"
                onClick={chooseWorkspaceBackdropImage}
              >
                <ImageIcon size={14} aria-hidden="true" />
                <span>{activeMediaPath ? 'Change Image...' : 'Select Image...'}</span>
              </button>
            </SettingsRow>
          )}
          {backdropMediaSource === 'video' && (
            <SettingsRow
              label="Video file"
              description="Selects a silent looping MP4 background video."
            >
              <button
                type="button"
                className="settings-panel-button settings-panel-button--icon"
                onClick={chooseWorkspaceBackdropVideo}
              >
                <Film size={14} aria-hidden="true" />
                <span>{activeMediaPath ? 'Change MP4...' : 'Select MP4...'}</span>
              </button>
            </SettingsRow>
          )}
          <input
            ref={backdropVideoInputRef}
            type="file"
            accept=".mp4,video/mp4"
            className="settings-panel-hidden-file-input"
            aria-hidden="true"
            tabIndex={-1}
            onChange={handleBackdropVideoFileChange}
          />
          {activeMediaPath && (
            <div className="settings-panel-hint">
              Active file: {activeMediaPath}
            </div>
          )}
          {backdropMediaSource === 'video' && (
            <div className="settings-panel-hint">
              Video is always muted and looped.
            </div>
          )}
          {backdropMediaSource === 'acrylic' && backdropState?.capability && !backdropState.capability.supportsNativeSystemBackdrop && (
            <div className="settings-panel-hint settings-panel-hint--warning">
              Acrylic is unsupported on this system; Xleth is using the solid workspace background.
            </div>
          )}
          {mediaStatus && (
            <div className="settings-panel-hint settings-panel-hint--warning">
              {mediaStatus}
            </div>
          )}
          {backdropMediaSource === 'image' && !backdropState?.imageUrl && (
            <div className="settings-panel-hint settings-panel-hint--warning">
              No backdrop image was found in XLETH/art.
            </div>
          )}
        </SettingsSection>

        <SettingsSection title="Backdrop FX" index={2}>
          <SettingsRow
            label="Enable reactive backdrop"
            htmlFor="settings-backdrop-fx-enabled"
            description="Adds restrained renderer-only effects behind workspace panels."
          >
            <input
              id="settings-backdrop-fx-enabled"
              type="checkbox"
              className="settings-panel-checkbox"
              checked={backdropFxSettings.enabled}
              onChange={event => applyBackdropFxSettings({ enabled: event.target.checked })}
            />
          </SettingsRow>
          <SettingsRow label="Preset" htmlFor="settings-backdrop-fx-preset">
            <XlethSelect
              id="settings-backdrop-fx-preset"
              value={backdropFxSettings.preset}
              options={BACKDROP_FX_PRESETS}
              onChange={preset => applyBackdropFxSettings({ preset })}
              disabled={backdropFxDisabled}
              ariaLabel="Backdrop FX preset"
              className="settings-panel-select"
            />
          </SettingsRow>
          <SettingsRow label="Studio Grid overlay" htmlFor="settings-backdrop-fx-studio-grid">
            <input
              id="settings-backdrop-fx-studio-grid"
              type="checkbox"
              className="settings-panel-checkbox"
              checked={backdropFxSettings.studioGridOverlay}
              disabled={studioGridOverlayDisabled}
              onChange={event => applyBackdropFxSettings({ studioGridOverlay: event.target.checked })}
            />
          </SettingsRow>
          <SettingsRow label="Quality" htmlFor="settings-backdrop-fx-quality">
            <XlethSelect
              id="settings-backdrop-fx-quality"
              value={backdropFxSettings.quality}
              options={BACKDROP_FX_QUALITIES}
              onChange={quality => applyBackdropFxSettings({ quality })}
              disabled={backdropFxDisabled}
              ariaLabel="Backdrop FX quality"
              className="settings-panel-select"
            />
          </SettingsRow>
          <SettingsRow label="Intensity" htmlFor="settings-backdrop-fx-intensity">
            <div className="settings-panel-range-row">
              <input
                id="settings-backdrop-fx-intensity"
                type="range"
                min="0"
                max="100"
                step="1"
                className="settings-panel-range"
                value={backdropFxSettings.intensity}
                disabled={backdropFxDisabled}
                onChange={event => applyBackdropFxSettings({ intensity: Number(event.target.value) })}
              />
              <span className="settings-panel-range-value">{backdropFxSettings.intensity}%</span>
            </div>
          </SettingsRow>
          <SettingsRow label="React to cursor" htmlFor="settings-backdrop-fx-cursor">
            <input
              id="settings-backdrop-fx-cursor"
              type="checkbox"
              className="settings-panel-checkbox"
              checked={backdropFxSettings.reactToCursor}
              disabled={backdropFxDisabled}
              onChange={event => applyBackdropFxSettings({ reactToCursor: event.target.checked })}
            />
          </SettingsRow>
          <SettingsRow label="React to windows" htmlFor="settings-backdrop-fx-windows">
            <input
              id="settings-backdrop-fx-windows"
              type="checkbox"
              className="settings-panel-checkbox"
              checked={backdropFxSettings.reactToWindows}
              disabled={backdropFxDisabled}
              onChange={event => applyBackdropFxSettings({ reactToWindows: event.target.checked })}
            />
          </SettingsRow>
          <SettingsRow label="React to backdrop clicks" htmlFor="settings-backdrop-fx-clicks">
            <input
              id="settings-backdrop-fx-clicks"
              type="checkbox"
              className="settings-panel-checkbox"
              checked={backdropFxSettings.reactToClicks}
              disabled={backdropFxDisabled}
              onChange={event => applyBackdropFxSettings({ reactToClicks: event.target.checked })}
            />
          </SettingsRow>
        </SettingsSection>
      </>
    )
  }

  const renderLaunchers = () => {
    function basename(p) {
      return p ? p.replace(/\\/g, '/').split('/').pop() : ''
    }

    async function chooseLauncherExe() {
      const picked = await openFilePicker({
        mode: 'openFile',
        title: 'Choose Launcher EXE',
        subtitle: 'Select the executable to launch from XLETH.',
        actionLabel: 'Choose EXE',
        filters: [{ name: 'Windows Executable', extensions: ['exe'] }],
        legacyPicker: () => getXleth()?.launcher?.chooseExe?.(),
      })
      return getPickerPath(picked)
    }

    async function chooseLauncherPng() {
      const picked = await openFilePicker({
        mode: 'openFile',
        title: 'Choose Launcher Icon',
        subtitle: 'Select a PNG icon for this launcher.',
        actionLabel: 'Choose PNG',
        filters: [{ name: 'PNG Image', extensions: ['png'] }],
        legacyPicker: () => getXleth()?.launcher?.choosePng?.(),
      })
      return getPickerPath(picked)
    }

    async function browseExeForPending() {
      const p = await chooseLauncherExe()
      if (p) setPendingLauncher(prev => ({ ...prev, exePath: p }))
    }
    async function browsePngForPending() {
      const p = await chooseLauncherPng()
      if (p) setPendingLauncher(prev => ({ ...prev, iconPngPath: p }))
    }
    async function confirmAdd() {
      if (!pendingLauncher?.label || !pendingLauncher?.exePath) return
      await addLauncher({
        id: globalThis.crypto.randomUUID(),
        label: pendingLauncher.label,
        exePath: pendingLauncher.exePath,
        iconPngPath: pendingLauncher.iconPngPath || '',
      })
      setPendingLauncher(null)
    }

    async function browseExeForEdit() {
      const p = await chooseLauncherExe()
      if (p) setEditDraft(d => ({ ...d, exePath: p }))
    }
    async function browsePngForEdit() {
      const p = await chooseLauncherPng()
      if (p) setEditDraft(d => ({ ...d, iconPngPath: p }))
    }
    async function confirmEdit() {
      if (!editDraft?.label || !editDraft?.exePath) return
      await updateLauncher(editingId, editDraft)
      setEditingId(null)
      setEditDraft(null)
    }

    return (
      <SettingsSection title="Quick Launchers" index={0}>
        {launchers.length === 0 && (
          <div className="settings-panel-hint">No quick launchers configured.</div>
        )}

        {launchers.map((launcher) =>
          editingId === launcher.id ? (
            <div key={launcher.id} className="settings-quick-launcher-edit-row">
              <input
                className="settings-panel-text-input"
                value={editDraft.label}
                placeholder="Label"
                onChange={e => setEditDraft(d => ({ ...d, label: e.target.value }))}
              />
              <button
                type="button"
                className="settings-panel-button settings-panel-button--icon"
                onClick={browseExeForEdit}
                title={editDraft.exePath || 'Choose EXE...'}
              >
                <span>{editDraft.exePath ? basename(editDraft.exePath) : 'Choose EXE...'}</span>
              </button>
              <button
                type="button"
                className="settings-panel-button settings-panel-button--icon"
                onClick={browsePngForEdit}
                title={editDraft.iconPngPath || 'Choose PNG...'}
              >
                <span>{editDraft.iconPngPath ? basename(editDraft.iconPngPath) : 'Choose PNG...'}</span>
              </button>
              <button
                type="button"
                className="settings-panel-button"
                onClick={confirmEdit}
                disabled={!editDraft?.label || !editDraft?.exePath}
              >
                Save
              </button>
              <button
                type="button"
                className="settings-panel-button"
                onClick={() => { setEditingId(null); setEditDraft(null) }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div key={launcher.id} className="settings-quick-launcher-row">
              <span className="settings-quick-launcher-label">{launcher.label}</span>
              <span className="settings-quick-launcher-path" title={launcher.exePath}>{launcher.exePath}</span>
              <button
                type="button"
                className="settings-panel-button"
                onClick={() => { setEditingId(launcher.id); setEditDraft({ label: launcher.label, exePath: launcher.exePath, iconPngPath: launcher.iconPngPath }) }}
              >
                Edit
              </button>
              <button
                type="button"
                className="settings-panel-button"
                onClick={() => removeLauncher(launcher.id)}
              >
                Remove
              </button>
            </div>
          )
        )}

        {pendingLauncher == null ? (
          <button
            type="button"
            className="settings-panel-button settings-panel-button--icon"
            onClick={() => setPendingLauncher({ label: '', exePath: '', iconPngPath: '' })}
            style={{ marginTop: launchers.length > 0 ? '8px' : '0' }}
          >
            <span>Add Quick Launcher...</span>
          </button>
        ) : (
          <div className="settings-quick-launcher-edit-row">
            <input
              className="settings-panel-text-input"
              value={pendingLauncher.label}
              placeholder="Label (e.g. FL Studio)"
              onChange={e => setPendingLauncher(p => ({ ...p, label: e.target.value }))}
            />
            <button
              type="button"
              className="settings-panel-button settings-panel-button--icon"
              onClick={browseExeForPending}
              title={pendingLauncher.exePath || 'Choose EXE...'}
            >
              <span>{pendingLauncher.exePath ? basename(pendingLauncher.exePath) : 'Choose EXE...'}</span>
            </button>
            <button
              type="button"
              className="settings-panel-button settings-panel-button--icon"
              onClick={browsePngForPending}
              title={pendingLauncher.iconPngPath || 'Choose PNG (optional)...'}
            >
              <span>{pendingLauncher.iconPngPath ? basename(pendingLauncher.iconPngPath) : 'Choose PNG (optional)...'}</span>
            </button>
            <button
              type="button"
              className="settings-panel-button"
              onClick={confirmAdd}
              disabled={!pendingLauncher.label || !pendingLauncher.exePath}
            >
              Add
            </button>
            <button
              type="button"
              className="settings-panel-button"
              onClick={() => setPendingLauncher(null)}
            >
              Cancel
            </button>
          </div>
        )}
      </SettingsSection>
    )
  }

  const renderActiveCategory = () => {
    switch (activeCategory) {
      case 'shortcuts':
        return <ShortcutsSection SettingsSection={SettingsSection} />
      case 'logs':
        return <LogsSection SettingsSection={SettingsSection} SettingsRow={SettingsRow} />
      case 'audio':
        return renderAudio()
      case 'plugins':
        return renderPlugins()
      case 'graphics':
        return renderGraphics()
      case 'appearance':
        return renderAppearance()
      case 'launchers':
        return renderLaunchers()
      case 'clipfx':
        return renderClipFx()
      case 'project':
      default:
        return renderProject()
    }
  }

  return (
    <div
      className="settings-panel-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose?.()
      }}
    >
      <div
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-panel-title"
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="settings-panel-header">
          <div className="settings-panel-headline">
            <div id="settings-panel-title" className="settings-panel-title">Settings</div>
            {/* The scope, not the page. The page's own description lives on the
                content heading below, so the two never say the same thing. */}
            <div className="settings-panel-subtitle">{activeTabDef.summary}</div>
          </div>

          <div
            className="settings-panel-tabs"
            role="tablist"
            aria-label="Settings scope"
          >
            {SETTINGS_TABS.map(tab => {
              const selected = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  id={`settings-tab-${tab.id}`}
                  aria-selected={selected}
                  aria-controls="settings-panel-subnav"
                  className={`settings-panel-tab${selected ? ' settings-panel-tab--active' : ''}`}
                  onClick={() => selectTab(tab.id)}
                >
                  {tab.label}
                </button>
              )
            })}
          </div>

          <button className="settings-panel-close" onClick={onClose} aria-label="Close Settings">
            <X size={15} aria-hidden="true" />
          </button>
        </div>

        <div className="settings-panel-shell">
          <nav
            className="settings-panel-categories"
            id="settings-panel-subnav"
            aria-label={`${activeTabDef.label} settings`}
          >
            {visibleCategories.map(category => {
              const selected = activeCategory === category.id
              return (
                <button
                  key={category.id}
                  type="button"
                  className={`settings-panel-category${selected ? ' settings-panel-category--active' : ''}`}
                  aria-current={selected ? 'page' : undefined}
                  onClick={() => setActiveCategory(category.id)}
                >
                  <span>{category.label}</span>
                </button>
              )
            })}
          </nav>

          <div className="settings-panel-content-pane">
            <div
              key={activeCategory}
              className="settings-panel-content-animate"
              data-settings-category={activeCategory}
              data-settings-tab={activeTabDef.id}
            >
              <div className="settings-panel-category-heading">
                <div className="settings-panel-category-title">{activeCategoryDef.label}</div>
                <div className="settings-panel-category-description">{activeCategoryDef.summary}</div>
              </div>
              {renderActiveCategory()}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
