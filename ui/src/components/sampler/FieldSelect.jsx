import { Select } from '../../ui-kit'
import styles from './Sampler.module.css'

// A named dropdown for a few-choice setting (mode, direction, voicing): the label
// on the left, the kit Select on the right. Quieter than a row of segments, and
// the current choice still reads at rest.
export default function FieldSelect({ label, value, options, onChange, hint, width = 112, ...rest }) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <Select
        size="sm"
        ariaLabel={label}
        value={value}
        options={options}
        onChange={onChange}
        hint={hint}
        className={styles.fieldSelect}
        style={{ '--field-w': `${width}px` }}
        {...rest}
      />
    </label>
  )
}
