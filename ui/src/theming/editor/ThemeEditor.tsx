import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useTheme } from '../runtime/ThemeProvider'
import { getShippedTheme, DEFAULT_THEME_NAME } from '../runtime/ThemeLoader'
import { resolveTheme } from '../runtime/applyTheme'
import type { ThemeFile } from '../schema/types'
import ThemeList, { type UserThemeMeta } from './ThemeList'
import SimpleMode from './SimpleMode'
import AdvancedMode from './AdvancedMode'
import PreviewPane from './PreviewPane'

interface Props {
  onClose: () => void
}

const xlethTheme = () => (window as any).xleth?.theme

const isShippedSlug = (slug: string) => Boolean(getShippedTheme(slug))

function slugify(name: string): string {
  return 'user-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    + '-' + Date.now().toString(36)
}

function makeWorking(slug: string): ThemeFile {
  const file = getShippedTheme(slug)
  if (!file) return { schemaVersion: 1, name: slug, locked: false, derivationDetached: [], tokens: {} }
  return { ...file, locked: false }
}

function makeWorkingFromActive(active: ThemeFile): ThemeFile {
  return { ...active, locked: false }
}

export default function ThemeEditor({ onClose }: Props) {
  const { slug: activeSlug, theme: activeTheme, setTheme } = useTheme()

  const [originalSlug] = useState<string>(() => activeSlug ?? DEFAULT_THEME_NAME)

  const [selectedSlug, setSelectedSlug] = useState<string>(originalSlug)
  const [workingTheme, setWorkingTheme] = useState<ThemeFile>(() => makeWorkingFromActive(activeTheme))
  const [activeTab, setActiveTab] = useState<'simple' | 'advanced'>('simple')
  const [userThemes, setUserThemes] = useState<UserThemeMeta[]>([])
  const [saveNameInput, setSaveNameInput] = useState('')
  const [showSavePrompt, setShowSavePrompt] = useState(false)
  const [saving, setSaving] = useState(false)

  const resolvedValues = useMemo(
    () => resolveTheme(workingTheme).values,
    [workingTheme]
  )

  // Load user theme list on mount
  useEffect(() => {
    const load = async () => {
      try {
        const raw = await xlethTheme()?.listUser?.()
        if (!Array.isArray(raw)) return
        // raw may be string[] slugs or {slug, name}[] — handle both
        let metas: UserThemeMeta[] = raw.map((item: any) =>
          typeof item === 'string'
            ? { slug: item, name: item }
            : { slug: item.slug ?? item, name: item.name ?? item.slug ?? item }
        )
        if (!isShippedSlug(activeSlug) && !metas.some(t => t.slug === activeSlug)) {
          metas = [...metas, { slug: activeSlug, name: activeTheme.name }]
        }
        setUserThemes(metas)
      } catch (e) {
        console.warn('[ThemeEditor] listUser failed:', e)
      }
    }
    load()
  }, [activeSlug, activeTheme.name])

  // When user picks a different theme from the list, load it.
  // Skip first render so we don't clobber activeTheme edits.
  const isFirstRender = useRef(true)
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }
    const shipped = getShippedTheme(selectedSlug)
    if (shipped) {
      setWorkingTheme(makeWorking(selectedSlug))
      return
    }
    // User theme — load async
    ;(async () => {
      try {
        const raw = await xlethTheme()?.loadUser?.(selectedSlug)
        if (raw) setWorkingTheme({ ...(raw as ThemeFile), locked: false })
      } catch (e) {
        console.warn('[ThemeEditor] loadUser failed:', e)
      }
    })()
  }, [selectedSlug])

  // Close on Escape — but not if save prompt is open
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showSavePrompt) { setShowSavePrompt(false); return }
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, showSavePrompt])

  const handleTokenChange = useCallback((name: string, value: string) => {
    setWorkingTheme(prev => ({
      ...prev,
      tokens: { ...prev.tokens, [name]: value },
    }))
  }, [])

  const handleDetachToggle = useCallback((name: string) => {
    setWorkingTheme(prev => {
      const detached = prev.derivationDetached ?? []
      const isCurrentlyDetached = detached.includes(name)
      const nextDetached = isCurrentlyDetached
        ? detached.filter(n => n !== name)
        : [...detached, name]
      // When detaching, seed the token with its current resolved value so it
      // has an explicit starting point in the ColorPicker.
      const nextTokens = (!isCurrentlyDetached && resolvedValues[name])
        ? { ...prev.tokens, [name]: resolvedValues[name] }
        : prev.tokens
      return { ...prev, derivationDetached: nextDetached, tokens: nextTokens }
    })
  }, [resolvedValues])

  const handleApply = useCallback(async () => {
    if (!isShippedSlug(selectedSlug)) {
      await xlethTheme()?.saveUser?.(selectedSlug, workingTheme)
    }
    await setTheme(selectedSlug, workingTheme)
  }, [selectedSlug, workingTheme, setTheme])

  const handleRevert = useCallback(async () => {
    const file = getShippedTheme(originalSlug)
    if (!file) return
    await setTheme(originalSlug, file)
    onClose()
  }, [originalSlug, setTheme, onClose])

  const handleSaveNew = useCallback(async () => {
    const name = saveNameInput.trim()
    if (!name) return
    setSaving(true)
    try {
      const slug = slugify(name)
      // Strip all explicit token overrides — keep only the 5 base tokens.
      // This prevents inherited teal/accent values from the shipped theme
      // bleeding through when the user changes accent to a different color.
      const BASE_TOKEN_NAMES = [
        '--theme-bg-primary',
        '--theme-bg-surface',
        '--theme-accent',
        '--theme-text',
        '--theme-danger',
      ]
      const cleanTokens: Record<string, string> = {}
      for (const k of BASE_TOKEN_NAMES) {
        const v = (workingTheme.tokens as Record<string, string>)[k]
        if (v) cleanTokens[k] = v
      }
      const toSave: ThemeFile = {
        schemaVersion: 1,
        name,
        locked: false,
        derivationDetached: [],
        tokens: cleanTokens,
      }
      await xlethTheme()?.saveUser?.(slug, toSave)
      setUserThemes(prev => [...prev, { slug, name }])
      setSelectedSlug(slug)
      setWorkingTheme({ ...toSave })
      await setTheme(slug, toSave)
      setShowSavePrompt(false)
      setSaveNameInput('')
    } catch (e) {
      console.error('[ThemeEditor] saveUser failed:', e)
    } finally {
      setSaving(false)
    }
  }, [saveNameInput, workingTheme, setTheme])

  const flatTokens = workingTheme.tokens as Record<string, string>

  return (
    <div className="theme-editor-backdrop" onClick={showSavePrompt ? undefined : onClose}>
      <div className="theme-editor" onClick={e => e.stopPropagation()}>

        <div className="theme-editor-header">
          <span className="theme-editor-title">Theme Editor</span>
          <button className="theme-editor-close" onClick={onClose}>✕</button>
        </div>

        <div className="theme-editor-body">
          <ThemeList
            selectedSlug={selectedSlug}
            onSelect={setSelectedSlug}
            userThemes={userThemes}
          />

          <div className="theme-editor-center">
            <div className="theme-editor-tabs">
              <button
                className={`theme-editor-tab ${activeTab === 'simple' ? 'theme-editor-tab--active' : ''}`}
                onClick={() => setActiveTab('simple')}
              >
                Simple
              </button>
              <button
                className={`theme-editor-tab ${activeTab === 'advanced' ? 'theme-editor-tab--active' : ''}`}
                onClick={() => setActiveTab('advanced')}
              >
                Advanced
              </button>
            </div>
            {activeTab === 'simple' ? (
              <SimpleMode tokens={flatTokens} onTokenChange={handleTokenChange} />
            ) : (
              <AdvancedMode
                workingTheme={workingTheme}
                resolvedValues={resolvedValues}
                onTokenChange={handleTokenChange}
                onDetachToggle={handleDetachToggle}
              />
            )}
          </div>

          <div className="theme-editor-preview">
            <PreviewPane workingTheme={workingTheme} />
          </div>
        </div>

        {/* Save-as-new prompt */}
        {showSavePrompt && (
          <div className="theme-editor-save-prompt">
            <span className="theme-editor-save-label">Theme name</span>
            <input
              className="theme-editor-save-input"
              type="text"
              placeholder="My Custom Theme"
              value={saveNameInput}
              onChange={e => setSaveNameInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSaveNew() }}
              autoFocus
            />
            <div className="theme-editor-save-actions">
              <button
                className="theme-editor-btn theme-editor-btn--ghost"
                onClick={() => { setShowSavePrompt(false); setSaveNameInput('') }}
              >
                Cancel
              </button>
              <button
                className="theme-editor-btn theme-editor-btn--primary"
                onClick={handleSaveNew}
                disabled={!saveNameInput.trim() || saving}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}

        <div className="theme-editor-footer">
          <button
            className="theme-editor-btn theme-editor-btn--ghost"
            onClick={() => { setSaveNameInput(''); setShowSavePrompt(true) }}
          >
            Save as New Theme
          </button>
          <div style={{ flex: 1 }} />
          <button className="theme-editor-btn theme-editor-btn--ghost" onClick={handleRevert}>
            Revert
          </button>
          <button className="theme-editor-btn theme-editor-btn--primary" onClick={handleApply}>
            Apply
          </button>
        </div>

      </div>
    </div>
  )
}
