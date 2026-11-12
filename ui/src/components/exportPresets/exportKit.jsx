import React from 'react'
import { Select } from '../../ui-kit'
import styles from './Export.module.css'
import { iconComponent } from '../../ui-kit/icons'

const IcWarning = iconComponent('warning')

/** A label (with an optional note under it) and its control. `data-export-row` is the hook the tests use. */
export function Row({ label, note, children }) {
  return (
    <div className={styles.row} data-export-row="">
      <div className={styles.rowLabel}>
        <span data-export-label="">{label}</span>
        {note ? <span className={styles.rowNote}>{note}</span> : null}
      </div>
      <div className={styles.control}>{children}</div>
    </div>
  )
}

/** A kit Select named after its row. */
export function ExportSelect({ label, value, options, onChange, disabled, size = 'md' }) {
  return (
    <Select
      size={size}
      ariaLabel={label}
      value={value}
      options={options}
      disabled={disabled}
      onChange={onChange}
    />
  )
}

/** A note that is not colour alone: a warning or an error carries a glyph. */
export function Banner({ tone = 'info', children }) {
  return (
    <div className={styles.banner} data-tone={tone} role={tone === 'error' ? 'alert' : undefined}>
      {tone === 'warn' || tone === 'error' ? <IcWarning size={14} aria-hidden="true" /> : null}
      <span>{children}</span>
    </div>
  )
}

export { styles as exportStyles }
