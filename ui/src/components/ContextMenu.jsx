import { useEffect, useRef, isValidElement } from 'react'
import { createPortal } from 'react-dom'

/**
 * Portal-based context menu.
 *
 * Props:
 *   x, y        – position (page coords from e.clientX/Y)
 *   items       – [{ label, onClick, icon?: LucideComponent, danger?: bool }]
 *   onClose     – called on outside click or Escape
 */
export default function ContextMenu({ x, y, items, onClose }) {
  const menuRef = useRef(null)

  // Clamp to viewport — re-runs on mount and whenever the menu resizes
  // (e.g. when user enables Scratch/Vibrato and new controls appear)
  useEffect(() => {
    const el = menuRef.current
    if (!el) return

    const clamp = () => {
      const rect = el.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      if (rect.right > vw)   el.style.left = `${vw - rect.width - 4}px`
      if (rect.bottom > vh)  el.style.top  = `${vh - rect.height - 4}px`
    }

    clamp()
    const ro = new ResizeObserver(clamp)
    ro.observe(el)
    return () => ro.disconnect()
  }, [x, y])

  // Close on outside click
  useEffect(() => {
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose()
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

  return createPortal(
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: x, top: y }}
    >
      {items.map((item, i) =>
        item.type === 'separator' ? (
          <div key={`sep-${i}`} className="context-menu-sep" />
        ) : item.type === 'custom' ? (
          <div key={item.key || `custom-${i}`} className="context-menu-custom"
               onMouseDown={(e) => e.stopPropagation()}>
            {item.content}
          </div>
        ) : (
          <button
            key={item.label}
            className={`context-menu-item ${item.danger ? 'danger' : ''}`}
            onClick={() => { item.onClick(); onClose() }}
          >
            {item.icon && (isValidElement(item.icon) ? item.icon : <item.icon size={13} />)}
            <span>{item.label}</span>
          </button>
        )
      )}
    </div>,
    document.body
  )
}
