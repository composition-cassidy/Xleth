export function normalizeSelection(inPoint, outPoint, minDuration = 0.01) {
  if (inPoint === null || outPoint === null) return null
  if (!Number.isFinite(inPoint) || !Number.isFinite(outPoint)) return null

  const start = Math.min(inPoint, outPoint)
  const end = Math.max(inPoint, outPoint)
  const duration = end - start
  if (duration < minDuration) return null

  return { start, end, duration }
}
