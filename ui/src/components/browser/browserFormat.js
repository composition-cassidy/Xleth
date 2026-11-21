import { THIN_SPACE } from '../../ui-kit/format'

/**
 * Duration in the Browser's tabular column. A sample is short, so it keeps its
 * decimals ("0.42 s"); a source is long, so it is a clock ("3:24", "1:02:07").
 * One rule per kind so the column never mixes styles.
 */
export function formatSampleDuration(seconds) {
  const s = Number(seconds)
  if (!Number.isFinite(s) || s < 0) return `0.00${THIN_SPACE}s`
  if (s < 60) return `${s.toFixed(2)}${THIN_SPACE}s`
  return formatClock(s)
}

export function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = total % 60
  const ss = String(sec).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** Up/Down/Home/End moves focus between rows marked `data-browser-row` in the list. */
export function moveRowFocus(event) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return false
  const rows = Array.from(event.currentTarget.querySelectorAll('[data-browser-row]'))
  if (rows.length === 0) return false
  const i = rows.indexOf(document.activeElement)
  let next
  if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = rows.length - 1
  else if (event.key === 'ArrowDown') next = i < 0 ? 0 : Math.min(rows.length - 1, i + 1)
  else next = i < 0 ? 0 : Math.max(0, i - 1)
  event.preventDefault()
  rows[next].focus()
  return true
}
