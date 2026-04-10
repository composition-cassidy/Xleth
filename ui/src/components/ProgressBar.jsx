/**
 * Simple progress bar.
 *
 * Props:
 *   progress     – 0..1 for determinate, or null/undefined for indeterminate shimmer
 *   className    – optional extra class
 */
export default function ProgressBar({ progress, className = '' }) {
  const indeterminate = progress == null || progress < 0

  return (
    <div className={`progress-bar ${className}`}>
      {indeterminate ? (
        <div className="progress-bar-fill progress-bar-indeterminate" />
      ) : (
        <div
          className="progress-bar-fill"
          style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }}
        />
      )}
    </div>
  )
}
