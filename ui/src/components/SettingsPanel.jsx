import { useState, useEffect } from 'react'

export default function SettingsPanel({ onClose }) {
  const [stretchMethod, setStretchMethod] = useState(1)   // 1=PSOLA, 2=Rubber, 3=WSOLA, 4=PhaseVocoder
  const [formantPreserve, setFormantPreserve] = useState(false)

  useEffect(() => {
    window.xleth.engine.getGlobalStretchMethod().then(m => setStretchMethod(m ?? 1))
    window.xleth.engine.getGlobalFormantPreserve().then(v => setFormantPreserve(!!v))
  }, [])

  async function applyStretchMethod(m) {
    console.log('[UISettings] globalStretchMethod changed:', m)
    setStretchMethod(m)
    await window.xleth.engine.setGlobalStretchMethod(m)
    await window.xleth.settings.set('globalStretchMethod', m)
  }

  async function applyFormant(v) {
    console.log('[UISettings] globalFormantPreserve changed:', v)
    setFormantPreserve(v)
    await window.xleth.engine.setGlobalFormantPreserve(v)
    await window.xleth.settings.set('globalFormantPreserve', v)
  }

  return (
    <div className="settings-panel-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-panel-header">
          <span>Settings</span>
          <button className="settings-panel-close" onClick={onClose}>✕</button>
        </div>
        <div className="settings-panel-section">
          <div className="settings-panel-section-title">Clip Processing</div>
          <div className="settings-panel-row">
            <label className="settings-panel-label">Default Stretch Method</label>
            <select
              className="settings-panel-select"
              value={stretchMethod}
              onChange={e => applyStretchMethod(Number(e.target.value))}
            >
              <option value={1}>TD-PSOLA</option>
              <option value={2}>Rubber Band</option>
              <option value={3}>WSOLA</option>
              <option value={4}>Phase Vocoder</option>
            </select>
          </div>
          <div className="settings-panel-row">
            <label className="settings-panel-label">Formant Preservation</label>
            <input
              type="checkbox"
              className="settings-panel-checkbox"
              checked={formantPreserve}
              onChange={e => applyFormant(e.target.checked)}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
