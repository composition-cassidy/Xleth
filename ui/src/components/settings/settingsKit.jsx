import React from 'react'
import { AlertTriangle, Check } from 'lucide-react'
import styles from './Settings.module.css'

/** One titled group of rows. `wide` gives its body padding for a free-form child (a table, a diagnostics panel). */
export function SettingsSection({ title, children, className = '', wide = false }) {
  return (
    <section className={`${styles.section} ${className}`.trim()}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      <div className={`${styles.sectionBody}${wide ? ` ${styles.wide}` : ''}`}>{children}</div>
    </section>
  )
}

/** A label (with an optional description) on the left, its control on the right. */
export function SettingsRow({ label, htmlFor, description, children }) {
  return (
    <div className={styles.row}>
      <div className={styles.copy}>
        {htmlFor ? (
          <label className={styles.label} htmlFor={htmlFor}>{label}</label>
        ) : (
          <div className={styles.label}>{label}</div>
        )}
        {description && <div className={styles.description}>{description}</div>}
      </div>
      <div className={styles.control}>{children}</div>
    </div>
  )
}

/** A note under a group of rows. `warning` and `success` carry a glyph, so colour is never the only signal. */
export function SettingsHint({ tone = 'default', children }) {
  return (
    <div className={styles.hint} data-tone={tone}>
      {tone === 'warning' ? <AlertTriangle size={12} aria-hidden="true" className={styles.hintGlyph} /> : null}
      {tone === 'success' ? <Check size={12} aria-hidden="true" className={styles.hintGlyph} /> : null}
      <span>{children}</span>
    </div>
  )
}

/** A read-only value in a row's control cell. */
export function SettingsValue({ tone = 'default', children, ...rest }) {
  return <span {...rest} className={styles.value} data-tone={tone}>{children}</span>
}

export { styles as settingsStyles }
