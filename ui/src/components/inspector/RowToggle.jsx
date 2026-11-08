import React from 'react'
import { Check, Square } from 'lucide-react'
import { Toggle } from '../../ui-kit'

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
      glyph={on ? <Check aria-hidden="true" /> : <Square aria-hidden="true" />}
      aria-label={label}
      hint={hint}
      {...rest}
    />
  )
}
