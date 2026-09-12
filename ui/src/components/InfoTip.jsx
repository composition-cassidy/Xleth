import React from 'react'
import { Info } from 'lucide-react'

// Small inline info glyph that carries an explainer paragraph as a native
// title tooltip instead of a permanent block of body text. Keeps helper
// copy discoverable without spending vertical space on it.
export default function InfoTip({ text }) {
  if (!text) return null
  return (
    <span className="info-tip" title={text} tabIndex={0} aria-label={text}>
      <Info size={12} />
    </span>
  )
}
