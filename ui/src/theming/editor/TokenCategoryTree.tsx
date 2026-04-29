import { useState } from 'react'
import type { SubsystemMeta, TokenDef } from '../tokens/catalog'
import TokenRow from './TokenRow'

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
    <div className="tct-category">
      <button className="tct-category-header" onClick={() => setCategoryOpen(o => !o)}>
        <span className="tct-chevron">{categoryOpen ? '▾' : '▸'}</span>
        <span className="tct-category-label">{category}</span>
      </button>

      {categoryOpen && relevantSubs.map(sub => {
        const tokens = bySubsystem[sub.key] ?? []
        const isOpen = openSubs.has(sub.key)
        return (
          <div key={sub.key} className="tct-subsystem">
            <button
              className={`tct-subsystem-header ${sub.plannedDeferred ? 'tct-subsystem-header--deferred' : ''}`}
              onClick={() => toggleSub(sub.key)}
            >
              <span className="tct-chevron">{isOpen ? '▾' : '▸'}</span>
              <span className="tct-subsystem-label">
                {sub.displayName}
                {sub.plannedDeferred && <span className="tct-deferred-badge"> (coming soon)</span>}
              </span>
              <span className="tct-token-count">{tokens.length}</span>
            </button>
            {isOpen && (
              <div className="tct-token-list">
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
