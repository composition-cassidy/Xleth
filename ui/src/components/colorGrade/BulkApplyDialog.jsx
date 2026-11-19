import { useEffect, useMemo, useState } from 'react'
import { Button, Checkbox, Dialog, SegmentedControl } from '../../ui-kit'
import { analyzeGrade, setManyGrades } from '../../colorGrade/gradeApi.js'
import { applyGradeToSources } from '../../colorGrade/gradeActions.js'
import { applyAuto, autoIsNoOp, neutralGrade } from '../../colorGrade/gradeModel.js'
import { useGradeSummaryStore, wireGradeSummary } from '../../colorGrade/useColorGrade.js'
import styles from './colorGrade.module.css'

// Bulk apply: put one Source grade on any number of sources (or every source
// in the project) in a single action, which is a single undo step.
//
// Two things can be applied:
//   This grade   the grade of the source the dialog was opened from, copied as is
//   Auto         each chosen source is analysed ON ITS OWN and given its own
//                correction, because different footage has different problems
//
// A source that already has a grade is never overwritten silently: the dialog
// says how many there are and asks whether to replace or skip them.

const WHAT = [
  { value: 'grade', label: 'This grade', hint: 'Copy this source’s grade to the chosen sources, exactly as it is.' },
  { value: 'auto', label: 'Auto, each on its own', hint: 'Analyse every chosen source separately and give each one its own correction.' },
]

const EXISTING = [
  { value: 'skip', label: 'Skip them', hint: 'Leave sources that already have a grade exactly as they are.' },
  { value: 'replace', label: 'Replace them', hint: 'Overwrite the grade those sources already have.' },
]

/**
 * @param {object} props
 * @param {number|null} props.fromSourceId   the source whose grade is being applied (left out of the list)
 * @param {string} props.fromName
 * @param {object} props.grade               that source's grade
 * @param {number[]} [props.preselected]     source ids ticked on open
 * @param {()=>void} props.onClose
 */
export default function BulkApplyDialog({ fromSourceId = null, fromName = '', grade, preselected = null, onClose }) {
  const [sources, setSources] = useState(null)
  const [picked, setPicked] = useState(() => new Set(preselected ?? []))
  const [what, setWhat] = useState(fromSourceId == null ? 'auto' : 'grade')
  const [onExisting, setOnExisting] = useState('skip')
  const [progress, setProgress] = useState(null)   // { done, total, name } while Auto runs
  const [result, setResult] = useState(null)

  useEffect(() => { wireGradeSummary() }, [])
  const graded = useGradeSummaryStore((s) => s.sources)

  useEffect(() => {
    let alive = true
    Promise.resolve(window.xleth?.timeline?.getSources?.())
      .then((list) => {
        if (!alive) return
        const video = (Array.isArray(list) ? list : []).filter((s) => s.hasVideo && s.id !== fromSourceId)
        setSources(video)
      })
      .catch(() => { if (alive) setSources([]) })
    return () => { alive = false }
  }, [fromSourceId])

  const ids = useMemo(() => (sources ?? []).map((s) => s.id), [sources])
  const chosen = ids.filter((id) => picked.has(id))
  const chosenWithGrade = chosen.filter((id) => graded.has(id))
  const allTicked = ids.length > 0 && chosen.length === ids.length
  const busy = progress !== null

  const toggle = (id, on) => setPicked((prev) => {
    const next = new Set(prev)
    if (on) next.add(id); else next.delete(id)
    return next
  })

  const apply = async () => {
    if (chosen.length === 0 || busy) return
    if (what === 'grade') {
      const res = await applyGradeToSources(grade, chosen, graded, onExisting)
      setResult(res
        ? { applied: res.applied, skipped: res.skipped, failed: 0 }
        : { error: 'The engine did not accept the change.' })
      return
    }

    // Auto: one analysis per source, then ONE write for all of them.
    const targets = chosen.filter((id) => !graded.has(id) || onExisting === 'replace')
    const skipped = chosen.length - targets.length
    const entries = []
    let unchanged = 0
    let failed = 0
    for (let i = 0; i < targets.length; i++) {
      const id = targets[i]
      const src = sources.find((s) => s.id === id)
      setProgress({ done: i, total: targets.length, name: src?.fileName ?? '' })
      const res = await analyzeGrade({ level: 'source', id })
      if (!res?.ok) { failed++; continue }
      if (autoIsNoOp(res.auto)) { unchanged++; continue }
      // Onto the grade the source has (its other controls are kept), or a
      // neutral one.
      const base = graded.get(id)?.grade ?? neutralGrade()
      entries.push({ level: 'source', id, grade: applyAuto(base, res.auto, 1) })
    }
    setProgress(null)
    if (entries.length > 0) {
      const res = await setManyGrades(entries,
        `Auto color grade on ${entries.length} source${entries.length === 1 ? '' : 's'}`)
      if (!res) { setResult({ error: 'The engine did not accept the change.' }); return }
    }
    setResult({ applied: entries.length, skipped, unchanged, failed })
  }

  if (result) {
    const lines = []
    if (result.error) lines.push(result.error)
    else {
      lines.push(`${result.applied} source${result.applied === 1 ? '' : 's'} graded. One undo takes all of it back.`)
      if (result.skipped) lines.push(`${result.skipped} skipped because they already had a grade.`)
      if (result.unchanged) lines.push(`${result.unchanged} already looked balanced, so Auto left them alone.`)
      if (result.failed) lines.push(`${result.failed} could not be analysed.`)
    }
    return (
      <Dialog
        title="Apply color grade" width="sm" onClose={onClose} onEnter={onClose}
        actions={<Button variant="primary" onClick={onClose}>Done</Button>}
      >
        {lines.map((l) => <p key={l} className={styles.bulkText} role="status">{l}</p>)}
      </Dialog>
    )
  }

  return (
    <Dialog
      title="Apply color grade to sources" width="md" flush onClose={busy ? undefined : onClose}
      dismissable={!busy}
      actions={(
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            variant="primary" onClick={apply} disabled={chosen.length === 0 || busy}
            data-testid="xleth-grade-bulk-apply"
          >
            {busy
              ? `Analysing ${progress.done + 1} of ${progress.total}…`
              : `Apply to ${chosen.length} source${chosen.length === 1 ? '' : 's'}`}
          </Button>
        </>
      )}
    >
      <p className={styles.bulkText}>
        {fromSourceId != null
          ? `Applies the source grade of ${fromName || 'this source'} to the sources you tick. It is one action and one undo step.`
          : 'Grades the sources you tick. It is one action and one undo step.'}
      </p>
      {fromSourceId != null ? (
        <div className={styles.bulkRow}>
          <span>What to apply</span>
          <SegmentedControl size="sm" label="What to apply" options={WHAT} value={what} onChange={setWhat} />
        </div>
      ) : null}
      <div className={styles.bulkRow}>
        <Checkbox
          checked={allTicked} indeterminate={chosen.length > 0 && !allTicked}
          disabled={busy || ids.length === 0}
          onChange={(on) => setPicked(on ? new Set(ids) : new Set())}
          data-testid="xleth-grade-bulk-all"
        >
          {`All sources in the project (${ids.length})`}
        </Checkbox>
      </div>
      {sources === null ? <p className={styles.bulkText}>Loading the sources&hellip;</p> : null}
      {sources !== null && ids.length === 0
        ? <p className={styles.bulkText}>There are no other video sources in this project.</p>
        : null}
      {ids.length > 0 ? (
        <ul className={styles.bulkList} aria-label="Sources">
          {sources.map((s) => (
            <li key={s.id} className={styles.bulkItem}>
              <Checkbox checked={picked.has(s.id)} disabled={busy} onChange={(on) => toggle(s.id, on)}>
                {s.fileName}
              </Checkbox>
              {graded.has(s.id) ? <span className={styles.bulkHas}>Has a grade</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {chosenWithGrade.length > 0 ? (
        <div className={styles.bulkRow}>
          <span>
            {`${chosenWithGrade.length} of the ticked source${chosenWithGrade.length === 1 ? ' already has' : 's already have'} a grade`}
          </span>
          <SegmentedControl
            size="sm" label="Sources that already have a grade" options={EXISTING}
            value={onExisting} onChange={setOnExisting}
          />
        </div>
      ) : null}
      {busy ? <p className={styles.bulkText} role="status">{`Looking at ${progress.name}…`}</p> : null}
    </Dialog>
  )
}
