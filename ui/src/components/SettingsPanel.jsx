import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Film, Image as ImageIcon, X } from 'lucide-react'
import {
  GLOBAL_STRETCH_METHOD_OPTIONS,
  sanitizeGlobalStretchMethod,
} from '../constants/globalStretchMethods.js'
import AudioPerformanceDiagnosticsPanel from './debug/AudioPerformanceDiagnosticsPanel.jsx'
import XlethSelect from './common/XlethSelect.jsx'
import VstBrowser from './mixer/VstBrowser.jsx'
import { ThemeContext } from '../theming/runtime/ThemeProvider'
import { resolveTheme, writeThemeToRoot } from '../theming/runtime/applyTheme'
import {
  APPEARANCE_THEME_SLUG,
  DEFAULT_APPEARANCE_ACCENT,
  DEFAULT_APPEARANCE_DARKNESS,
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
  BACKDROP_MEDIA_SOURCE_TYPES,
  backdropMediaFromBackdropState,
  useBackdropMediaSettingsStore,
} from '../backdrop/backdropMediaSettings.js'

const VALID_NAMING_FORMATS = ['sampleNameOnly', 'categoryAndName', 'sourceAndName', 'fullLegacy']

export const SETTINGS_CATEGORIES = [
  { id: 'project', label: 'Project', summary: 'Clip handling and safety defaults' },
  { id: 'transport', label: 'Transport', summary: 'Playback controls' },
  { id: 'audio', label: 'Audio', summary: 'Latency and realtime diagnostics' },
  { id: 'plugins', label: 'Plugins', summary: 'Scan and manage VST3 plugins' },
  { id: 'graphics', label: 'Graphics', summary: 'GPU and preview diagnostics' },
  { id: 'appearance', label: 'Appearance', summary: 'Accent color, brightness, and workspace backdrop' },
  { id: 'launchers', label: 'Launchers', summary: 'Quick-launch external tools from the toolbar' },
  { id: 'advanced', label: 'Advanced', summary: 'Export naming behavior' },
]

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
  return SETTINGS_CATEGORIES.some(item => item.id === category) ? category : 'project'
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
  const [activeCategory, setActiveCategory] = useState(() => normalizeCategory(initialCategory))
  const [projectStretchMethod, setProjectStretchMethod] = useState(null)
  const [defaultStretchMethod, setDefaultStretchMethod] = useState(null)
  const [formantPreserve, setFormantPreserve] = useState(false)
  const [spacebarMode, setSpacebarMode] = useState('play-pause')
  const [autosaveInterval, setAutosaveInterval] = useState(5)
  const [gpuStatus, setGpuStatus] = useState({ state: 'loading', adapters: [] })
  const [hwEncoderStatus, setHwEncoderStatus] = useState({ state: 'loading', encoders: [] })
  const [videoMode, setVideoMode] = useState('auto')
  const [diagState, setDiagState] = useState({ status: 'idle', message: '', path: '' })
  const [namingFormat, setNamingFormat] = useState('sampleNameOnly')
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
    const chooser = getXleth()?.backdrop?.chooseImage
    if (!chooser) return
    try {
      const state = await chooser()
      if (state) {
        setBackdropState(state)
        syncBackdropMediaFromState(state)
      }
    } catch (err) {
      console.warn('[Settings] workspace backdrop image chooser failed:', err?.message || err)
    }
  }

  async function chooseWorkspaceBackdropVideo() {
    const chooser = getXleth()?.backdrop?.chooseVideo
    if (!chooser) {
      backdropVideoInputRef.current?.click()
      return
    }
    try {
      const state = await chooser()
      if (state) {
        setBackdropState(state)
        syncBackdropMediaFromState(state)
        return
      }
    } catch (err) {
      console.warn('[Settings] workspace backdrop video chooser failed:', err?.message || err)
    }
    backdropVideoInputRef.current?.click()
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

  function applyBackdropFxSettings(patch) {
    void setBackdropFxSettings(patch)
  }

  const applyAppearance = useCallback((accent, darkness) => {
    const file = buildAppearanceTheme(accent, darkness)

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
    }, 400)
  }, [themeContext])

  useEffect(() => () => {
    if (appearancePersistTimerRef.current) clearTimeout(appearancePersistTimerRef.current)
  }, [])

  function handleAccentChange(event) {
    const next = normalizeAccentHex(event.target.value)
    setAccentColor(next)
    applyAppearance(next, brightness)
  }

  function handleBrightnessChange(event) {
    const next = Math.min(100, Math.max(0, Number(event.target.value)))
    setBrightness(next)
    applyAppearance(accentColor, next)
  }

  async function exportVisualPreviewDiagnostic() {
    const exporter = getXleth()?.diag?.exportVisualPreviewLog
    if (!exporter) {
      setDiagState({ status: 'error', message: 'Diagnostic export unavailable in this build.', path: '' })
      return
    }
    setDiagState({ status: 'working', message: 'Collecting diagnostic...', path: '' })
    try {
      const preview = snapshotPreviewDiag()
      const extras = {
        preview,
        proxyWebgl: collectProxyWebGLInfo(),
        previewWasMounted: !!preview,
      }
      const result = await exporter(extras)
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

      <SettingsSection title="Project Safety" index={1}>
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
    </>
  )

  const renderTransport = () => (
    <SettingsSection title="Playback" index={0}>
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
  )

  const renderAudio = () => (
    <SettingsSection title="Audio Diagnostics" index={0} className="settings-panel-section--wide">
      <AudioPerformanceDiagnosticsPanel />
    </SettingsSection>
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

      <SettingsSection title="Visual Preview Diagnostics" index={2}>
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

    async function browseExeForPending() {
      const p = await getXleth()?.launcher?.chooseExe?.()
      if (p) setPendingLauncher(prev => ({ ...prev, exePath: p }))
    }
    async function browsePngForPending() {
      const p = await getXleth()?.launcher?.choosePng?.()
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
      const p = await getXleth()?.launcher?.chooseExe?.()
      if (p) setEditDraft(d => ({ ...d, exePath: p }))
    }
    async function browsePngForEdit() {
      const p = await getXleth()?.launcher?.choosePng?.()
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

  const renderAdvanced = () => (
    <SettingsSection title="Export Naming" index={0}>
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
  )

  const renderActiveCategory = () => {
    switch (activeCategory) {
      case 'transport':
        return renderTransport()
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
      case 'advanced':
        return renderAdvanced()
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
          <div>
            <div id="settings-panel-title" className="settings-panel-title">Settings</div>
            <div className="settings-panel-subtitle">{activeCategoryDef.summary}</div>
          </div>
          <button className="settings-panel-close" onClick={onClose} aria-label="Close Settings">
            <X size={15} aria-hidden="true" />
          </button>
        </div>

        <div className="settings-panel-shell">
          <nav className="settings-panel-categories" aria-label="Settings categories">
            {SETTINGS_CATEGORIES.map(category => {
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
