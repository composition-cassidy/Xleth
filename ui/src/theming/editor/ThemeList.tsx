import { listShippedThemes } from '../runtime/ThemeLoader'

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

export default function ThemeList({ selectedSlug, onSelect, userThemes }: Props) {
  return (
    <div className="theme-list">
      <div className="theme-list-header">Themes</div>
      <ul className="theme-list-items">
        {SHIPPED.map(t => (
          <li
            key={t.slug}
            className={`theme-list-item ${t.slug === selectedSlug ? 'theme-list-item--active' : ''}`}
            onClick={() => onSelect(t.slug)}
          >
            <span className="theme-list-name">{t.name}</span>
            <span className="theme-list-badge">built-in</span>
          </li>
        ))}

        {userThemes.length > 0 && (
          <>
            <li className="theme-list-divider">Custom</li>
            {userThemes.map(t => (
              <li
                key={t.slug}
                className={`theme-list-item ${t.slug === selectedSlug ? 'theme-list-item--active' : ''}`}
                onClick={() => onSelect(t.slug)}
              >
                <span className="theme-list-name">{t.name}</span>
              </li>
            ))}
          </>
        )}
      </ul>
    </div>
  )
}
