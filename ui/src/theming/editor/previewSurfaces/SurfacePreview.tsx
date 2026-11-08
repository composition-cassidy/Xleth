import styles from './Preview.module.css'

const SURFACES = [
  ['Primary', '--theme-bg-primary'],
  ['Surface', '--theme-bg-surface'],
  ['Secondary', '--theme-bg-secondary'],
  ['Tertiary', '--theme-bg-tertiary'],
] as const

export default function SurfacePreview() {
  return (
    <div className={styles.card}>
      <div className={styles.cardLabel}>Surfaces</div>
      <div className={styles.swatches}>
        {SURFACES.map(([label, token]) => (
          <div key={token} className={styles.swatch} style={{ background: `var(${token})` }}>
            <span className={styles.swatchLabel}>{label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
