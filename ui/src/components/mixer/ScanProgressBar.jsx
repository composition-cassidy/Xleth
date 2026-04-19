import { useEffect, useState, useRef } from 'react'
import useVstStore from '../../stores/vstStore.js'

// Polls audio_getScanProgress every 500 ms.
// Renders a thin progress bar while a scan is running; disappears when done.
// Triggers a plugin-list refresh in vstStore on scan completion.

export default function ScanProgressBar() {
  const [scanning, setScanning] = useState(false)
  const [scanned, setScanned]   = useState(0)
  const [total, setTotal]       = useState(0)

  const fetchPlugins = useVstStore(s => s.fetchPlugins)
  const fetchFailed  = useVstStore(s => s.fetchFailed)
  const wasScanning  = useRef(false)

  useEffect(() => {
    // Adaptive polling — fast while scanning, slow when idle.
    // Calling getScanProgress at 2 Hz when idle saves ~28 unnecessary IPC calls
    // per minute. Recall: the N-API main thread is also the JUCE message thread;
    // every call blocks VST editor timer/paint dispatch for its duration.
    let timerId

    const poll = async () => {
      try {
        const p = await window.xleth?.audio?.getScanProgress?.()
        if (p) {
          setScanning(p.scanning)
          setScanned(p.scanned)
          setTotal(p.total)

          // Completion edge: was scanning last tick, now done
          if (wasScanning.current && !p.scanning) {
            await fetchPlugins()
            await fetchFailed()
          }
          wasScanning.current = p.scanning
        }
      } catch {}

      // Poll at 300 ms while scanning for responsive progress bar,
      // fall back to 2000 ms when idle to minimise IPC load.
      timerId = setTimeout(poll, wasScanning.current ? 300 : 2000)
    }

    timerId = setTimeout(poll, 500)   // initial check after 500 ms
    return () => clearTimeout(timerId)
  }, [fetchPlugins, fetchFailed])

  if (!scanning) return null

  const pct = total > 0 ? Math.round((scanned / total) * 100) : 0

  return (
    <div className="scan-progress-bar">
      <span className="scan-progress-label">Scanning… ({scanned} / {total})</span>
      <div className="scan-progress-track">
        <div className="scan-progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
