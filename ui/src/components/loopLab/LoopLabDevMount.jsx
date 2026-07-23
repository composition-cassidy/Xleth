import { useState } from 'react'
import LoopLab from './LoopLab.jsx'
import './loopLab.css'

// DEV-only mount point for Loop Lab: a small fixed launcher button that toggles
// the authoring overlay. Rendered from XlethRoot behind import.meta.env.DEV, so
// it never ships in production builds.
export default function LoopLabDevMount() {
  const [open, setOpen] = useState(false)

  // Dev-menu action: save a copy of the AUTO-loop telemetry JSONL. The log is
  // written by the sampler AUTO button (apply + nudge events); this is the
  // "Export loop telemetry" affordance the feature calls for.
  const exportTelemetry = async () => {
    try {
      const res = await window.xleth?.loopTelemetry?.export?.()
      if (res?.ok) console.log('[loopTelemetry] exported to', res.path)
      else if (res && !res.canceled) console.warn('[loopTelemetry] export:', res.error)
    } catch (e) { console.warn('[loopTelemetry] export failed:', e?.message) }
  }

  return (
    <>
      {!open && (
        <div className="ll-launcher-group">
          <button className="ll-launcher" onClick={() => setOpen(true)} title="Loop Lab (dev)">
            🔁 Loop Lab
          </button>
          <button className="ll-launcher" onClick={exportTelemetry} title="Export AUTO-loop telemetry (dev)">
            📈 Export loop telemetry
          </button>
        </div>
      )}
      {open && <LoopLab onClose={() => setOpen(false)} />}
    </>
  )
}
