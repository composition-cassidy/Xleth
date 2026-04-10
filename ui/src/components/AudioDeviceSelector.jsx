import { useState, useEffect } from 'react'

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

  const handleChange = async (e) => {
    const name = e.target.value
    setSelected(name)
    localStorage.setItem(STORAGE_KEY, name)
    const result = await window.xleth?.audio?.setOutputDevice?.(name)
    if (result && !result.ok)
      console.error('[AudioDeviceSelector] switch failed:', result.error)
  }

  if (devices.length === 0) return null

  return (
    <select
      className="transport-device-select"
      value={selected}
      onChange={handleChange}
      title="Audio output device"
    >
      {devices.map(d => (
        <option key={d} value={d}>{d}</option>
      ))}
    </select>
  )
}
