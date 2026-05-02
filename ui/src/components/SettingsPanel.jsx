import { useState, useEffect } from 'react'

// PROXY context only. This creates a fresh off-screen WebGL context inside
// the Settings tab. In most cases Chromium's GPU process will pick the same
// adapter for it as for the live preview canvas, but this is NOT guaranteed:
// context attributes (failIfMajorPerformanceCaveat, antialias), Electron flags,
// or driver state may differ. Treat this as a backup signal only — the
// authoritative WebGL info comes from VideoPreview's window.__xlethVisualPreviewDiag.
function collectProxyWebGLInfo() {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 4; canvas.height = 4
    const gl = canvas.getContext('webgl', { failIfMajorPerformanceCaveat: false })
                || canvas.getContext('experimental-webgl')
    if (!gl) return { error: 'getContext returned null in SettingsPanel probe' }
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    return {
      vendor:           gl.getParameter(gl.VENDOR),
      renderer:         gl.getParameter(gl.RENDERER),
      version:          gl.getParameter(gl.VERSION),
      glsl:             gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      unmaskedVendor:   dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)   : null,
      unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
      maxTextureSize:   gl.getParameter(gl.MAX_TEXTURE_SIZE),
      extensions:       gl.getSupportedExtensions() || [],
    }
  } catch (e) {
    return { error: String(e && e.message || e) }
  }
}

// Snapshot whatever VideoPreview has published. Returns null if the preview
// component never mounted (e.g. tester opened Settings before the preview
// panel was ever visible) — in which case the .txt log will say so explicitly.
function snapshotPreviewDiag() {
  const live = window.__xlethVisualPreviewDiag
  if (!live) return null
  // Deep-ish clone so the IPC structured-clone doesn't choke on live mutations
  // mid-send. Extensions array is the largest field; copy it explicitly.
  return {
    mode:                 live.mode,
    drawApi:              live.drawApi,
    lastTickAction:       live.lastTickAction,
    lastTickAtMsAgo:      live.lastTickAt > 0
                            ? Math.round(performance.now() - live.lastTickAt)
                            : null,
    shm: { ...live.shm },
    texUploadSuccess:     live.texUploadSuccess,
    texUploadFailures:    live.texUploadFailures,
    lastTexUploadError:   live.lastTexUploadError,
    contextLostCount:     live.contextLostCount,
    contextRestoredCount: live.contextRestoredCount,
    clearColorRgb:        live.clearColorRgb ? [...live.clearColorRgb] : null,
    webgl: live.webgl ? {
      ...live.webgl,
      extensions: Array.isArray(live.webgl.extensions)
        ? [...live.webgl.extensions] : null,
    } : null,
  }
}

export default function SettingsPanel({ onClose }) {
  const [stretchMethod, setStretchMethod] = useState(1)   // 1=PSOLA, 2=Rubber, 3=WSOLA, 4=PhaseVocoder
  const [formantPreserve, setFormantPreserve] = useState(false)
  const [spacebarMode, setSpacebarMode] = useState('play-pause')
  const [autosaveInterval, setAutosaveInterval] = useState(5)
  const [gpuStatus, setGpuStatus] = useState({ state: 'loading', adapters: [] })
  const [hwEncoderStatus, setHwEncoderStatus] = useState({ state: 'loading', encoders: [] })
  const [videoMode, setVideoMode] = useState('auto')
  const [diagState, setDiagState] = useState({ status: 'idle', message: '', path: '' })

  useEffect(() => {
    window.xleth.engine.getGlobalStretchMethod().then(m => setStretchMethod(m ?? 1))
    window.xleth.engine.getGlobalFormantPreserve().then(v => setFormantPreserve(!!v))
    window.xleth.settings.get('spacebarMode').then(v => {
      setSpacebarMode(v === 'play-stop' ? 'play-stop' : 'play-pause')
    }).catch(() => {})
    window.xleth.settings.get('autosaveInterval').then(v => {
      setAutosaveInterval(v != null ? Number(v) : 5)
    }).catch(() => {})
    window.xleth.settings.get('videoMode').then(v => {
      setVideoMode(['auto', 'software', 'hardware'].includes(v) ? v : 'auto')
    }).catch(() => {})

    if (window.xleth?.gpu?.getAvailableGpus) {
      window.xleth.gpu.getAvailableGpus()
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

    if (window.xleth?.video?.getAvailableEncoders) {
      window.xleth.video.getAvailableEncoders('h264')
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

  function formatAdapterLine(a) {
    const vendor = a.vendor || 'Unknown'
    const name = (a.name || '').trim() || '(unnamed)'
    const vram = a.vramMB > 0 ? ` — ${a.vramMB} MB VRAM` : ''
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
    if (gpuStatus.state === 'loading') return 'Detecting graphics adapters…'
    if (gpuStatus.state === 'unavailable') return 'Graphics adapter detection unavailable in this build.'
    if (gpuStatus.state === 'error') return `Graphics adapter detection failed: ${gpuStatus.error || 'unknown error'}`
    if (gpuStatus.state === 'none' || gpuStatus.adapters.length === 0) {
      return 'No graphics adapters detected — hardware video encode/decode and OpenGL compositor unavailable.'
    }
    const vendors = Array.from(new Set(gpuStatus.adapters.map(a => a.vendor || 'Unknown')))
    const vendorStr = vendors.join(' + ')
    if (hwEncoderStatus.state === 'loading') return `Graphics adapter detected: ${vendorStr} — checking hardware video encoder…`
    if (hwEncoderStatus.state === 'none') {
      return `Graphics adapter detected: ${vendorStr} — no hardware video encoder available, software video encode/decode will be used.`
    }
    if (hwEncoderStatus.state === 'available') {
      const names = hwEncoderStatus.encoders.map(e => e.displayName || e.name).join(', ')
      return `Graphics adapter detected: ${vendorStr} — hardware video encoder available (${names}).`
    }
    return `Graphics adapter detected: ${vendorStr}`
  }

  function gpuSummaryColor() {
    if (gpuStatus.state === 'none' || gpuStatus.state === 'error') return '#e08a3a'
    if (gpuStatus.state === 'detected') {
      if (hwEncoderStatus.state === 'none') return '#e08a3a'
      if (hwEncoderStatus.state === 'available') return '#7ac77a'
    }
    return 'inherit'
  }

  async function applyStretchMethod(m) {
    console.log('[UISettings] globalStretchMethod changed:', m)
    setStretchMethod(m)
    await window.xleth.engine.setGlobalStretchMethod(m)
    await window.xleth.settings.set('globalStretchMethod', m)
  }

  async function applyFormant(v) {
    console.log('[UISettings] globalFormantPreserve changed:', v)
    setFormantPreserve(v)
    await window.xleth.engine.setGlobalFormantPreserve(v)
    await window.xleth.settings.set('globalFormantPreserve', v)
  }

  async function applySpacebarMode(mode) {
    setSpacebarMode(mode)
    await window.xleth.settings.set('spacebarMode', mode)
    window.dispatchEvent(new CustomEvent('xleth:spacebarMode-changed', { detail: { mode } }))
  }

  async function applyAutosaveInterval(minutes) {
    setAutosaveInterval(minutes)
    await window.xleth.settings.set('autosaveInterval', minutes)
    await window.xleth.autosave.restart()
  }

  async function applyVideoMode(mode) {
    setVideoMode(mode)
    await window.xleth.settings.set('videoMode', mode)
  }

  async function exportVisualPreviewDiagnostic() {
    if (!window.xleth?.diag?.exportVisualPreviewLog) {
      setDiagState({ status: 'error', message: 'Diagnostic export unavailable in this build.', path: '' })
      return
    }
    setDiagState({ status: 'working', message: 'Collecting diagnostic…', path: '' })
    try {
      const preview = snapshotPreviewDiag()
      const extras = {
        // `preview` is the AUTHORITATIVE state of the live preview canvas
        // (null if VideoPreview never mounted — the .txt formatter handles
        // that case explicitly). `proxyWebgl` is the SettingsPanel-local
        // probe — useful only if Chromium picks the same adapter for it.
        preview,
        proxyWebgl: collectProxyWebGLInfo(),
        previewWasMounted: !!preview,
      }
      const result = await window.xleth.diag.exportVisualPreviewLog(extras)
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

  return (
    <div className="settings-panel-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-panel-header">
          <span>Settings</span>
          <button className="settings-panel-close" onClick={onClose}>✕</button>
        </div>
        <div className="settings-panel-section">
          <div className="settings-panel-section-title">Clip Processing</div>
          <div className="settings-panel-row">
            <label className="settings-panel-label">Default Stretch Method</label>
            <select
              className="settings-panel-select"
              value={stretchMethod}
              onChange={e => applyStretchMethod(Number(e.target.value))}
            >
              <option value={2}>Rubber Band</option>
              <option value={3}>WSOLA</option>
              <option value={1}>TD-PSOLA</option>
              <option value={5}>WORLD</option>
              <option value={4}>Phase Vocoder</option>
            </select>
            {stretchMethod === 5 && (
              <div className="settings-panel-hint">
                Best for speech and vocal samples. Processes offline — parameter changes apply after a short analysis step.
              </div>
            )}
          </div>
          <div className="settings-panel-row">
            <label className="settings-panel-label">Formant Preservation</label>
            <input
              type="checkbox"
              className="settings-panel-checkbox"
              checked={formantPreserve}
              onChange={e => applyFormant(e.target.checked)}
            />
          </div>
        </div>
        <div className="settings-panel-section">
          <div className="settings-panel-section-title">Transport</div>
          <div className="settings-panel-row">
            <label className="settings-panel-label">Spacebar behavior</label>
            <select
              className="settings-panel-select"
              value={spacebarMode}
              onChange={e => applySpacebarMode(e.target.value)}
            >
              <option value="play-pause">Play / Pause</option>
              <option value="play-stop">Play / Stop</option>
            </select>
          </div>
          <div className="settings-panel-hint">
            Play/Pause holds position when stopped. Play/Stop returns to where playback started.
          </div>
        </div>
        <div className="settings-panel-section">
          <div className="settings-panel-section-title">Graphics</div>
          <div className="settings-panel-row">
            <label className="settings-panel-label">Graphics adapter</label>
            <span
              className="settings-panel-value"
              data-gpu-state={gpuStatus.state}
              data-hw-encoder-state={hwEncoderStatus.state}
              style={{ fontWeight: 600, color: gpuSummaryColor() }}
            >
              {gpuSummaryText()}
            </span>
          </div>
          {gpuStatus.adapters.length > 0 && (
            <ul className="settings-panel-hint" style={{ margin: '4px 0 0 0', paddingLeft: 16 }}>
              {gpuStatus.adapters.map((a, i) => (
                <li key={i}>{formatAdapterLine(a)}</li>
              ))}
            </ul>
          )}
          <div className="settings-panel-hint">
            Confirm Xleth detects your graphics adapter correctly. NVIDIA, AMD, and Intel adapters are supported for hardware video encode/decode. If no hardware video encoder is found, Xleth uses software video encode/decode (slower but compatible). The OpenGL compositor requires any working graphics adapter.
          </div>
          <div className="settings-panel-row">
            <label className="settings-panel-label">Video encode/decode</label>
            <select
              className="settings-panel-select"
              value={videoMode}
              onChange={e => applyVideoMode(e.target.value)}
            >
              <option value="auto">Auto (recommended)</option>
              <option value="software">Software</option>
              <option value="hardware">Hardware only</option>
            </select>
          </div>
          <div className="settings-panel-hint">
            Auto uses hardware acceleration if available, falling back to software. Software always uses CPU-based encode/decode (slower, most compatible). Hardware only uses GPU acceleration and fails loudly if unavailable. Display compositing always uses OpenGL regardless of this setting.
          </div>
          <div className="settings-panel-row">
            <label className="settings-panel-label">Visual preview diagnostic</label>
            <button
              type="button"
              className="settings-panel-button"
              onClick={exportVisualPreviewDiagnostic}
              disabled={diagState.status === 'working'}
            >
              {diagState.status === 'working' ? 'Exporting…' : 'Export Visual Preview Diagnostic Log…'}
            </button>
          </div>
          <div className="settings-panel-hint">
            Saves a plain-text report of the main preview / grid pipeline (graphics adapter, compositor state, frame counters, WebGL info). Send this file to support if the main preview is blank, black, or frozen. The Sample Selector preview and the imported-video popup use a different code path and are not covered by this report.
          </div>
          {diagState.status === 'ok' && (
            <div className="settings-panel-hint" style={{ color: '#7ac77a', wordBreak: 'break-all' }}>
              {diagState.message} {diagState.path}
            </div>
          )}
          {diagState.status === 'error' && (
            <div className="settings-panel-hint" style={{ color: '#e08a3a' }}>
              Export failed: {diagState.message}
            </div>
          )}
        </div>
        <div className="settings-panel-section">
          <div className="settings-panel-section-title">Project</div>
          <div className="settings-panel-row">
            <label className="settings-panel-label">Autosave</label>
            <select
              className="settings-panel-select"
              value={autosaveInterval}
              onChange={e => applyAutosaveInterval(Number(e.target.value))}
            >
              <option value={0}>Off</option>
              <option value={1}>1 min</option>
              <option value={5}>5 min</option>
              <option value={15}>15 min</option>
              <option value={30}>30 min</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  )
}
