import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { SubsystemMeta, TokenDef } from '../tokens/catalog'
import TokenRow from './TokenRow'
import styles from './ThemeEditor.module.css'

interface Props {
  category: string
  subsystems: ReadonlyArray<SubsystemMeta>
  bySubsystem: Record<string, TokenDef[]>
  resolvedValues: Record<string, string>
  detachedSet: ReadonlySet<string>
  onTokenChange: (name: string, value: string) => void
  onDetachToggle: (name: string) => void
}

export default function TokenCategoryTree({
  category, subsystems, bySubsystem, resolvedValues, detachedSet, onTokenChange, onDetachToggle
}: Props) {
  const [categoryOpen, setCategoryOpen] = useState(true)
  const [openSubs, setOpenSubs] = useState<ReadonlySet<string>>(new Set())

  const toggleSub = (key: string) =>
    setOpenSubs(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })

  const relevantSubs = subsystems.filter(s => (bySubsystem[s.key]?.length ?? 0) > 0)
  if (relevantSubs.length === 0) return null

  return (
    <div className={styles.category}>
      <button type="button" className={styles.treeHeader} aria-expanded={categoryOpen} onClick={() => setCategoryOpen(o => !o)}>
        {categoryOpen ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
        <span className={styles.categoryName}>{category}</span>
      </button>

      {categoryOpen && relevantSubs.map(sub => {
        const tokens = bySubsystem[sub.key] ?? []
        const isOpen = openSubs.has(sub.key)
        return (
          <div key={sub.key} className={styles.subsystem}>
            <button type="button" className={styles.treeHeader} aria-expanded={isOpen} onClick={() => toggleSub(sub.key)}>
              {isOpen ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
              <span className={styles.subName} data-deferred={sub.plannedDeferred || undefined}>
                {sub.displayName}
                {sub.plannedDeferred && ' (coming soon)'}
              </span>
              <span className={styles.count}>{tokens.length}</span>
            </button>
            {isOpen && (
              <div className={styles.tokens}>
                {tokens.map(token => (
                  <TokenRow
                    key={token.name}
                    token={token}
                    resolvedValue={resolvedValues[token.name] ?? ''}
                    isDetached={detachedSet.has(token.name)}
                    isReadOnly={sub.plannedDeferred ?? false}
                    onTokenChange={onTokenChange}
                    onDetachToggle={onDetachToggle}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
