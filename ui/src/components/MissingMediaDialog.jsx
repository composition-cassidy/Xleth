import React from 'react'

// Stub — Missing Media relink dialog not yet implemented.
// Props:
//   media   – array of { sourceId, filePath, found, error, displayName?, kind? }
//   onClose – called when dialog is dismissed
export default function MissingMediaDialog({ media, onClose }) {
  if (!media || media.length === 0) return null
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)' }}>
      <div style={{ background: 'var(--theme-bg-surface, #1a1a24)', padding: '24px', borderRadius: '8px', color: 'var(--theme-text, #e8e8ed)', minWidth: '400px', maxWidth: '600px' }}>
        <h3 style={{ marginTop: 0 }}>Missing Media ({media.length})</h3>
        <ul style={{ maxHeight: '240px', overflowY: 'auto', paddingLeft: '16px' }}>
          {media.map((m) => (
            <li key={m.sourceId ?? m.regionId} style={{ marginBottom: '8px', fontSize: '13px', opacity: 0.8 }}>
              {m.displayName || m.filePath}
              {m.error ? <span style={{ color: 'var(--theme-danger, #ff4757)', marginLeft: '8px' }}>{m.error}</span> : null}
            </li>
          ))}
        </ul>
        <button onClick={onClose} style={{ marginTop: '16px', padding: '6px 16px', cursor: 'pointer' }}>Ignore All</button>
      </div>
    </div>
  )
}
