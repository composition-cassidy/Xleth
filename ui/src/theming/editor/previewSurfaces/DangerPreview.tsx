import { AlertTriangle, Check, Zap } from 'lucide-react'
import styles from './Preview.module.css'

export default function DangerPreview() {
  return (
    <div className={styles.card}>
      <div className={styles.cardLabel}>Danger and status</div>
      <div className={styles.statusStack}>
        <div className={`${styles.status} ${styles.statusError}`}>
          <AlertTriangle size={12} aria-hidden="true" />
          <span>Error state</span>
        </div>
        <div className={`${styles.status} ${styles.statusWarning}`}>
          <Zap size={12} aria-hidden="true" />
          <span>Warning state</span>
        </div>
        <div className={`${styles.status} ${styles.statusSuccess}`}>
          <Check size={12} aria-hidden="true" />
          <span>Success state</span>
        </div>
      </div>
    </div>
  )
}
