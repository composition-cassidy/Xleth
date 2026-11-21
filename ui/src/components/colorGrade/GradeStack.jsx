import { useEffect } from 'react'
import { Button } from '../../ui-kit'
import { iconComponent } from '../../ui-kit/icons'
import RowToggle from '../inspector/RowToggle.jsx'
import { openColorGrade, setGradeBypassed } from '../../colorGrade/gradeActions.js'
import { LEVEL_INFO, sameTarget } from '../../colorGrade/gradeModel.js'
import {
  summaryEntry, useGradeState, useGradeSummaryStore, wireGradeSummary,
} from '../../colorGrade/useColorGrade.js'
import styles from './colorGrade.module.css'

// "Where does this look come from?" Four levels can hide the answer, so every
// graded owner carries an indicator, and any picture can show its whole stack:
// each level in the order it is applied, whether it is on, and a way to jump
// to it or switch it off right here.

const IcPalette = iconComponent('palette')
const IcPaletteFill = iconComponent('palette', 'fill')

const STATE_TEXT = { none: 'No grade', on: 'On', off: 'Off' }

/**
 * A small mark on anything that has a non-neutral grade. Filled = the grade is
 * rendering; outlined and dim = it is kept but switched off. Nothing at all
 * when the owner has no grade. The state is in the shape and in the title, not
 * only in the tone.
 */
export function GradeIndicator({ target, className }) {
  const state = useGradeState(target)
  if (state === 'none') return null
  const name = LEVEL_INFO[target.level]?.title ?? 'Color grade'
  const label = state === 'on' ? `${name}: on` : `${name}: switched off`
  return (
    <span
      className={`${styles.indicator}${className ? ` ${className}` : ''}`}
      data-state={state}
      role="img"
      aria-label={label}
      title={label}
      data-testid="xleth-grade-indicator"
    >
      {state === 'on' ? <IcPaletteFill aria-hidden="true" /> : <IcPalette aria-hidden="true" />}
    </span>
  )
}

/** Build the rows of a stack from what is known about a picture. */
export function stackRows(stack) {
  const rows = []
  if (stack?.source?.id != null) {
    rows.push({ target: { level: 'source', id: stack.source.id }, name: stack.source.name ?? '' })
  }
  if (stack?.clip?.id != null) {
    const level = stack.clip.level === 'region' ? 'region' : 'clip'
    rows.push({ target: { level, id: stack.clip.id }, name: stack.clip.name ?? '' })
  }
  if (stack?.layer?.id != null) {
    rows.push({ target: { level: 'layer', id: stack.layer.id }, name: stack.layer.name ?? '' })
  }
  rows.push({ target: { level: 'master' }, name: 'Whole picture' })
  return rows
}

/**
 * The stack view.
 * @param {object} props
 * @param {object} props.stack     { source:{id,name}, clip:{level,id,name}, layer:{id,name} }; Master is always added
 * @param {object} [props.current] the level being edited (outlined), if any
 * @param {(target, name)=>void} [props.onOpen]  open a level; default opens the Color Grade window
 * @param {string} [props.openLabel]
 */
export default function GradeStack({ stack, current = null, onOpen, openLabel = 'Edit' }) {
  useEffect(() => { wireGradeSummary() }, [])
  const summary = useGradeSummaryStore()
  const rows = stackRows(stack)

  return (
    <ol className={styles.stack} aria-label="Color grade stack, in the order it is applied" data-testid="xleth-grade-stack">
      {rows.map((row, i) => {
        const entry = summaryEntry(summary, row.target)
        const state = !entry ? 'none' : entry.active ? 'on' : 'off'
        const info = LEVEL_INFO[row.target.level]
        // "Off" covers two cases; say which, so a neutral grade that is
        // switched on is not mistaken for one that was switched off.
        const stateText = entry && !entry.active && !entry.grade.bypassed ? 'No change' : STATE_TEXT[state]
        const open = () => (onOpen
          ? onOpen(row.target, row.name)
          : openColorGrade(row.target, { name: row.name, stack }))
        return (
          <li
            key={row.target.level}
            className={styles.stackRow}
            data-current={sameTarget(row.target, current) || undefined}
            data-level={row.target.level}
            data-state={state}
          >
            <span className={styles.stackStep} aria-hidden="true">{i + 1}</span>
            <span className={styles.stackText}>
              <span className={styles.stackLevel}>{info.name}</span>
              <span className={styles.stackOwner} title={row.name}>{row.name}</span>
            </span>
            <span className={styles.stackState} data-state={state}>{stateText}</span>
            <span className={styles.stackControls}>
              <RowToggle
                label={`${info.title} on`}
                on={!!entry && !entry.grade.bypassed}
                disabled={!entry}
                onChange={(on) => setGradeBypassed(row.target, !on)}
                data-testid={`xleth-grade-stack-on-${row.target.level}`}
                hint={entry
                  ? `Switch the ${info.title.toLowerCase()} ${entry.grade.bypassed ? 'on' : 'off'}. Its values are kept either way.`
                  : `There is no ${info.title.toLowerCase()} yet. Open it to make one.`}
              />
              <Button
                size="sm" variant="ghost" onClick={open}
                data-testid={`xleth-grade-stack-open-${row.target.level}`}
                hint={`${info.title}: ${info.blurb}`}
              >
                {openLabel}
              </Button>
            </span>
          </li>
        )
      })}
    </ol>
  )
}
