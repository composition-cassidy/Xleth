import { useState, useEffect } from 'react'

export default function SettingsPanel({ onClose }) {
  const [stretchMethod, setStretchMethod] = useState(1)   // 1=PSOLA, 2=Rubber, 3=WSOLA, 4=PhaseVocoder
  const [formantPreserve, setFormantPreserve] = useState(false)
  const [spacebarMode, setSpacebarMode] = useState('play-pause')

  useEffect(() => {
    window.xleth.engine.getGlobalStretchMethod().then(m => setStretchMethod(m ?? 1))
    window.xleth.engine.getGlobalFormantPreserve().then(v => setFormantPreserve(!!v))
    window.xleth.settings.get('spacebarMode').then(v => {
      setSpacebarMode(v === 'play-stop' ? 'play-stop' : 'play-pause')
    }).catch(() => {})
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

  async function applySpacebarMode(mode) {
    setSpacebarMode(mode)
    await window.xleth.settings.set('spacebarMode', mode)
    window.dispatchEvent(new CustomEvent('xleth:spacebarMode-changed', { detail: { mode } }))
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
              <option value={2}>Rubber Band</option>
              <option value={3}>WSOLA</option>
              <option value={1}>TD-PSOLA</option>
              <option value={5}>WORLD</option>
              <option value={4}>Phase Vocoder</option>
            </select>
            {stretchMethod === 5 && (
              <div className="settings-panel-hint">
                Best for speech and vocal samples. Processes offline — parameter changes apply after a short analysis step.
              </div>
            )}
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
        <div className="settings-panel-section">
          <div className="settings-panel-section-title">Transport</div>
          <div className="settings-panel-row">
            <label className="settings-panel-label">Spacebar behavior</label>
            <select
              className="settings-panel-select"
              value={spacebarMode}
              onChange={e => applySpacebarMode(e.target.value)}
            >
              <option value="play-pause">Play / Pause</option>
              <option value="play-stop">Play / Stop</option>
            </select>
          </div>
          <div className="settings-panel-hint">
            Play/Pause holds position when stopped. Play/Stop returns to where playback started.
          </div>
        </div>
      </div>
    </div>
  )
}
