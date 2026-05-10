import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight } from 'lucide-react'

function joinClassNames(...classNames) {
  return classNames.filter(Boolean).join(' ')
}

/**
 * Context menu for track headers with nested submenu support.
 *
 * Props:
 *   x, y      – page position (clientX/Y)
 *   items     – tree of menu items:
 *               { label, onClick?, danger?, disabled?, checked?, submenu?: items[] }
 *               { type: 'separator' }
 *   onClose   – called on outside click / Escape / action
 *   menuClassName / submenuClassName – optional class hooks for variants
 */
export default function TrackContextMenu({
  x,
  y,
  items,
  onClose,
  menuClassName = '',
  submenuClassName = '',
}) {
  const menuRef = useRef(null)
  const [openSubIdx, setOpenSubIdx] = useState(-1)
  const [subPos, setSubPos] = useState({ x: 0, y: 0 })

  // Clamp to viewport
  useEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.right > window.innerWidth)   el.style.left = `${window.innerWidth - rect.width - 4}px`
    if (rect.bottom > window.innerHeight) el.style.top  = `${window.innerHeight - rect.height - 4}px`
  }, [x, y])

  // Close on outside click
  useEffect(() => {
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        // Check also submenu container
        const subs = document.querySelectorAll('.track-context-submenu')
        for (const s of subs) if (s.contains(e.target)) return
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const openSub = (i, e) => {
    const row = e.currentTarget.getBoundingClientRect()
    setSubPos({ x: row.right - 2, y: row.top })
    setOpenSubIdx(i)
  }

  return createPortal(
    <>
      <div
        ref={menuRef}
        className={joinClassNames('context-menu', 'track-context-menu', menuClassName)}
        style={{ left: x, top: y }}
      >
        {items.map((item, i) => {
          if (item.type === 'separator') return <div key={`sep-${i}`} className="context-menu-sep" />
          const hasSub = Array.isArray(item.submenu) && item.submenu.length > 0
          return (
            <button
              key={`${item.label}-${i}`}
              className={`context-menu-item ${item.danger ? 'danger' : ''} ${item.disabled ? 'disabled' : ''}`}
              disabled={item.disabled}
              onMouseEnter={(e) => hasSub ? openSub(i, e) : setOpenSubIdx(-1)}
              onClick={(e) => {
                if (item.disabled) return
                if (hasSub) { openSub(i, e); return }
                item.onClick?.()
                onClose()
              }}
            >
              {item.checked ? <span style={{ width: 12, fontSize: 10 }}>✓</span> : <span style={{ width: 12 }} />}
              <span style={{ flex: 1 }}>{item.label}</span>
              {hasSub && <ChevronRight size={12} />}
            </button>
          )
        })}
      </div>
      {openSubIdx >= 0 && items[openSubIdx]?.submenu && (
        <TrackContextSubmenu
          x={subPos.x}
          y={subPos.y}
          items={items[openSubIdx].submenu}
          submenuClassName={submenuClassName || menuClassName}
          onSelect={() => onClose()}
        />
      )}
    </>,
    document.body
  )
}

function TrackContextSubmenu({ x, y, items, onSelect, submenuClassName = '' }) {
  const elRef = useRef(null)

  useEffect(() => {
    const el = elRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.right > window.innerWidth)   el.style.left = `${window.innerWidth - rect.width - 4}px`
    if (rect.bottom > window.innerHeight) el.style.top  = `${window.innerHeight - rect.height - 4}px`
  }, [x, y])

  return (
    <div
      ref={elRef}
      className={joinClassNames('context-menu', 'track-context-submenu', submenuClassName)}
      style={{ left: x, top: y }}
    >
      {items.length === 0 && (
        <div className="context-menu-item disabled" style={{ opacity: 0.5 }}>
          <span style={{ width: 12 }} />
          <span style={{ flex: 1, fontStyle: 'italic' }}>(none)</span>
        </div>
      )}
      {items.map((item, i) => {
        if (item.type === 'separator') return <div key={`sep-${i}`} className="context-menu-sep" />
        return (
          <button
            key={`${item.label}-${i}`}
            className={`context-menu-item ${item.danger ? 'danger' : ''} ${item.disabled ? 'disabled' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return
              item.onClick?.()
              onSelect?.()
            }}
          >
            {item.checked ? <span style={{ width: 12, fontSize: 10 }}>✓</span> : <span style={{ width: 12 }} />}
            <span style={{ flex: 1 }}>{item.label}</span>
          </button>
        )
      })}
    </div>
  )
}
