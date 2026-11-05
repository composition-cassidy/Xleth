import { Loader2 } from 'lucide-react'

/**
 * Small non-blocking progress badge for a batch of background proxy work
 * (on-open codec migration, or rebuilding previews that were purged / never
 * generated). Purely informational: pointer-events are off (see
 * .proxy-migration-badge) so it never steals canvas clicks, and nothing waits
 * on it.
 *
 * `batch` is one of proxy.getStatus()'s { migration, rebuild } objects:
 * { total, completed, failed, progress (0..1) }. `pct` is progress as 0..100.
 */
export default function ProxyBatchBadge({ label, title, batch, pct, testId }) {
  return (
    <div
      className="proxy-migration-badge"
      role="status"
      aria-live="polite"
      title={title}
      data-testid={testId}
    >
      <Loader2 size={12} className="poster-load-spin" />
      <span className="proxy-migration-label">{label}</span>
      <span className="proxy-migration-count">
        {Math.min(batch.completed + 1, batch.total)} / {batch.total}
        {' · '}{pct}%
      </span>
      <div className="proxy-migration-bar">
        <div className="proxy-migration-bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
