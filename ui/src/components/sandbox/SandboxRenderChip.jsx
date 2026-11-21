import styles from './Sandbox.module.css'

/** A render state as a dot AND a word (idle, rendering, ready, error), so colour is never the only signal. */
export default function SandboxRenderChip({ state, children, title }) {
  return (
    <span className={styles.chip} data-state={state} title={title}>
      <span className={styles.chipDot} aria-hidden="true" />
      {children}
    </span>
  )
}
