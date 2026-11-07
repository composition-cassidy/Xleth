import { useId, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import useBrowserStore from '../../stores/browserStore.js'
import styles from './Browser.module.css'

/**
 * The Browser's search field. Typing filters live; Enter (or leaving the field
 * with text in it) remembers the search, and an empty focused field offers the
 * recent ones for this tab.
 */
export default function SearchField({ tab, value, onChange, placeholder, ariaLabel }) {
  const listId = useId()
  const inputRef = useRef(null)
  const [open, setOpen] = useState(false)
  const history = useBrowserStore((s) => s.history[tab])
  const pushHistory = useBrowserStore((s) => s.pushHistory)
  const clearHistory = useBrowserStore((s) => s.clearHistory)

  const showHistory = open && value === '' && history.length > 0

  const commit = () => { if (value.trim()) pushHistory(tab, value) }

  const choose = (query) => {
    onChange(query)
    pushHistory(tab, query)
    setOpen(false)
    inputRef.current?.focus()
  }

  return (
    <div className={styles.search}>
      <Search size={12} className={styles.searchGlyph} aria-hidden="true" />
      <input
        ref={inputRef}
        type="text"
        className={styles.searchInput}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-controls={showHistory ? listId : undefined}
        aria-expanded={showHistory}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => { commit(); setOpen(false) }}
        onKeyDown={(e) => {
          e.stopPropagation()  // typing here must never reach transport or tool shortcuts
          if (e.key === 'Enter') { commit(); setOpen(false) }
          if (e.key === 'Escape') {
            if (value !== '') onChange('')
            else inputRef.current?.blur()
          }
        }}
        data-hint="Search by name"
        data-hint-mods="Enter: remember search · Esc: clear"
      />
      {value !== '' && (
        <button
          type="button"
          className={styles.searchClear}
          aria-label="Clear search"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { onChange(''); inputRef.current?.focus() }}
        >
          <X size={12} aria-hidden="true" />
        </button>
      )}
      {showHistory && (
        <ul id={listId} className={styles.history} role="listbox" aria-label="Recent searches">
          {history.map((query) => (
            <li key={query} role="option" aria-selected="false">
              {/* mousedown, not click: the input's blur would close the list first */}
              <button
                type="button"
                className={styles.historyItem}
                onMouseDown={(e) => { e.preventDefault(); choose(query) }}
              >
                {query}
              </button>
            </li>
          ))}
          <li role="presentation">
            <button
              type="button"
              className={`${styles.historyItem} ${styles.historyClear}`}
              onMouseDown={(e) => { e.preventDefault(); clearHistory(tab); setOpen(false) }}
            >
              Clear recent searches
            </button>
          </li>
        </ul>
      )}
    </div>
  )
}
