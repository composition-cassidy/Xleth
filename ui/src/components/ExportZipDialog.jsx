import React from 'react'

// Stub — ZIP export dialog not yet implemented.
export default function ExportZipDialog({ isOpen, onClose }) {
  if (!isOpen) return null
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)' }}>
      <div style={{ background: 'var(--theme-bg-surface, #1a1a24)', padding: '24px', borderRadius: '8px', color: 'var(--theme-text, #e8e8ed)', minWidth: '320px' }}>
        <p>ZIP export is not yet available.</p>
        <button onClick={onClose} style={{ marginTop: '16px', padding: '6px 16px', cursor: 'pointer' }}>Close</button>
      </div>
    </div>
  )
}
