import { useState } from 'react'
import LoopLab from './LoopLab.jsx'
import './loopLab.css'

// DEV-only mount point for Loop Lab: a small fixed launcher button that toggles
// the authoring overlay. Rendered from XlethRoot behind import.meta.env.DEV, so
// it never ships in production builds.
export default function LoopLabDevMount() {
  const [open, setOpen] = useState(false)
  return (
    <>
      {!open && (
        <button className="ll-launcher" onClick={() => setOpen(true)} title="Loop Lab (dev)">
          🔁 Loop Lab
        </button>
      )}
      {open && <LoopLab onClose={() => setOpen(false)} />}
    </>
  )
}
