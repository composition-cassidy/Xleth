import { useState, useEffect, useMemo } from 'react'
import XlethSelect from './common/XlethSelect.jsx'

const STORAGE_KEY = 'xleth-audio-device'

export default function AudioDeviceSelector() {
  const [devices, setDevices] = useState([])
  const [selected, setSelected] = useState('')

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
        window.xleth.audio.setOutputDevice(saved)
      }
    }
    init()
  }, [])

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
  }

  if (devices.length === 0) return null

  return (
    <XlethSelect
      id="transport-audio-device"
      className="transport-device-select"
      value={selected}
      onChange={handleChange}
      options={options}
      ariaLabel="Audio output device"
      placeholder="Audio output"
    />
  )
}
