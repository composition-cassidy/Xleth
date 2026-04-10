import { useState, useEffect, useRef, useCallback } from 'react'
import { Minus, Square, X } from 'lucide-react'

// ── Menu definitions ─────────────────────────────────────────────────────────

const MENUS = [
  {
    label: 'File',
    items: [
      { label: 'New Project',    shortcut: 'Ctrl+N' },
      { label: 'Open Project',   shortcut: 'Ctrl+O' },
      { type: 'separator' },
      { label: 'Save',           shortcut: 'Ctrl+S' },
      { label: 'Save As...',     shortcut: 'Ctrl+Shift+S' },
      { type: 'separator' },
      { label: 'Import Source',  shortcut: 'Ctrl+I' },
      { type: 'separator' },
      { label: 'Export Audio…',  shortcut: 'Ctrl+E' },
      { label: 'Export Video…',  shortcut: 'Ctrl+Shift+E' },
      { type: 'separator' },
      { label: 'Exit',           shortcut: 'Alt+F4' },
    ],
  },
  {
    label: 'Edit',
    items: [
      { label: 'Undo',  shortcut: 'Ctrl+Z' },
      { label: 'Redo',  shortcut: 'Ctrl+Shift+Z' },
    ],
  },
  {
    label: 'View',
    items: [
      { label: 'Toggle Left Panel',  shortcut: 'Ctrl+B' },
      { label: 'Toggle Debug Panel', shortcut: 'Ctrl+`' },
      { type: 'separator' },
      { label: 'Zoom In',  shortcut: 'Ctrl+=' },
      { label: 'Zoom Out', shortcut: 'Ctrl+-' },
      { label: 'Reset Zoom', shortcut: 'Ctrl+0' },
    ],
  },
  {
    label: 'Settings',
    items: [
      { label: 'Settings' },
    ],
  },
]

// ── Component ────────────────────────────────────────────────────────────────

export default function TitleBar({ projectName = 'Untitled Project', onAction }) {
  const [openMenu, setOpenMenu] = useState(null)
  const barRef = useRef(null)

  // Close menus on outside click
  useEffect(() => {
    if (openMenu === null) return
    const handler = (e) => {
      if (barRef.current && !barRef.current.contains(e.target)) {
        setOpenMenu(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [openMenu])

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') setOpenMenu(null) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const handleMenuClick = useCallback((idx) => {
    setOpenMenu(prev => prev === idx ? null : idx)
  }, [])

  const handleItemClick = useCallback((item) => {
    setOpenMenu(null)
    console.log(`[UI] Menu: ${item.label}`)
    if (onAction) onAction(item.label)
  }, [onAction])

  const handleMenuHover = useCallback((idx) => {
    if (openMenu !== null) setOpenMenu(idx)
  }, [openMenu])

  return (
    <div className="titlebar" ref={barRef}>
      {/* ── Drag region + menus ──────────────────────────────────────────── */}
      <div className="titlebar-left">
        <div className="titlebar-logo">XLETH</div>
        <nav className="titlebar-menus">
          {MENUS.map((menu, idx) => (
            <div
              key={menu.label}
              className={`titlebar-menu ${openMenu === idx ? 'open' : ''}`}
              onMouseEnter={() => handleMenuHover(idx)}
            >
              <button
                className="titlebar-menu-trigger"
                onClick={() => handleMenuClick(idx)}
              >
                {menu.label}
              </button>
              {openMenu === idx && (
                <div className="titlebar-dropdown">
                  {menu.items.map((item, iIdx) =>
                    item.type === 'separator' ? (
                      <div key={`sep-${iIdx}`} className="titlebar-dropdown-sep" />
                    ) : (
                      <button
                        key={item.label}
                        className="titlebar-dropdown-item"
                        onClick={() => handleItemClick(item)}
                      >
                        <span>{item.label}</span>
                        {item.shortcut && (
                          <span className="titlebar-shortcut">{item.shortcut}</span>
                        )}
                      </button>
                    )
                  )}
                </div>
              )}
            </div>
          ))}
        </nav>
      </div>

      {/* ── Center: project name (draggable) ──────────────────────────── */}
      <div className="titlebar-center">
        <span className="titlebar-project">{projectName}</span>
      </div>

      {/* ── Window controls ──────────────────────────────────────────────── */}
      <div className="titlebar-controls">
        <button
          className="titlebar-btn"
          onClick={() => window.xleth?.window?.minimize()}
          aria-label="Minimize"
        >
          <Minus size={14} />
        </button>
        <button
          className="titlebar-btn"
          onClick={() => window.xleth?.window?.maximize()}
          aria-label="Maximize"
        >
          <Square size={12} />
        </button>
        <button
          className="titlebar-btn titlebar-btn-close"
          onClick={() => window.xleth?.window?.close()}
          aria-label="Close"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
