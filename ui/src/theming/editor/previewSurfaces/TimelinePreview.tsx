import type { CSSProperties } from 'react'
import styles from './Preview.module.css'

const TRACKS = [
  { name: 'Vocals', color: 'var(--theme-accent)' },
  { name: 'Drums',  color: 'var(--theme-smartbalance-band-sub)' },
  { name: 'Bass',   color: 'var(--theme-smartbalance-band-lowmid)' },
]

export default function TimelinePreview() {
  return (
    <div className={styles.card}>
      <div className={styles.cardLabel}>Timeline</div>
      <div className={styles.tracks}>
        {TRACKS.map(t => (
          <div key={t.name} className={styles.track} style={{ '--track-color': t.color } as CSSProperties}>
            <div className={styles.trackHead}>
              <div className={styles.trackDot} />
              <span className={styles.trackName}>{t.name}</span>
            </div>
            <div className={styles.trackClip} />
          </div>
        ))}
      </div>
    </div>
  )
}
