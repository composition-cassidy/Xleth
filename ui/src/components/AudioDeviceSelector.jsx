import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Settings, RefreshCw } from 'lucide-react'
import XlethSelect from './common/XlethSelect.jsx'

const FALLBACK_BUFFER_SIZES = [128, 256, 512, 1024, 2048]

// Output device, buffer size and sample rate are all hardware properties of
// this machine, not of the project — persisted through the same generic
// settings store previewResolutionScale uses (xleth-settings.json), never
// into project.json. main.js's applyEngineDefaults() restores all three from
// this same store before the window is ever shown, so by the time this
// component mounts the engine is already running with the saved config —
// this component only needs to save on change, never re-apply on mount.
const SETTINGS_KEY_DEVICE = 'audioOutputDevice'
const SETTINGS_KEY_BUFFER = 'audioBufferSize'
const SETTINGS_KEY_RATE   = 'audioSampleRate'

export default function AudioDeviceSelector() {
  const [devices, setDevices] = useState([])
  const [selected, setSelected] = useState('')
  const [rescanning, setRescanning] = useState(false)

  const [sampleRates, setSampleRates] = useState([])
  const [bufferSizes, setBufferSizes] = useState(FALLBACK_BUFFER_SIZES)
  const [defaultBufferSize, setDefaultBufferSize] = useState(null)
  const [bufferSize, setBufferSizeState] = useState(null)
  const [sampleRate, setSampleRateState] = useState(null)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [popoverPos, setPopoverPos] = useState(null)
  const gearRef = useRef(null)
  const popoverRef = useRef(null)

  const refreshDeviceInfo = useCallback(async () => {
    const info = await window.xleth?.audio?.getDeviceInfo?.()
    if (!info) return
    setBufferSizeState(info.bufferSize ?? null)
    setSampleRateState(info.sampleRate ?? null)
    if (Array.isArray(info.bufferSizes) && info.bufferSizes.length > 0)
      setBufferSizes(info.bufferSizes)
    setDefaultBufferSize(typeof info.defaultBufferSize === 'number' ? info.defaultBufferSize : null)
  }, [])

  useEffect(() => {
    async function init() {
      const list = await window.xleth?.audio?.getOutputDevices?.() ?? []
      setDevices(list)
      const current = await window.xleth?.audio?.getCurrentOutputDevice?.() ?? ''
      setSelected(current)

      const rates = await window.xleth?.audio?.getSupportedSampleRates?.() ?? []
      setSampleRates(rates)

      await refreshDeviceInfo()
    }
    init()
  }, [refreshDeviceInfo])

  const options = useMemo(
    () => devices.map(device => ({ value: device, label: device })),
    [devices]
  )

  // Live estimate: recomputed on every render from local state, so it updates
  // the instant a buffer size is picked rather than waiting on the device
  // round trip. bufferSize / sampleRate is the resulting output latency.
  const liveLatencyMs = (typeof bufferSize === 'number' && typeof sampleRate === 'number' && sampleRate > 0)
    ? (bufferSize / sampleRate) * 1000
    : null

  const handleChange = async (name) => {
    setSelected(name)
    const result = await window.xleth?.audio?.setOutputDevice?.(name)
    if (result && !result.ok) {
      console.error('[AudioDeviceSelector] switch failed:', result.error)
      return
    }
    await window.xleth?.settings?.set(SETTINGS_KEY_DEVICE, name)
    // A device switch can change the supported-rate list and the reopened
    // device's actual buffer/rate/latency — refresh everything the popover shows.
    const rates = await window.xleth?.audio?.getSupportedSampleRates?.() ?? []
    setSampleRates(rates)
    await refreshDeviceInfo()
  }

  const handleRescan = useCallback(async () => {
    if (rescanning) return
    setRescanning(true)
    try {
      const list = await window.xleth?.audio?.rescanDevices?.() ?? []
      setDevices(list)
      const current = await window.xleth?.audio?.getCurrentOutputDevice?.() ?? ''
      setSelected(current)
      const rates = await window.xleth?.audio?.getSupportedSampleRates?.() ?? []
      setSampleRates(rates)
      await refreshDeviceInfo()
    } finally {
      setRescanning(false)
    }
  }, [rescanning, refreshDeviceInfo])

  const handleBufferSizeChange = async (e) => {
    const size = parseInt(e.target.value, 10)
    setBufferSizeState(size) // optimistic — live latency label updates immediately
    const result = await window.xleth?.audio?.setBufferSize?.(size)
    if (result && !result.ok) {
      console.error('[AudioDeviceSelector] setBufferSize failed:', result.error)
      await refreshDeviceInfo()
      return
    }
    await window.xleth?.settings?.set(SETTINGS_KEY_BUFFER, size)
    await refreshDeviceInfo()
  }

  const handleSampleRateChange = async (e) => {
    const rate = parseFloat(e.target.value)
    const result = await window.xleth?.audio?.setSampleRate?.(rate)
    if (result && !result.ok) {
      console.error('[AudioDeviceSelector] setSampleRate failed:', result.error)
      await refreshDeviceInfo()
      return
    }
    await window.xleth?.settings?.set(SETTINGS_KEY_RATE, rate)
    await refreshDeviceInfo()
  }

  const bufferSizeOptions = useMemo(() => {
    const opts = []
    if (typeof defaultBufferSize === 'number')
      opts.push({ value: defaultBufferSize, label: `Default (${defaultBufferSize} samples)` })
    for (const size of bufferSizes) {
      if (size === defaultBufferSize) continue
      opts.push({ value: size, label: `${size} samples` })
    }
    return opts
  }, [bufferSizes, defaultBufferSize])

  const openSettings = useCallback(() => {
    const trigger = gearRef.current
    if (!trigger || typeof window === 'undefined') return
    const rect = trigger.getBoundingClientRect()
    const viewportPadding = 8
    const width = 240
    const left = Math.min(rect.left, window.innerWidth - width - viewportPadding)
    setPopoverPos({ left: Math.max(viewportPadding, left), top: rect.bottom + 6 })
    setSettingsOpen(true)
  }, [])

  const closeSettings = useCallback(() => setSettingsOpen(false), [])

  useEffect(() => {
    if (!settingsOpen) return
    const handlePointerDown = (event) => {
      if (gearRef.current?.contains(event.target)) return
      if (popoverRef.current?.contains(event.target)) return
      closeSettings()
    }
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') closeSettings()
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [settingsOpen, closeSettings])

  if (devices.length === 0) return null

  const popover = settingsOpen && popoverPos && typeof document !== 'undefined'
    ? createPortal(
        <div
          ref={popoverRef}
          className="audio-settings-popover"
          style={{ left: popoverPos.left, top: popoverPos.top }}
          onPointerDown={event => event.stopPropagation()}
        >
          <div className="audio-settings-row">
            <label className="audio-settings-label" htmlFor="audio-buffer-size-select">
              Buffer size
            </label>
            <select
              id="audio-buffer-size-select"
              className="audio-settings-select"
              value={bufferSize ?? ''}
              onChange={handleBufferSizeChange}
              title="Trade latency for playback stability"
            >
              {bufferSizeOptions.map(({ value, label }) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          <div className="audio-settings-row">
            <label className="audio-settings-label" htmlFor="audio-sample-rate-select">
              Sample rate
            </label>
            <select
              id="audio-sample-rate-select"
              className="audio-settings-select"
              value={sampleRate ?? ''}
              onChange={handleSampleRateChange}
              title="Device sample rate"
            >
              {sampleRates.length === 0 && sampleRate != null && (
                <option value={sampleRate}>{Math.round(sampleRate)} Hz</option>
              )}
              {sampleRates.map(rate => (
                <option key={rate} value={rate}>{Math.round(rate)} Hz</option>
              ))}
            </select>
          </div>

          <div className="audio-settings-row audio-settings-latency">
            <span className="audio-settings-label">Output latency</span>
            <span className="audio-settings-value">
              {typeof liveLatencyMs === 'number' ? `${liveLatencyMs.toFixed(1)} ms` : '—'}
            </span>
          </div>
        </div>,
        document.body
      )
    : null

  return (
    <div className="audio-device-controls">
      <XlethSelect
        id="transport-audio-device"
        className="transport-device-select"
        value={selected}
        onChange={handleChange}
        options={options}
        ariaLabel="Audio output device"
        placeholder="Audio output"
      />
      <button
        type="button"
        className="audio-rescan-btn"
        aria-label="Rescan audio devices"
        disabled={rescanning}
        onClick={handleRescan}
        title="Rescan for connected audio devices"
      >
        <RefreshCw size={14} aria-hidden="true" className={rescanning ? 'audio-rescan-spin' : ''} />
      </button>
      <button
        ref={gearRef}
        type="button"
        className={`audio-settings-gear-btn${settingsOpen ? ' audio-settings-gear-btn--active' : ''}`}
        aria-label="Audio settings"
        aria-haspopup="dialog"
        aria-expanded={settingsOpen}
        onClick={() => (settingsOpen ? closeSettings() : openSettings())}
        title="Buffer size, sample rate, latency"
      >
        <Settings size={15} aria-hidden="true" />
      </button>
      {popover}
    </div>
  )
}
