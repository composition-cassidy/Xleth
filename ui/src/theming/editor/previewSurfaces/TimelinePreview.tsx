const TRACKS = [
  { name: 'Vocals', color: 'var(--theme-accent)' },
  { name: 'Drums',  color: 'var(--theme-smartbalance-band-sub)' },
  { name: 'Bass',   color: 'var(--theme-smartbalance-band-lowmid)' },
]

export default function TimelinePreview() {
  return (
    <div className="ps-card">
      <div className="ps-label">Timeline</div>
      <div className="ps-timeline-tracks">
        {TRACKS.map(t => (
          <div key={t.name} className="ps-track-row">
            <div className="ps-track-header">
              <div className="ps-track-dot" style={{ background: t.color }} />
              <span className="ps-track-name">{t.name}</span>
            </div>
            <div className="ps-track-clip" style={{ background: t.color + '33', border: `1px solid ${t.color}` }} />
          </div>
        ))}
      </div>
    </div>
  )
}
