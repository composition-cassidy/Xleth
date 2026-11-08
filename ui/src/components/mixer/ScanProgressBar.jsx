import { useEffect, useState, useRef } from 'react'
import useVstStore from '../../stores/vstStore.js'
import { Progress } from '../../ui-kit'

// Polls audio_getScanProgress, fast while a scan runs and slowly when idle.
// Triggers a plugin-list refresh in vstStore on scan completion.
export function useScanProgress() {
  const [state, setState] = useState({ scanning: false, scanned: 0, total: 0 })

  const fetchPlugins = useVstStore(s => s.fetchPlugins)
  const fetchFailed  = useVstStore(s => s.fetchFailed)
  const wasScanning  = useRef(false)

  useEffect(() => {
    // Adaptive polling: fast while scanning, slow when idle. Calling getScanProgress at 2 Hz when idle
    // would cost ~28 unnecessary IPC calls per minute. The N-API main thread is also the JUCE message
    // thread, so every call blocks VST editor timer and paint dispatch for its duration.
    let timerId

    const poll = async () => {
      try {
        const p = await window.xleth?.audio?.getScanProgress?.()
        if (p) {
          setState({ scanning: !!p.scanning, scanned: p.scanned, total: p.total })

          // Completion edge: was scanning last tick, now done
          if (wasScanning.current && !p.scanning) {
            await fetchPlugins()
            await fetchFailed()
          }
          wasScanning.current = p.scanning
        }
      } catch {}

      // 300 ms while scanning for a responsive bar, 2000 ms when idle to minimise IPC load.
      timerId = setTimeout(poll, wasScanning.current ? 300 : 2000)
    }

    timerId = setTimeout(poll, 500)   // initial check after 500 ms
    return () => clearTimeout(timerId)
  }, [fetchPlugins, fetchFailed])

  return state
}

/** A real progress state: the bar fills with scanned / total and the readout says how many. */
export default function ScanProgressBar({ progress }) {
  if (!progress?.scanning) return null
  const { scanned, total } = progress
  return (
    <Progress
      label="Plugin scan"
      value={total > 0 ? scanned / total : null}
      text={total > 0 ? `Scanning ${scanned} of ${total}` : 'Scanning…'}
    />
  )
}
