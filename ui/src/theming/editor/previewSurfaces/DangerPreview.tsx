export default function DangerPreview() {
  return (
    <div className="ps-card">
      <div className="ps-label">Danger / Status</div>
      <div className="ps-status-stack">
        <div className="ps-status-row" style={{ background: 'var(--theme-semantic-danger-bg-subtle)', border: '1px solid var(--theme-danger)', borderRadius: 4, padding: '4px 8px' }}>
          <span style={{ color: 'var(--theme-semantic-danger-text)', fontSize: 11 }}>⚠ Error state</span>
        </div>
        <div className="ps-status-row" style={{ background: 'var(--theme-semantic-warning-bg-subtle)', border: '1px solid var(--theme-semantic-warning-border)', borderRadius: 4, padding: '4px 8px' }}>
          <span style={{ color: 'var(--theme-semantic-warning-text)', fontSize: 11 }}>⚡ Warning state</span>
        </div>
        <div className="ps-status-row" style={{ border: '1px solid var(--theme-semantic-success-border)', borderRadius: 4, padding: '4px 8px' }}>
          <span style={{ color: 'var(--theme-semantic-success-border)', fontSize: 11 }}>✓ Success state</span>
        </div>
      </div>
    </div>
  )
}
