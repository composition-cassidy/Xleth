import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Menu, MenuItem, MenuSeparator } from '../../ui-kit'

function joinClassNames(...classNames) {
  return classNames.filter(Boolean).join(' ')
}

/**
 * Context menu for track headers with nested submenu support, on the kit Menu.
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
  const [openSubIdx, setOpenSubIdx] = useState(-1)
  const [subPos, setSubPos] = useState({ x: 0, y: 0 })

  const openSub = (i, e) => {
    const row = e.currentTarget.getBoundingClientRect()
    setSubPos({ x: row.right - 2, y: row.top })
    setOpenSubIdx(i)
  }

  const submenu = openSubIdx >= 0 ? items[openSubIdx]?.submenu : null

  return (
    <>
      <Menu
        x={x}
        y={y}
        onClose={onClose}
        label="Track menu"
        className={joinClassNames('track-context-menu', menuClassName)}
      >
        <MenuItems
          items={items}
          onOpenSub={openSub}
          onLeaveSub={() => setOpenSubIdx(-1)}
        />
      </Menu>
      {submenu && (
        <Menu
          x={subPos.x}
          y={subPos.y}
          onClose={onClose}
          label={`${items[openSubIdx].label} submenu`}
          className={joinClassNames('track-context-submenu', submenuClassName || menuClassName)}
        >
          {submenu.length === 0 && <MenuItem disabled>(none)</MenuItem>}
          <MenuItems items={submenu} />
        </Menu>
      )}
    </>
  )
}

function MenuItems({ items, onOpenSub, onLeaveSub }) {
  // A check column is reserved for every row only when some row can be checked.
  const anyChecked = items.some((item) => item.checked !== undefined)
  return items.map((item, i) => {
    if (item.type === 'separator') return <MenuSeparator key={`sep-${i}`} />
    const hasSub = Array.isArray(item.submenu) && item.submenu.length > 0
    return (
      <MenuItem
        key={`${item.label}-${i}`}
        danger={item.danger}
        disabled={item.disabled}
        checked={anyChecked ? !!item.checked : undefined}
        trailing={hasSub ? <ChevronRight size={12} /> : undefined}
        onMouseEnter={onOpenSub ? (e) => (hasSub ? onOpenSub(i, e) : onLeaveSub?.()) : undefined}
        onSelect={(e) => {
          if (hasSub) { onOpenSub?.(i, e); return }
          item.onClick?.() // the menu closes itself after a leaf item runs
        }}
      >
        {item.label}
      </MenuItem>
    )
  })
}
