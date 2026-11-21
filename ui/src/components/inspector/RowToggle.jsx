import React from 'react'
import { Toggle } from '../../ui-kit'
import { iconComponent } from '../../ui-kit/icons'

const IcCheckSquareFill = iconComponent('check-square', 'fill')
const IcSquareReg = iconComponent('square', 'regular')

/**
 * The on/off control of an Inspector row: a kit Toggle with no text of its own,
 * named by the row (`label`), so the row never echoes its label ("Reverse
 * [Reverse]") or prints "Off" on a button. On is a check in the filled chip,
 * off an empty box in the outlined one: the shape changes, not only the fill.
 */
export default function RowToggle({ label, on, onChange, hint, disabled, ...rest }) {
  return (
    <Toggle
      size="sm"
      on={!!on}
      onChange={onChange}
      disabled={disabled}
      glyph={on ? <IcCheckSquareFill aria-hidden="true" /> : <IcSquareReg aria-hidden="true" />}
      aria-label={label}
      hint={hint}
      {...rest}
    />
  )
}
