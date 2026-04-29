// DEV ONLY - remove before 1.0 or gate permanently behind import.meta.env.DEV.
// Floating theme switcher for visual QA of shipped themes.
// Position: fixed bottom-right, always on top, never affects layout.

import { useTheme } from '../../theming/runtime/ThemeProvider'
import { listShippedThemes, getShippedTheme } from '../../theming/runtime/ThemeLoader'

const THEMES = listShippedThemes()

export default function DevThemeSwitcher() {
  const { theme, setTheme } = useTheme()

  async function handleChange(e) {
    const slug = e.target.value
    const file = getShippedTheme(slug)
    if (file) await setTheme(slug, file)
  }

  const currentSlug = THEMES.find(t => t.name === theme.name)?.slug ?? ''

  return (
    <div style={{
      position: 'fixed',
      bottom: 12,
      right: 12,
      zIndex: 99999,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      background: 'var(--theme-bg-elevated)',
      border: '1px solid var(--theme-border-subtle)',
      borderRadius: 6,
      padding: '4px 8px',
      fontSize: 11,
      color: 'var(--theme-text-muted)',
      boxShadow: 'var(--theme-chrome-shadow)',
      fontFamily: 'inherit',
      userSelect: 'none',
    }}>
      <span>🎨 Theme</span>
      <select
        value={currentSlug}
        onChange={handleChange}
        style={{
          background: 'var(--theme-bg-surface)',
          color: 'var(--theme-text)',
          border: '1px solid var(--theme-border-subtle)',
          borderRadius: 4,
          padding: '2px 4px',
          fontSize: 11,
          fontFamily: 'inherit',
          cursor: 'pointer',
        }}
      >
        {THEMES.map(t => (
          <option key={t.slug} value={t.slug}>{t.name}</option>
        ))}
      </select>
    </div>
  )
}
