import { useCallback, useId, useMemo, useState } from 'react'
import useVstStore from '../../stores/vstStore.js'
import { deviceName } from '../devices/deviceNames.js'
import { insertLabel, insertRows } from './mixerMath.js'
import styles from './MixerStrip.module.css'

/**
 * A strip's inserts, by name (ui/DESIGN.md 10): `rows` 16px rows, the last one
 * "+N more" when the chain is longer. The list is ONE control, a listbox at
 * least 24px in both directions: the row under the pointer (or the arrow-key
 * row) is the device it opens in the Devices tab. Empty rows are wells and open
 * the chain itself. Names come from the chain cache the strip already fills
 * (`useEffectChainStore.chains`), through the device title bar's own name map.
 */
export default function InsertList({ name, chain, fxMode, rows = 5, onOpen }) {
  const vstPlugins = useVstStore((s) => s.plugins)
  const list = useMemo(
    () => insertRows(chain, fxMode, rows, (effect) => deviceName(effect, vstPlugins)),
    [chain, fxMode, rows, vstPlugins],
  )
  const filled = useMemo(() => list.map((row, i) => (row ? i : -1)).filter((i) => i >= 0), [list])
  const [active, setActive] = useState(0)
  const baseId = useId()
  const activeRow = filled.includes(active) ? active : (filled[0] ?? -1)

  const open = useCallback((rowIndex) => {
    const row = rowIndex >= 0 ? list[rowIndex] : null
    onOpen?.(row ? row.index : null)
  }, [list, onOpen])

  const handleClick = useCallback((e) => {
    e.stopPropagation()
    const el = e.target.closest?.('[data-insert-row]')
    const rowIndex = el ? Number(el.getAttribute('data-insert-row')) : -1
    if (rowIndex >= 0 && list[rowIndex]) setActive(rowIndex)
    open(rowIndex >= 0 && list[rowIndex] ? rowIndex : -1)
  }, [list, open])

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (filled.length === 0) return
      e.preventDefault()
      const at = Math.max(0, filled.indexOf(activeRow))
      const next = e.key === 'ArrowDown' ? Math.min(filled.length - 1, at + 1) : Math.max(0, at - 1)
      setActive(filled[next])
    } else if (e.key === 'Home' || e.key === 'End') {
      if (filled.length === 0) return
      e.preventDefault()
      setActive(e.key === 'Home' ? filled[0] : filled[filled.length - 1])
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      e.stopPropagation()
      open(activeRow)
    }
  }, [filled, activeRow, open])

  const summary = insertLabel(chain, fxMode)
  return (
    <div
      className={styles.inserts}
      role="listbox"
      tabIndex={0}
      aria-label={`${name} inserts: ${summary}`}
      aria-activedescendant={activeRow >= 0 ? `${baseId}-${activeRow}` : undefined}
      data-testid="mixer-inserts"
      data-hint={`Inserts on ${name}: ${summary}. A name opens that device in the Devices tab.`}
      data-hint-mods="Click or Enter: open · Up / Down: move · Right-click the strip: chain menu"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      {list.map((row, i) => (row ? (
        <div
          // Rows are positional: a row is "the i-th slot", whatever sits in it.
          key={i}
          id={`${baseId}-${i}`}
          role="option"
          aria-selected={i === activeRow}
          className={styles.insert}
          data-insert-row={i}
          data-off={row.off || undefined}
          data-more={row.more || undefined}
          title={row.off ? `${row.text} (bypassed)` : row.text}
        >
          {row.text}
        </div>
      ) : (
        <div key={i} className={styles.insert} data-insert-row={i} data-empty="true" aria-hidden="true" />
      )))}
    </div>
  )
}
