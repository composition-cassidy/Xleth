import styles from './Preview.module.css'

export default function TypographyPreview() {
  return (
    <div className={styles.card}>
      <div className={styles.cardLabel}>Typography</div>
      <div className={styles.typeStack}>
        <span className={styles.textPrimary}>Primary text</span>
        <span className={styles.textSecondary}>Secondary text</span>
        <span className={styles.textMuted}>Muted text and labels</span>
        <span className={styles.textAccent}>Accent link</span>
      </div>
    </div>
  )
}
