import React from 'react'
import { Select } from '../../ui-kit'
import styles from './MidiImport.module.css'

// ── Re-import target picker ───────────────────────────────────────────────────
// One control per output row, deciding whether the row creates a fresh Pattern
// track or rewrites the notes of one that already exists.
//
// Only Pattern tracks ever appear here: `targets` comes from
// midi.getReimportTargets(), which omits Clip tracks entirely. A Pattern track
// carrying more than one distinct pattern comes back with eligible=false —
// there is no single note set to replace — so it is listed as disabled rather
// than hidden, because silently omitting a track the user is looking for reads
// as a bug.
export const MODE_NEW = 'new'
export const MODE_UPDATE = 'update'

// Builds the dropdown's options. Extracted because the Select renders only the
// closed trigger until it is opened, so the option list is not reachable from
// rendered markup.
export function buildTargetOptions(targets) {
  return [
    { value: MODE_NEW, label: 'New track' },
    ...(targets || []).map(t => ({
      value: String(t.trackId),
      label: t.eligible === false
        ? `${t.name} (${t.patternCount} patterns)`
        : `Update: ${t.name}`,
      disabled: t.eligible === false,
    })),
  ]
}

export default function MidiReimportModeSelect({
  targets,
  mode,
  targetTrackId,
  onChange,
  disabled,
  ariaLabel,
}) {
  const rows = targets || []
  // Nothing to update into: hide the control entirely rather than show a
  // one-option dropdown.
  if (rows.length === 0) return null

  const options = buildTargetOptions(rows)

  const value = (mode === MODE_UPDATE && Number(targetTrackId) >= 0)
    ? String(targetTrackId)
    : MODE_NEW

  return (
    <div className={styles.control}>
      <span className={styles.label}>Target</span>
      <Select
        value={value}
        options={options}
        onChange={next => onChange(next === MODE_NEW
          ? { mode: MODE_NEW, targetTrackId: -1 }
          : { mode: MODE_UPDATE, targetTrackId: Number(next) })}
        disabled={disabled}
        ariaLabel={ariaLabel}
      />
    </div>
  )
}
