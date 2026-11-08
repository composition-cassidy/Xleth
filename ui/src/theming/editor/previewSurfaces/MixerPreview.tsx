import styles from './Preview.module.css'

const CHANNELS = ['Kick', 'Bass', 'Lead', 'FX']

export default function MixerPreview() {
  return (
    <div className={styles.card}>
      <div className={styles.cardLabel}>Mixer</div>
      <div className={styles.mixerRow}>
        {CHANNELS.map(ch => (
          <div key={ch} className={styles.channel}>
            <div className={styles.faderTrack}>
              <div className={styles.faderThumb} />
            </div>
            <div className={styles.channelLabel}>{ch}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
