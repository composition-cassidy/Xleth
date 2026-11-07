import styles from './Browser.module.css'

/**
 * The disclosure triangle: a filled wedge that points right when closed and down
 * when open. Decorative; the button that holds it carries aria-expanded.
 */
export default function Disclosure({ open }) {
  return (
    <svg
      className={styles.disclosure}
      data-open={open ? 'true' : 'false'}
      viewBox="0 0 8 8"
      width="8"
      height="8"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M1.5 0.5 L6.5 4 L1.5 7.5 Z" fill="currentColor" />
    </svg>
  )
}
