import type { KeyboardEvent } from 'react'
import { listShippedThemes } from '../runtime/ThemeLoader'
import styles from './ThemeEditor.module.css'

const SHIPPED = listShippedThemes()

export interface UserThemeMeta {
  slug: string
  name: string
}

interface Props {
  selectedSlug: string
  onSelect: (slug: string) => void
  userThemes: UserThemeMeta[]
}

function Item({ slug, name, badge, selected, onSelect }: {
  slug: string
  name: string
  badge?: string
  selected: boolean
  onSelect: (slug: string) => void
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect(slug)
    }
  }
  return (
    <li
      role="option"
      aria-selected={selected}
      tabIndex={0}
      className={styles.listItem}
      onClick={() => onSelect(slug)}
      onKeyDown={onKeyDown}
    >
      <span className={styles.listName}>{name}</span>
      {badge ? <span className={styles.badge}>{badge}</span> : null}
    </li>
  )
}

export default function ThemeList({ selectedSlug, onSelect, userThemes }: Props) {
  return (
    <div className={styles.list}>
      <div className={styles.listHeader}>Themes</div>
      <ul className={styles.listItems} role="listbox" aria-label="Themes">
        {SHIPPED.map(t => (
          <Item key={t.slug} slug={t.slug} name={t.name} badge="Built-in" selected={t.slug === selectedSlug} onSelect={onSelect} />
        ))}

        {userThemes.length > 0 && (
          <>
            <li role="presentation" className={styles.listGroup}>Custom</li>
            {userThemes.map(t => (
              <Item key={t.slug} slug={t.slug} name={t.name} selected={t.slug === selectedSlug} onSelect={onSelect} />
            ))}
          </>
        )}
      </ul>
    </div>
  )
}
