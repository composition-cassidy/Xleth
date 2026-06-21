import { useState, useEffect, useRef, useCallback } from 'react'
import {
  AudioWaveform,
  Folder,
  Layout,
  Minus,
  Pencil,
  Redo2,
  Settings,
  Square,
  Trash2,
  Undo2,
  Video,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { usePanelRegistry } from '../windowing/registry/PanelRegistry'
import { PANEL_CATALOG_ORDER } from '../windowing/registry/panelCatalog'
import { useQuickLaunchersStore } from '../stores/quickLaunchersStore.js'
import { XlethButton, XlethIconButton } from './common/XlethButton.jsx'

const DROPDOWN_OPEN_DELAY_MS = 40
const DROPDOWN_CLOSE_MS = 80

const EXPORT_AUDIO_LABEL = 'Export Audio\u2026'
const EXPORT_VIDEO_LABEL = 'Export Video\u2026'

export const FILE_DROPDOWN_ITEMS = [
  { label: 'New Project', shortcut: 'Ctrl+N' },
  { label: 'Open Project', shortcut: 'Ctrl+O' },
  { label: 'Save', shortcut: 'Ctrl+S' },
  { label: 'Save As...', shortcut: 'Ctrl+Shift+S' },
  { label: 'Import Source', shortcut: 'Ctrl+I' },
  { label: 'Export as ZIP…' },
]

export const EDIT_DROPDOWN_ACTIONS = [
  { label: 'Undo', action: 'Undo', icon: Undo2, shortcut: 'Ctrl+Z' },
  { label: 'Redo', action: 'Redo', icon: Redo2, shortcut: 'Ctrl+Shift+Z' },
  { label: 'Delete', action: 'Delete', icon: Trash2, shortcut: 'Delete' },
]

export const VIEW_DROPDOWN_ACTIONS = [
  { label: 'Zoom In', action: 'Zoom In', icon: ZoomIn, shortcut: 'Ctrl++' },
  { label: 'Zoom Out', action: 'Zoom Out', icon: ZoomOut, shortcut: 'Ctrl+-' },
  { label: 'RESET', action: 'Reset Zoom', text: true, shortcut: 'Ctrl+0' },
]

export const TITLEBAR_MENUS = [
  {
    label: 'File',
    dropdown: 'file',
    items: FILE_DROPDOWN_ITEMS,
  },
  {
    label: 'Edit',
    dropdown: 'edit',
    items: EDIT_DROPDOWN_ACTIONS,
  },
  {
    label: 'View',
    dropdown: 'view',
    items: VIEW_DROPDOWN_ACTIONS,
  },
  {
    label: 'Settings',
    action: 'Settings',
    items: [],
  },
]

const TITLEBAR_MENU_ICONS = {
  File: Folder,
  Edit: Pencil,
  View: Layout,
  Settings,
}

export function isDirectTitlebarMenu(menu) {
  return !menu.dropdown
}

function FileDropdown({ onAction }) {
  return (
    <div className="titlebar-dropdown-panel titlebar-dropdown-panel--file" role="menu">
      {FILE_DROPDOWN_ITEMS.map((item) => (
        <XlethButton
          type="button"
          key={item.label}
          className="titlebar-dropdown-item"
          onClick={() => {
            if (item.label === 'New Project') console.log('[Test] click fired')
            onAction(item.label)
          }}
          role="menuitem"
        >
          <span>{item.label}</span>
        </XlethButton>
      ))}
      <div className="titlebar-export-row" role="group" aria-label="Export">
        <span className="titlebar-export-label">Export:</span>
        <div className="titlebar-export-actions">
          <XlethIconButton
            type="button"
            className="titlebar-toolbar-btn"
            onClick={() => onAction(EXPORT_AUDIO_LABEL)}
            title="Export Audio (Ctrl+E)"
            aria-label="Export Audio"
          >
            <AudioWaveform size={18} strokeWidth={2} aria-hidden="true" />
          </XlethIconButton>
          <XlethIconButton
            type="button"
            className="titlebar-toolbar-btn"
            onClick={() => onAction(EXPORT_VIDEO_LABEL)}
            title="Export Video (Ctrl+Shift+E)"
            aria-label="Export Video"
          >
            <Video size={18} strokeWidth={2} aria-hidden="true" />
          </XlethIconButton>
        </div>
      </div>
    </div>
  )
}

function ToolbarDropdown({ actions, label, onAction }) {
  return (
    <div className="titlebar-dropdown-panel titlebar-dropdown-panel--toolbar" role="menu" aria-label={label}>
      <div className="titlebar-action-strip" role="group" aria-label={label}>
        {actions.map((item) => {
          const Icon = item.icon
          return (
            <XlethButton
              type="button"
              key={item.action}
              className={`titlebar-toolbar-btn ${item.text ? 'titlebar-toolbar-btn--text' : ''}`}
              onClick={() => onAction(item.action)}
              title={item.shortcut ? `${item.label} (${item.shortcut})` : item.label}
              aria-label={item.label}
              role="menuitem"
            >
              {Icon ? <Icon size={18} strokeWidth={2} aria-hidden="true" /> : item.label}
            </XlethButton>
          )
        })}
      </div>
    </div>
  )
}

function TitleBarLauncherButton({ entry }) {
  const panelHidden = usePanelRegistry((state) => state.panels[entry.id].hidden)
  const Icon = entry.icon
  const panelVisible = !panelHidden

  return (
    <XlethIconButton
      type="button"
      className="titlebar-launcher-btn"
      active={panelVisible}
      data-active={String(panelVisible)}
      style={{ '--xleth-windowing-panel-color': `var(${entry.typeColorToken})` }}
      onClick={() => usePanelRegistry.getState().togglePanel(entry.id)}
      title={`${entry.title} (${entry.fKey})`}
      aria-label={`Toggle ${entry.title}`}
      aria-pressed={panelVisible}
    >
      <Icon size={22} strokeWidth={2} aria-hidden="true" />
    </XlethIconButton>
  )
}

function QuickLauncherButton({ launcher }) {
  const iconUrl = window.xleth?.launcher?.buildIconUrl?.(launcher.iconPngPath || '')

  function handleClick() {
    window.xleth?.launcher?.spawnDetached?.(launcher.exePath)
  }

  return (
    <XlethIconButton
      type="button"
      className="titlebar-launcher-btn"
      active={false}
      data-active="false"
      onClick={handleClick}
      title={launcher.label}
      aria-label={`Launch ${launcher.label}`}
    >
      {iconUrl ? (
        <img
          src={iconUrl}
          alt=""
          aria-hidden="true"
          className="titlebar-quick-launcher-icon"
          onError={e => {
            e.currentTarget.style.display = 'none'
            const fb = e.currentTarget.nextSibling
            if (fb) fb.style.display = 'block'
          }}
        />
      ) : null}
      <span
        className="titlebar-quick-launcher-fallback"
        style={{ display: iconUrl ? 'none' : 'block' }}
        aria-hidden="true"
      >
        {(launcher.label || '?').charAt(0).toUpperCase()}
      </span>
    </XlethIconButton>
  )
}

export default function TitleBar({ projectName = 'Untitled Project', onAction, activeMenuLabel = null }) {
  const quickLaunchers = useQuickLaunchersStore((state) => state.launchers)
  const hydrateQuickLaunchers = useQuickLaunchersStore((state) => state.hydrate)

  useEffect(() => { hydrateQuickLaunchers() }, [hydrateQuickLaunchers])

  const [renderedMenu, setRenderedMenu] = useState(null)
  const [openMenu, setOpenMenu] = useState(null)
  const [dropdownState, setDropdownState] = useState('closed')
  const barRef = useRef(null)
  const openTimerRef = useRef(null)
  const enterTimerRef = useRef(null)
  const closeTimerRef = useRef(null)

  const clearDropdownTimers = useCallback(() => {
    if (openTimerRef.current) clearTimeout(openTimerRef.current)
    if (enterTimerRef.current) clearTimeout(enterTimerRef.current)
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    openTimerRef.current = null
    enterTimerRef.current = null
    closeTimerRef.current = null
  }, [])

  const scheduleOpenDropdown = useCallback((idx) => {
    const menu = TITLEBAR_MENUS[idx]
    openTimerRef.current = setTimeout(() => {
      console.log(`[MenuDropdown] open:${menu.label}`)
      setRenderedMenu(idx)
      setDropdownState('opening')
      enterTimerRef.current = setTimeout(() => {
        setOpenMenu(idx)
        setDropdownState('open')
      }, 0)
    }, DROPDOWN_OPEN_DELAY_MS)
  }, [])

  const closeDropdown = useCallback(() => {
    clearDropdownTimers()
    if (renderedMenu === null || dropdownState === 'closed' || dropdownState === 'closing') {
      setOpenMenu(null)
      return
    }
    const menu = TITLEBAR_MENUS[renderedMenu]
    console.log(`[MenuDropdown] close:${menu.label}`)
    setOpenMenu(null)
    setDropdownState('closing')
    closeTimerRef.current = setTimeout(() => {
      setRenderedMenu(null)
      setDropdownState('closed')
    }, DROPDOWN_CLOSE_MS)
  }, [clearDropdownTimers, dropdownState, renderedMenu])

  useEffect(() => {
    console.log('[MenuBar] mount')
    return clearDropdownTimers
  }, [clearDropdownTimers])

  useEffect(() => {
    if (renderedMenu === null) return
    const handler = (e) => {
      if (barRef.current && !barRef.current.contains(e.target)) {
        closeDropdown()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [closeDropdown, renderedMenu])

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') closeDropdown()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [closeDropdown])

  const openDropdown = useCallback((idx) => {
    clearDropdownTimers()
    if (renderedMenu === idx && dropdownState !== 'closing') {
      closeDropdown()
      return
    }

    if (renderedMenu !== null && dropdownState !== 'closing') {
      const currentMenu = TITLEBAR_MENUS[renderedMenu]
      console.log(`[MenuDropdown] close:${currentMenu.label}`)
      setOpenMenu(null)
      setDropdownState('closing')
      closeTimerRef.current = setTimeout(() => {
        setRenderedMenu(null)
        setDropdownState('closed')
        scheduleOpenDropdown(idx)
      }, DROPDOWN_CLOSE_MS)
      return
    }

    setRenderedMenu(null)
    setOpenMenu(null)
    setDropdownState('closed')
    scheduleOpenDropdown(idx)
  }, [clearDropdownTimers, closeDropdown, dropdownState, renderedMenu, scheduleOpenDropdown])

  const handleAction = useCallback((label) => {
    closeDropdown()
    console.log(`[UI] Menu: ${label}`)
    if (onAction) onAction(label)
  }, [closeDropdown, onAction])

  const handleMenuClick = useCallback((idx) => {
    const menu = TITLEBAR_MENUS[idx]
    console.log('[MenuBar] pill click:', menu.label)
    if (idx === 0) console.log('[TitleBar] fix verified — FILE click fires')
    if (isDirectTitlebarMenu(menu)) {
      closeDropdown()
      if (onAction) onAction(menu.action || menu.label)
      return
    }
    openDropdown(idx)
  }, [closeDropdown, onAction, openDropdown])

  const renderDropdown = useCallback((menu) => {
    if (menu.dropdown === 'file') return <FileDropdown onAction={handleAction} />
    if (menu.dropdown === 'edit') {
      return <ToolbarDropdown actions={EDIT_DROPDOWN_ACTIONS} label="Edit actions" onAction={handleAction} />
    }
    if (menu.dropdown === 'view') {
      return <ToolbarDropdown actions={VIEW_DROPDOWN_ACTIONS} label="View zoom actions" onAction={handleAction} />
    }
    return null
  }, [handleAction])

  return (
    <div className="titlebar" ref={barRef}>
      <div className="titlebar-left">
        <nav className="titlebar-menus" aria-label="Application menu">
          {TITLEBAR_MENUS.map((menu, idx) => {
            const direct = isDirectTitlebarMenu(menu)
            const MenuIcon = TITLEBAR_MENU_ICONS[menu.label]
            const menuIsRendered = renderedMenu === idx
            const menuIsOpen = openMenu === idx
            const menuIsActive = menuIsOpen || activeMenuLabel === menu.label
            return (
              <div
                key={menu.label}
                className={`titlebar-menu ${menuIsOpen ? 'open' : ''}${menuIsActive ? ' active' : ''}`}
              >
                <XlethButton
                  type="button"
                  className="titlebar-menu-trigger"
                  active={menuIsActive}
                  onClick={() => handleMenuClick(idx)}
                  aria-haspopup={direct ? undefined : 'menu'}
                  aria-expanded={direct ? undefined : menuIsOpen}
                >
                  {MenuIcon && <MenuIcon className="titlebar-menu-icon" size={20} strokeWidth={2} aria-hidden="true" />}
                  <span>{menu.label}</span>
                </XlethButton>
                {!direct && menuIsRendered && (
                  <div className="titlebar-dropdown" data-state={dropdownState}>
                    {renderDropdown(menu)}
                  </div>
                )}
              </div>
            )
          })}
        </nav>
      </div>

      <div className="titlebar-launchers">
        {PANEL_CATALOG_ORDER
          .filter((entry) => entry.id !== 'sampleSelector')
          .map((entry) => <TitleBarLauncherButton key={entry.id} entry={entry} />)}

        {quickLaunchers.length > 0 && (
          <div className="titlebar-launchers-divider" aria-hidden="true" />
        )}

        {quickLaunchers.map((launcher) => (
          <QuickLauncherButton key={launcher.id} launcher={launcher} />
        ))}
      </div>

      <div className="titlebar-controls">
        <XlethIconButton
          type="button"
          className="titlebar-btn"
          onClick={() => window.xleth.window.minimize()}
          aria-label="Minimize"
        >
          <Minus size={14} />
        </XlethIconButton>
        <XlethIconButton
          type="button"
          className="titlebar-btn"
          onClick={() => window.xleth.window.maximize()}
          aria-label="Maximize"
        >
          <Square size={14} />
        </XlethIconButton>
        <XlethIconButton
          type="button"
          className="titlebar-btn titlebar-btn-close"
          onClick={() => window.xleth.window.close()}
          aria-label="Close"
        >
          <X size={14} />
        </XlethIconButton>
      </div>
    </div>
  )
}
