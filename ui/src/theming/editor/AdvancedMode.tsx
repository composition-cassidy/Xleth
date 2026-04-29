import { useMemo } from 'react'
import { CATEGORIES, SUBSYSTEMS, tokensBySubsystem } from '../tokens/catalog'
import type { ThemeFile } from '../schema/types'
import TokenCategoryTree from './TokenCategoryTree'

interface Props {
  workingTheme: ThemeFile
  resolvedValues: Record<string, string>
  onTokenChange: (name: string, value: string) => void
  onDetachToggle: (name: string) => void
}

export default function AdvancedMode({ workingTheme, resolvedValues, onTokenChange, onDetachToggle }: Props) {
  const bySubsystem = useMemo(() => tokensBySubsystem(), [])
  const detachedSet = useMemo(
    () => new Set(workingTheme.derivationDetached ?? []),
    [workingTheme.derivationDetached]
  )

  return (
    <div className="advanced-mode">
      {CATEGORIES.map(cat => {
        const subsystems = SUBSYSTEMS.filter(s => s.category === cat)
        return (
          <TokenCategoryTree
            key={cat}
            category={cat}
            subsystems={subsystems}
            bySubsystem={bySubsystem}
            resolvedValues={resolvedValues}
            detachedSet={detachedSet}
            onTokenChange={onTokenChange}
            onDetachToggle={onDetachToggle}
          />
        )
      })}
    </div>
  )
}
