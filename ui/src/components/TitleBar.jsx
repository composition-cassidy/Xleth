import { Fragment, useState, useEffect, useRef, useCallback } from 'react'
import { ToastStatusText } from './Toast.jsx'
import { usePanelRegistry } from '../windowing/registry/PanelRegistry'
import { LAYOUT_PRESETS } from '../windowing/managers/PresetManager'
import { Button, IconButton, motionMs, useMotionEnter } from '../ui-kit'
import { CLEANUP_PROJECT_LABEL } from './projectCleanup.js'
import TransportBar from './TransportBar.jsx'
import TitleBarRegions from './TitleBarRegions.jsx'
import styles from './TitleBar.module.css'
import { iconComponent } from '../ui-kit/icons'

const IcArrowUUpLeft = iconComponent('arrow-u-up-left')
const IcArrowUUpRight = iconComponent('arrow-u-up-right')
const IcMagnifyingGlassMinus = iconComponent('magnifying-glass-minus')
const IcMagnifyingGlassPlus = iconComponent('magnifying-glass-plus')
const IcMinus = iconComponent('minus')
const IcSquare = iconComponent('square')
const IcTrash = iconComponent('trash')
const IcX = iconComponent('x')

const DROPDOWN_OPEN_DELAY_MS = 40
// How long a closing dropdown stays mounted: the exit channel of the motion tier in force
// (ui-kit/motion.css; 0 in the flat tier and in tests), so the CSS fade and this timer agree.
const dropdownCloseMs = () => motionMs('--mo-exit')

const EXPORT_AUDIO_LABEL = 'Export Audio\u2026'
const EXPORT_VIDEO_LABEL = 'Export Video\u2026'

export const FILE_DROPDOWN_ITEMS = [
  { label: 'New Project', shortcut: 'Ctrl+N', group: 0 },
  { label: 'Open Project', shortcut: 'Ctrl+O', group: 0 },
  { label: 'Save', shortcut: 'Ctrl+S', group: 0 },
  { label: 'Save As...', shortcut: 'Ctrl+Shift+S', group: 0 },
  { label: 'Import Source', shortcut: 'Ctrl+I', group: 1 },
  { label: EXPORT_AUDIO_LABEL, shortcut: 'Ctrl+E', group: 2 },
  { label: EXPORT_VIDEO_LABEL, shortcut: 'Ctrl+Shift+E', group: 2 },
  { label: 'Export as ZIP…', group: 2 },
  { label: CLEANUP_PROJECT_LABEL, group: 3 },
]

export const EDIT_DROPDOWN_ACTIONS = [
  { label: 'Undo', action: 'Undo', icon: IcArrowUUpLeft, shortcut: 'Ctrl+Z', group: 0 },
  { label: 'Redo', action: 'Redo', icon: IcArrowUUpRight, shortcut: 'Ctrl+Shift+Z', group: 0 },
  { label: 'Delete', action: 'Delete', icon: IcTrash, shortcut: 'Delete', group: 1 },
]

export const VIEW_DROPDOWN_ACTIONS = [
  { label: 'Zoom In', action: 'Zoom In', icon: IcMagnifyingGlassPlus, shortcut: 'Ctrl++' },
  { label: 'Zoom Out', action: 'Zoom Out', icon: IcMagnifyingGlassMinus, shortcut: 'Ctrl+-' },
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

export const RESET_LAYOUT_ID = 'reset'
export const RESET_LAYOUT_LABEL = 'Reset layout'

/** View -> Layouts: apply a preset by id, or RESET_LAYOUT_ID for the default. */
export function applyLayoutChoice(presetId, registry = usePanelRegistry.getState()) {
  if (presetId === RESET_LAYOUT_ID) registry.resetLayout()
  else registry.applyPreset(presetId)
}

export function isDirectTitlebarMenu(menu) {
  return !menu.dropdown
}

const MENU_NAV_KEYS = ['ArrowDown', 'ArrowUp', 'Home', 'End']

/** Arrow / Home / End move between the rows of an open titlebar menu. */
function onMenuKeyDown(e) {
  if (!MENU_NAV_KEYS.includes(e.key)) return
  const rows = Array.from(e.currentTarget.querySelectorAll('[role="menuitem"]'))
  if (!rows.length) return
  const i = rows.indexOf(document.activeElement)
  let next
  if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = rows.length - 1
  else if (e.key === 'ArrowDown') next = i < 0 ? 0 : (i + 1) % rows.length
  else next = i < 0 ? rows.length - 1 : (i - 1 + rows.length) % rows.length
  e.preventDefault()
  rows[next].focus()
}

// One compact menu surface for File / Edit / View: 24px rows, 12px text, the label
// on the left and its shortcut on the right (same grammar as the kit Menu).
function MenuPanel({ label, children, ...rest }) {
  // Enters with the `pop` recipe (ui-kit/motion.css); the `.titlebar-dropdown` wrapper fades the exit.
  const enter = useMotionEnter('pop')
  return (
    <div {...enter} className={styles.panel} role="menu" aria-label={label} onKeyDown={onMenuKeyDown} {...rest}>
      {children}
    </div>
  )
}

function MenuRow({ label, shortcut, onSelect }) {
  return (
    <button type="button" role="menuitem" className={styles.row} onClick={onSelect}>
      <span>{label}</span>
      {shortcut ? <kbd className={styles.keys}>{shortcut}</kbd> : null}
    </button>
  )
}

function MenuRule() {
  return <div role="separator" className={styles.sep} />
}

/** Items carry a `group` number; a rule is drawn wherever it changes. */
function GroupedRows({ items, onSelect }) {
  return items.map((item, i) => (
    <Fragment key={item.label}>
      {i > 0 && item.group !== items[i - 1].group ? <MenuRule /> : null}
      <MenuRow label={item.label} shortcut={item.shortcut} onSelect={() => onSelect(item)} />
    </Fragment>
  ))
}

function FileDropdown({ onAction }) {
  return (
    <MenuPanel label="File">
      <GroupedRows items={FILE_DROPDOWN_ITEMS} onSelect={(item) => onAction(item.action || item.label)} />
    </MenuPanel>
  )
}

function EditDropdown({ onAction }) {
  return (
    <MenuPanel label="Edit">
      <GroupedRows items={EDIT_DROPDOWN_ACTIONS} onSelect={(item) => onAction(item.action)} />
    </MenuPanel>
  )
}

// View: zoom, then View -> Layouts. Layouts act on the panel registry directly;
// they are not file/edit actions and never reach XlethRoot.
function ViewDropdown({ onAction, onLayout }) {
  return (
    <MenuPanel label="View">
      {VIEW_DROPDOWN_ACTIONS.map((item) => (
        <MenuRow key={item.action} label={item.action} shortcut={item.shortcut} onSelect={() => onAction(item.action)} />
      ))}
      <MenuRule />
      <div role="group" aria-label="Layouts" data-testid="titlebar-view-layouts" className={styles.group}>
        <span className={styles.groupLabel}>Layouts</span>
        {LAYOUT_PRESETS.map((preset) => (
          <MenuRow key={preset.id} label={preset.label} onSelect={() => onLayout(preset.id)} />
        ))}
        <MenuRow label={RESET_LAYOUT_LABEL} onSelect={() => onLayout(RESET_LAYOUT_ID)} />
      </div>
    </MenuPanel>
  )
}

export default function TitleBar({ projectName = 'Untitled Project', onAction, activeMenuLabel = null }) {
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
    openTimerRef.current = setTimeout(() => {
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
    setOpenMenu(null)
    setDropdownState('closing')
    closeTimerRef.current = setTimeout(() => {
      setRenderedMenu(null)
      setDropdownState('closed')
    }, dropdownCloseMs())
  }, [clearDropdownTimers, dropdownState, renderedMenu])

  useEffect(() => clearDropdownTimers, [clearDropdownTimers])

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
      setOpenMenu(null)
      setDropdownState('closing')
      closeTimerRef.current = setTimeout(() => {
        setRenderedMenu(null)
        setDropdownState('closed')
        scheduleOpenDropdown(idx)
      }, dropdownCloseMs())
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

  const handleLayout = useCallback((presetId) => {
    closeDropdown()
    applyLayoutChoice(presetId)
  }, [closeDropdown])

  const handleMenuClick = useCallback((idx) => {
    const menu = TITLEBAR_MENUS[idx]
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
      return <EditDropdown onAction={handleAction} />
    }
    if (menu.dropdown === 'view') {
      return <ViewDropdown onAction={handleAction} onLayout={handleLayout} />
    }
    return null
  }, [handleAction, handleLayout])

  return (
    <div className={`titlebar ${styles.bar}`} ref={barRef}>
      <div className={`titlebar-left ${styles.left}`}>
        <nav className="titlebar-menus" aria-label="Application menu">
          {TITLEBAR_MENUS.map((menu, idx) => {
            const direct = isDirectTitlebarMenu(menu)
            const menuIsRendered = renderedMenu === idx
            const menuIsOpen = openMenu === idx
            const menuIsActive = menuIsOpen || activeMenuLabel === menu.label
            return (
              <div
                key={menu.label}
                className={`titlebar-menu ${menuIsOpen ? 'open' : ''}${menuIsActive ? ' active' : ''}`}
              >
                {/* `titlebar-menu-trigger` is kept as a plain hook class (no styles): the
                    window manager tests and dropdown positioning look it up. */}
                <Button
                  variant="ghost"
                  className={`titlebar-menu-trigger ${styles.menuTrigger}`}
                  data-open={menuIsActive ? 'true' : undefined}
                  onClick={() => handleMenuClick(idx)}
                  aria-haspopup={direct ? undefined : 'menu'}
                  aria-expanded={direct ? undefined : menuIsOpen}
                  hint={direct ? `${menu.label}` : `${menu.label} menu`}
                >
                  {menu.label}
                </Button>
                {!direct && menuIsRendered && (
                  <div className="titlebar-dropdown" data-state={dropdownState}>
                    {renderDropdown(menu)}
                  </div>
                )}
              </div>
            )
          })}
        </nav>
        <ToastStatusText />
      </div>

      <div className={styles.center}>
        <TransportBar />
      </div>

      <div className={styles.right}>
        <TitleBarRegions className={styles.dock} />

        <div className={styles.controls}>
          <IconButton
            label="Minimize"
            onClick={() => window.xleth.window.minimize()}
            hint="Minimize the window"
          >
            <IcMinus size={14} />
          </IconButton>
          <IconButton
            label="Maximize"
            onClick={() => window.xleth.window.maximize()}
            hint="Maximize or restore the window"
            hintMods="Double-click an empty part of the top bar"
          >
            <IcSquare size={14} />
          </IconButton>
          <IconButton
            className={styles.close}
            label="Close"
            onClick={() => window.xleth.window.close()}
            hint="Close Xleth"
          >
            <IcX size={14} />
          </IconButton>
        </div>
      </div>
    </div>
  )
}
