const CHANNELS = ['Kick', 'Bass', 'Lead', 'FX']

export default function MixerPreview() {
  return (
    <div className="ps-card">
      <div className="ps-label">Mixer</div>
      <div className="ps-mixer-row">
        {CHANNELS.map(ch => (
          <div key={ch} className="ps-mixer-channel">
            <div className="ps-mixer-fader-track">
              <div className="ps-mixer-fader-thumb" />
            </div>
            <div className="ps-mixer-ch-label">{ch}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
