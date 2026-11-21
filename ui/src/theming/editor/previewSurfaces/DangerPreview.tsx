import styles from './Preview.module.css'
import { iconComponent } from '../../../ui-kit/icons';

const IcCheck = iconComponent('check');
const IcLightning = iconComponent('lightning');
const IcWarning = iconComponent('warning');

export default function DangerPreview() {
  return (
    <div className={styles.card}>
      <div className={styles.cardLabel}>Danger and status</div>
      <div className={styles.statusStack}>
        <div className={`${styles.status} ${styles.statusError}`}>
          <IcWarning size={14} aria-hidden="true" />
          <span>Error state</span>
        </div>
        <div className={`${styles.status} ${styles.statusWarning}`}>
          <IcLightning size={14} aria-hidden="true" />
          <span>Warning state</span>
        </div>
        <div className={`${styles.status} ${styles.statusSuccess}`}>
          <IcCheck size={14} aria-hidden="true" />
          <span>Success state</span>
        </div>
      </div>
    </div>
  )
}
