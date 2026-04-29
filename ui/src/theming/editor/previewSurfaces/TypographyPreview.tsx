export default function TypographyPreview() {
  return (
    <div className="ps-card">
      <div className="ps-label">Typography</div>
      <div className="ps-type-stack">
        <span style={{ color: 'var(--theme-text-primary)', fontSize: 13, fontWeight: 600 }}>Primary text</span>
        <span style={{ color: 'var(--theme-text-secondary)', fontSize: 12 }}>Secondary text</span>
        <span style={{ color: 'var(--theme-text-muted)', fontSize: 11 }}>Muted / labels</span>
        <span style={{ color: 'var(--theme-accent)', fontSize: 12 }}>Accent link</span>
      </div>
    </div>
  )
}
