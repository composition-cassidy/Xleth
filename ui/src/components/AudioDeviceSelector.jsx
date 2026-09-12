import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Settings } from 'lucide-react'
import XlethSelect from './common/XlethSelect.jsx'

const STORAGE_KEY = 'xleth-audio-device'
const BUFFER_SIZE_OPTIONS = [128, 256, 512, 1024, 2048]

// Buffer size and sample rate are hardware properties of this machine, not of
// the project — persisted the same way previewResolutionScale is: through the
// generic settings store (xleth-settings.json), never into project.json.
const SETTINGS_KEY_BUFFER = 'audioBufferSize'
const SETTINGS_KEY_RATE   = 'audioSampleRate'

export default function AudioDeviceSelector() {
  const [devices, setDevices] = useState([])
  const [selected, setSelected] = useState('')

  const [sampleRates, setSampleRates] = useState([])
  const [bufferSize, setBufferSizeState] = useState(null)
  const [sampleRate, setSampleRateState] = useState(null)
  const [latencyMs, setLatencyMs] = useState(null)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [popoverPos, setPopoverPos] = useState(null)
  const gearRef = useRef(null)
  const popoverRef = useRef(null)

  const refreshDeviceInfo = useCallback(async () => {
    const info = await window.xleth?.audio?.getDeviceInfo?.()
    if (!info) return
    setBufferSizeState(info.bufferSize ?? null)
    setSampleRateState(info.sampleRate ?? null)
    setLatencyMs(typeof info.latencyMs === 'number' ? info.latencyMs : null)
  }, [])

  useEffect(() => {
    async function init() {
      const list = await window.xleth?.audio?.getOutputDevices?.() ?? []
      setDevices(list)
      const saved   = localStorage.getItem(STORAGE_KEY)
      const current = await window.xleth?.audio?.getCurrentOutputDevice?.() ?? ''
      const initial = (saved && list.includes(saved)) ? saved : current
      setSelected(initial)
      // Apply saved preference if it differs from what the engine opened
      if (saved && list.includes(saved) && saved !== current) {
        await window.xleth.audio.setOutputDevice(saved)
      }

      const rates = await window.xleth?.audio?.getSupportedSampleRates?.() ?? []
      setSampleRates(rates)

      // Restore per-machine buffer size / sample rate preference. Each apply
      // reuses the same device-change reconfigure path setOutputDevice does
      // (AudioEngine::setBufferSize / setSampleRate -> setAudioDeviceSetup),
      // so a bad restored value surfaces as a normal {ok:false, error} rather
      // than silently leaving the engine on a different config than shown.
      const savedBuffer = await window.xleth?.settings?.get(SETTINGS_KEY_BUFFER)
      const savedRate   = await window.xleth?.settings?.get(SETTINGS_KEY_RATE)
      if (typeof savedBuffer === 'number' && BUFFER_SIZE_OPTIONS.includes(savedBuffer)) {
        const result = await window.xleth?.audio?.setBufferSize?.(savedBuffer)
        if (result && !result.ok)
          console.error('[AudioDeviceSelector] restore buffer size failed:', result.error)
      }
      if (typeof savedRate === 'number' && rates.includes(savedRate)) {
        const result = await window.xleth?.audio?.setSampleRate?.(savedRate)
        if (result && !result.ok)
          console.error('[AudioDeviceSelector] restore sample rate failed:', result.error)
      }

      await refreshDeviceInfo()
    }
    init()
  }, [refreshDeviceInfo])

  const options = useMemo(
    () => devices.map(device => ({ value: device, label: device })),
    [devices]
  )

  const handleChange = async (name) => {
    setSelected(name)
    localStorage.setItem(STORAGE_KEY, name)
    const result = await window.xleth?.audio?.setOutputDevice?.(name)
    if (result && !result.ok)
      console.error('[AudioDeviceSelector] switch failed:', result.error)
    // A device switch can change the supported-rate list and the reopened
    // device's actual buffer/rate/latency — refresh everything the popover shows.
    const rates = await window.xleth?.audio?.getSupportedSampleRates?.() ?? []
    setSampleRates(rates)
    await refreshDeviceInfo()
  }

  const handleBufferSizeChange = async (e) => {
    const size = parseInt(e.target.value, 10)
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
              {BUFFER_SIZE_OPTIONS.map(size => (
                <option key={size} value={size}>{size} samples</option>
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
            <span className="audio-settings-label">Reported latency</span>
            <span className="audio-settings-value">
              {typeof latencyMs === 'number' ? `${latencyMs.toFixed(1)} ms` : '—'}
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
