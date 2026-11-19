import { useCallback, useEffect } from 'react'
import { Button } from '../../ui-kit'
import { iconComponent } from '../../ui-kit/icons'
import { openColorGrade, useGradeCompare } from '../../colorGrade/gradeActions.js'
import { useGradeState } from '../../colorGrade/useColorGrade.js'

// The Preview header's two Color Grade controls.
//
//   Grade     opens the Master grade (the look of the whole finished picture).
//             Its glyph fills in while a Master grade is rendering, so the
//             header itself says "this picture has an output grade".
//   Compare   HOLD to see the picture with every grade off, at every level;
//             let go and the grades are back. Preview only: it is never saved
//             and never reaches an export.
//
// Compare is a hold, not a toggle, on purpose: a before/after is a glance, and
// a toggle left on by accident would make the whole project look ungraded.

const IcPalette = iconComponent('palette')
const IcPaletteFill = iconComponent('palette', 'fill')
const IcCompare = iconComponent('circle-half')
const IcCompareFill = iconComponent('circle-half', 'fill')

const MASTER = { level: 'master' }

/** @param {{ labelClass?: string }} props  the header's class that hides text when narrow */
export default function PreviewGradeControls({ labelClass }) {
  const masterState = useGradeState(MASTER)
  const comparing = useGradeCompare((s) => s.on)
  const setCompare = useGradeCompare((s) => s.set)

  const start = useCallback(() => setCompare(true), [setCompare])
  const stop = useCallback(() => { if (useGradeCompare.getState().on) setCompare(false) }, [setCompare])

  // Never leave the picture ungraded: if the button goes away mid-hold, or the
  // window loses the pointer, the grades come back.
  useEffect(() => {
    window.addEventListener('blur', stop)
    return () => { window.removeEventListener('blur', stop); stop() }
  }, [stop])

  const holdKey = (e) => {
    if (e.key !== ' ' && e.key !== 'Enter') return
    e.preventDefault()
    if (!e.repeat) start()
  }
  const releaseKey = (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); stop() }
  }

  return (
    <>
      <Button
        size="sm"
        glyph={masterState === 'on' ? <IcPaletteFill aria-hidden="true" /> : <IcPalette aria-hidden="true" />}
        aria-label={masterState === 'on' ? 'Master grade (on)' : 'Master grade'}
        data-testid="preview-master-grade"
        data-state={masterState}
        hint={masterState === 'on'
          ? 'Master grade: a color grade is applied to the whole finished picture. Click to edit it.'
          : 'Master grade: one color grade over the whole finished picture, in the preview and the export.'}
        onClick={() => openColorGrade(MASTER, { name: 'Whole picture' })}
      >
        <span className={labelClass}>Grade</span>
      </Button>
      <Button
        size="sm"
        glyph={comparing ? <IcCompareFill aria-hidden="true" /> : <IcCompare aria-hidden="true" />}
        aria-label="Hold to compare without color grades"
        aria-pressed={comparing}
        data-testid="preview-grade-compare"
        hint="Hold to see the picture without any color grade. Let go to bring them back. Preview only."
        onPointerDown={(e) => { e.currentTarget.setPointerCapture?.(e.pointerId); start() }}
        onPointerUp={stop}
        onPointerCancel={stop}
        onLostPointerCapture={stop}
        onKeyDown={holdKey}
        onKeyUp={releaseKey}
        onBlur={stop}
      >
        <span className={labelClass}>Compare</span>
      </Button>
    </>
  )
}
