import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useTheme } from '../runtime/ThemeProvider'
import { getShippedTheme, DEFAULT_THEME_NAME } from '../runtime/ThemeLoader'
import { resolveTheme } from '../runtime/applyTheme'
import type { ThemeFile } from '../schema/types'
import { Button, Tabs, TextField } from '../../ui-kit'
import ThemeList, { type UserThemeMeta } from './ThemeList'
import SimpleMode from './SimpleMode'
import AdvancedMode from './AdvancedMode'
import PreviewPane from './PreviewPane'
import ChromeReadouts from './ChromeReadouts'
import { applyChromeKnobs, neutralizeTheme, type ChromeKnobs } from '../runtime/chromeKnobs'
import { resolveHex } from '../runtime/chromeTint'
import { CHROME_MODEL_VERSION, migrateChrome } from '../runtime/chromeMigration'
import styles from './ThemeEditor.module.css'

interface ThemeEditorContentProps {
  /** Kept for callers: the editor only ever mounts inside Settings > Appearance. */
  embedded?: boolean
  onRequestClose?: () => void
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

export function ThemeEditorContent({
  onRequestClose,
}: ThemeEditorContentProps) {
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

  // Load user theme list on mount.
  useEffect(() => {
    const load = async () => {
      try {
        const raw = await xlethTheme()?.listUser?.()
        if (!Array.isArray(raw)) return
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

  // Skip first render so we do not clobber activeTheme edits.
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
    ;(async () => {
      try {
        const raw = await xlethTheme()?.loadUser?.(selectedSlug)
        if (raw) setWorkingTheme({ ...migrateChrome(raw as ThemeFile).theme, locked: false })
      } catch (e) {
        console.warn('[ThemeEditor] loadUser failed:', e)
      }
    })()
  }, [selectedSlug])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (showSavePrompt) {
        e.preventDefault()
        e.stopPropagation()
        setShowSavePrompt(false)
        return
      }
      onRequestClose?.()
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [onRequestClose, showSavePrompt])

  const handleTokenChange = useCallback((name: string, value: string) => {
    setWorkingTheme(prev => ({
      ...prev,
      tokens: { ...prev.tokens, [name]: value },
    }))
  }, [])

  // Surface knobs (brightness / contrast / tint) re-derive the neutral ramp. The accent is
  // carried through from the working theme so the knobs never reset it.
  const accentOf = (theme: ThemeFile): string =>
    resolveHex(resolveTheme(theme).values, '--theme-accent') ?? '#33CED6'

  const handleChromeChange = useCallback((knobs: ChromeKnobs) => {
    setWorkingTheme(prev => applyChromeKnobs(prev, accentOf(prev), knobs))
  }, [])

  const handleNeutralize = useCallback(() => {
    setWorkingTheme(prev => neutralizeTheme(prev, accentOf(prev), resolveTheme(prev).values))
    console.debug('[Theme] editor: neutralized chrome tint')
  }, [])

  const handleDetachToggle = useCallback((name: string) => {
    setWorkingTheme(prev => {
      const detached = prev.derivationDetached ?? []
      const isCurrentlyDetached = detached.includes(name)
      const nextDetached = isCurrentlyDetached
        ? detached.filter(n => n !== name)
        : [...detached, name]
      // When detaching, seed the token with its current resolved value.
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
    onRequestClose?.()
  }, [originalSlug, setTheme, onRequestClose])

  const handleSaveNew = useCallback(async () => {
    const name = saveNameInput.trim()
    if (!name) return
    setSaving(true)
    try {
      const slug = slugify(name)
      // Keep only base tokens so inherited shipped-theme accents do not leak.
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
        chromeModel: CHROME_MODEL_VERSION,
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

  const EDITOR_TABS = [
    { id: 'simple', label: 'Simple' },
    { id: 'advanced', label: 'Advanced' },
  ] as const

  return (
    <div className={styles.root}>
      <div className={styles.body}>
        <ThemeList
          selectedSlug={selectedSlug}
          onSelect={setSelectedSlug}
          userThemes={userThemes}
        />

        <div className={styles.center}>
          <Tabs
            label="Editor mode"
            tabs={EDITOR_TABS}
            value={activeTab}
            onChange={(id) => setActiveTab(id === 'advanced' ? 'advanced' : 'simple')}
          />
          {activeTab === 'simple' ? (
            <SimpleMode
              values={resolvedValues}
              onChromeChange={handleChromeChange}
              onTokenChange={handleTokenChange}
              onNeutralize={handleNeutralize}
            />
          ) : (
            <>
              <ChromeReadouts values={resolvedValues} onNeutralize={handleNeutralize} />
              <AdvancedMode
                workingTheme={workingTheme}
                resolvedValues={resolvedValues}
                onTokenChange={handleTokenChange}
                onDetachToggle={handleDetachToggle}
              />
            </>
          )}
        </div>

        <div className={styles.preview}>
          <PreviewPane workingTheme={workingTheme} />
        </div>
      </div>

      {showSavePrompt && (
        <div className={styles.savePrompt}>
          <span className={styles.saveLabel}>Theme name</span>
          <TextField
            label="Theme name"
            placeholder="My custom theme"
            value={saveNameInput}
            onChange={setSaveNameInput}
            onKeyDown={e => { if (e.key === 'Enter') handleSaveNew() }}
            autoFocus
          />
          <Button onClick={() => { setShowSavePrompt(false); setSaveNameInput('') }}>Cancel</Button>
          <Button variant="primary" onClick={handleSaveNew} disabled={!saveNameInput.trim() || saving}>
            {saving ? 'Saving…' : 'Save theme'}
          </Button>
        </div>
      )}

      <div className={styles.footer}>
        <Button onClick={() => { setSaveNameInput(''); setShowSavePrompt(true) }}>Save as new theme</Button>
        <span className={styles.spacer} />
        <Button onClick={handleRevert}>Revert</Button>
        <Button variant="primary" onClick={handleApply}>Apply theme</Button>
      </div>
    </div>
  )
}
