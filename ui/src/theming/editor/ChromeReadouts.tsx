import { Button } from '../../ui-kit/Button'
import { formatValue } from '../../ui-kit/format'
import { contrastRatio } from '../../ui-kit/colorMath'
import { accentIdentityClashes } from '../runtime/chromeKnobs'
import { findTintedSurfaces, resolveHex } from '../runtime/chromeTint'
import styles from './ChromeReadouts.module.css'

interface Row {
  key: string
  label: string
  token: string
  /** WCAG floor for this role: 4.5 for text, 3 for control boundaries. */
  floor: number
}

// The three roles the Floor is written for: primary text, the dimmest text allowed, and
// control outlines, each against the panel colour (g1).
const ROWS: ReadonlyArray<Row> = [
  { key: 'ink', label: 'Ink', token: '--theme-ui-ink', floor: 4.5 },
  { key: 'ink-3', label: 'Ink 3', token: '--theme-ui-ink-3', floor: 4.5 },
  { key: 'boundary', label: 'Boundary', token: '--theme-ui-boundary', floor: 3 },
]

interface Props {
  /** The resolved token map of the theme being edited. */
  values: Record<string, string>
  /** When given, the tinted-chrome warning offers a one-click Neutralize. */
  onNeutralize?: () => void
}

/**
 * Live readouts for the theme being edited: contrast of ink, ink 3 and boundary against the
 * panel colour, the "tinted chrome" warning, and the accent / identity-colour hue clash.
 * Nothing here is colour-only: every row prints its ratio and says whether it passes.
 */
export default function ChromeReadouts({ values, onNeutralize }: Props) {
  const panel = resolveHex(values, '--theme-ui-g1')
  const tinted = findTintedSurfaces(values)
  const clashes = accentIdentityClashes(values)

  return (
    <div className={styles.root}>
      {tinted.length > 0 && (
        <div className={styles.warning} role="status" data-testid="tinted-chrome-warning">
          <div className={styles.warningText}>
            <strong>Tinted chrome.</strong> {tinted.length === 1 ? 'A surface carries' : `${tinted.length} surfaces carry`} a colour
            cast. Picture colour on the Preview is judged against its surround, so the shell is
            meant to stay neutral.
          </div>
          {onNeutralize && (
            <Button size="sm" onClick={onNeutralize} hint="Neutralize" hintMods="Sets the tint to zero; brightness and contrast are kept">
              Neutralize
            </Button>
          )}
        </div>
      )}

      <table className={styles.table} aria-label="Contrast against the panel colour">
        <thead>
          <tr>
            <th scope="col">Against panel</th>
            <th scope="col" className={styles.num}>Ratio</th>
            <th scope="col">Floor</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => {
            const fg = resolveHex(values, row.token)
            const ratio = fg && panel ? contrastRatio(fg, panel) : NaN
            const pass = ratio >= row.floor
            return (
              <tr key={row.key} data-pass={Number.isNaN(ratio) ? undefined : pass}>
                <th scope="row">
                  <span className={styles.swatch} style={{ background: fg ?? 'transparent' }} aria-hidden="true" />
                  {row.label}
                </th>
                <td className={styles.num}>{formatValue(ratio, 'ratio')}</td>
                <td>{Number.isNaN(ratio) ? '—' : `${pass ? 'Pass' : 'Below'} ${formatValue(row.floor, 'ratio')}`}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {clashes > 0 && (
        <div className={styles.note} role="status">
          Accent hue sits within 20° of {clashes} identity {clashes === 1 ? 'colour' : 'colours'}: a track in
          {clashes === 1 ? ' that colour' : ' those colours'} can read as the accent.
        </div>
      )}
    </div>
  )
}
