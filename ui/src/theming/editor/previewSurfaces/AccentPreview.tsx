import styles from './Preview.module.css'

export default function AccentPreview() {
  return (
    <div className={styles.card}>
      <div className={styles.cardLabel}>Accent</div>
      <div className={styles.accentRow}>
        <button type="button" className={styles.btnPrimary} tabIndex={-1}>Apply</button>
        <button type="button" className={styles.btnGhost} tabIndex={-1}>Cancel</button>
      </div>
      <div className={styles.chips}>
        <div className={`${styles.chip} ${styles.chipActive}`}>Active</div>
        <div className={`${styles.chip} ${styles.chipSelected}`}>Selected</div>
      </div>
    </div>
  )
}
