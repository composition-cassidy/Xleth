import { isValidElement } from 'react'
import { Menu, MenuCustom, MenuItem, MenuSeparator } from '../ui-kit'

/**
 * Context menu: the kit Menu (floating surface, keyboard navigable) behind the
 * item-array API every caller already uses.
 *
 * Props:
 *   x, y        – position (page coords from e.clientX/Y)
 *   items       – [{ label, onClick, icon?: icon component | element, danger?: bool, checked?: bool }]
 *                 or { type: 'separator' } / { type: 'custom', content, key? }
 *   onClose     – called on outside click, Escape, or after an item runs
 *   label       – optional accessible name of the menu
 */
export default function ContextMenu({ x, y, items, onClose, label = 'Context menu' }) {
  return (
    <Menu x={x} y={y} onClose={onClose} label={label} kind="context">
      {items.map((item, i) => {
        if (item.type === 'separator') return <MenuSeparator key={`sep-${i}`} />
        if (item.type === 'custom') return <MenuCustom key={item.key || `custom-${i}`}>{item.content}</MenuCustom>
        const Icon = item.icon
        const icon = Icon ? (isValidElement(Icon) ? Icon : <Icon size={14} />) : undefined
        return (
          <MenuItem key={item.label} icon={icon} danger={item.danger} checked={item.checked} onSelect={() => item.onClick?.()}>
            {item.label}
          </MenuItem>
        )
      })}
    </Menu>
  )
}
