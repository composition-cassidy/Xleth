export default function SurfacePreview() {
  return (
    <div className="ps-card">
      <div className="ps-label">Surfaces</div>
      <div className="ps-surface-stack">
        <div className="ps-swatch" style={{ background: 'var(--theme-bg-primary)' }}>
          <span className="ps-swatch-label">Primary</span>
        </div>
        <div className="ps-swatch" style={{ background: 'var(--theme-bg-surface)' }}>
          <span className="ps-swatch-label">Surface</span>
        </div>
        <div className="ps-swatch" style={{ background: 'var(--theme-bg-secondary)' }}>
          <span className="ps-swatch-label">Secondary</span>
        </div>
        <div className="ps-swatch" style={{ background: 'var(--theme-bg-tertiary)' }}>
          <span className="ps-swatch-label">Tertiary</span>
        </div>
      </div>
    </div>
  )
}
