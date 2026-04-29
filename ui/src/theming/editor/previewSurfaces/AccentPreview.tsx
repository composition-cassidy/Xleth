export default function AccentPreview() {
  return (
    <div className="ps-card">
      <div className="ps-label">Accent</div>
      <div className="ps-accent-row">
        <button className="ps-btn-primary">Apply</button>
        <button className="ps-btn-ghost">Cancel</button>
      </div>
      <div className="ps-accent-chips">
        <div className="ps-chip" style={{ background: 'var(--theme-accent-bg-subtle)', color: 'var(--theme-accent)', border: '1px solid var(--theme-accent)' }}>
          Active
        </div>
        <div className="ps-chip" style={{ background: 'var(--theme-accent-bg-medium)', color: 'var(--theme-accent)' }}>
          Selected
        </div>
      </div>
    </div>
  )
}
