import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button, IconButton, Menu, MenuItem, MenuSeparator, NumberBox, Tabs, Toggle,
} from '../../ui-kit'
import { iconComponent } from '../../ui-kit/icons'
import { analyzeGrade, checkLut } from '../../colorGrade/gradeApi.js'
import {
  canPaste, setGradeBypassed, useGradeAutoStore, useGradeClipboard,
} from '../../colorGrade/gradeActions.js'
import {
  EXPOSURE_RANGE, HUE_RANGE, LEVEL_INFO, applyAuto, autoIsNoOp, cloneGrade, isNeutral,
  resetGrade, resetSection, sectionIsNeutral, targetKey,
} from '../../colorGrade/gradeModel.js'
import { frameHistogram, readPreviewFrame } from '../../colorGrade/frameFeed.js'
import { useColorGrade } from '../../colorGrade/useColorGrade.js'
import ColorWheel from './ColorWheel.jsx'
import CurveEditor from './CurveEditor.jsx'
import GradeScopes from './GradeScopes.jsx'
import BulkApplyDialog from './BulkApplyDialog.jsx'
import styles from './colorGrade.module.css'

// The Color Grade panel: ONE design for all four levels (Source, Clip, Layer,
// Master), so it is learned once. Only the header line says which level this
// is and whose grade it is.
//
// Basics come first, on one screen, in plain words, with Auto beside them.
// Tonal balance (the wheels) and Curves are one click away as tabs, never
// buried. Every control previews live in the picture and is one undo step on
// release.

const IcMore = iconComponent('dots-three')
const IcWand = iconComponent('magic-wand')

const TABS = [
  { id: 'basics', label: 'Basics' },
  { id: 'tonal', label: 'Tonal balance' },
  { id: 'curves', label: 'Curves' },
  { id: 'lut', label: 'LUT' },
  { id: 'scopes', label: 'Scopes' },
]

const MINUS = '−'
const signed = (n, text) => `${n > 0 ? '+' : n < 0 ? MINUS : ''}${text}`
const parseNumber = (text) => {
  const n = Number(String(text).replace(MINUS, '-').replace(/[^0-9.+-]/g, ''))
  return Number.isFinite(n) ? n : null
}
const pctFormat = (v) => signed(Math.round(v * 100), String(Math.abs(Math.round(v * 100))))
const pctParse = (text) => { const n = parseNumber(text); return n === null ? null : n / 100 }
const stopsFormat = (v) => signed(Math.round(v * 100), Math.abs(v).toFixed(2))
const degFormat = (v) => `${signed(Math.round(v), String(Math.abs(Math.round(v))))}°`
const amountFormat = (v) => `${Math.round(v * 100)} %`

// Plain language first; the technical name is in the hint (spec "UI intent").
const BASICS = [
  {
    key: 'exposure', label: 'Exposure', min: -EXPOSURE_RANGE, max: EXPOSURE_RANGE, step: 0.05,
    format: stopsFormat, parse: parseNumber, ends: ['Darker', 'Brighter'],
    hint: 'Overall brightness, in stops. +1 is twice the light, the way a camera exposes.',
  },
  {
    key: 'contrast', label: 'Contrast', min: -1, max: 1, step: 0.01,
    format: pctFormat, parse: pctParse, ends: ['Flatter', 'Punchier'],
    hint: 'More contrast makes darks darker and brights brighter. Black and white themselves stay put.',
  },
  {
    key: 'saturation', label: 'Saturation', min: -1, max: 1, step: 0.01,
    format: pctFormat, parse: pctParse, ends: ['Grey', 'Vivid'],
    hint: 'How strong every colour is. All the way down is black and white.',
  },
  {
    key: 'vibrance', label: 'Vibrance', min: -1, max: 1, step: 0.01,
    format: pctFormat, parse: pctParse, ends: ['Muted', 'Richer'],
    hint: 'Like Saturation, but it lifts dull colours more than strong ones. Kinder to skin and faded footage.',
  },
  {
    key: 'temperature', label: 'Temperature', min: -1, max: 1, step: 0.01,
    format: pctFormat, parse: pctParse, ends: ['Cooler', 'Warmer'],
    hint: 'Fixes a blue or orange cast. Towards warmer adds orange; towards cooler adds blue.',
  },
  {
    key: 'tint', label: 'Tint', min: -1, max: 1, step: 0.01,
    format: pctFormat, parse: pctParse, ends: ['Green', 'Magenta'],
    hint: 'Fixes a green or magenta cast.',
  },
  {
    key: 'hue', label: 'Hue shift', min: -HUE_RANGE, max: HUE_RANGE, step: 1, pxPerRange: 360,
    format: degFormat, parse: parseNumber, ends: null,
    hint: 'Turns every colour round the colour wheel by the same amount.',
  },
]

const WHEELS = [
  {
    key: 'lift', name: 'Lift', plain: 'Shadows',
    hint: 'Lift: the dark parts of the picture. Drag to tint the shadows; the box under it makes them darker or brighter. Lower it to pull washed-out blacks back down.',
  },
  {
    key: 'gamma', name: 'Gamma', plain: 'Midtones',
    hint: 'Gamma: the middle of the picture, between black and white. Drag to tint the midtones; the box under it brightens or darkens them and leaves black and white alone.',
  },
  {
    key: 'gain', name: 'Gain', plain: 'Highlights',
    hint: 'Gain: the bright parts of the picture. Drag to tint the highlights; the box under it scales how bright they are and leaves black alone.',
  },
]

function Row({ label, ends, children }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <div className={styles.rowControl}>
        {children}
        {ends ? <span className={styles.rowEnds}>{`${ends[0]} ↔ ${ends[1]}`}</span> : null}
      </div>
    </div>
  )
}

/** The picture's histogram, refreshed a few times a second while `active`. */
function useLiveHistogram(active) {
  const [hist, setHist] = useState(null)
  useEffect(() => {
    if (!active) return undefined
    const read = () => {
      const frame = readPreviewFrame()
      setHist(frame ? frameHistogram(frame) : null)
    }
    read()
    const id = setInterval(read, 400)
    return () => clearInterval(id)
  }, [active])
  return hist
}

const fileName = (path) => String(path).split(/[\\/]/).pop() || path

/**
 * @param {object} props
 * @param {{level:'source'|'clip'|'region'|'layer'|'master', id?:number}} props.target
 * @param {string} [props.name]   the owner's name ("intro.mp4", "Chorus")
 */
export default function ColorGradePanel({ target, name = '' }) {
  const edit = useColorGrade(target)
  const { grade } = edit
  const key = targetKey(target)
  const info = LEVEL_INFO[target?.level] ?? LEVEL_INFO.master

  const [tab, setTab] = useState('basics')
  const [menu, setMenu] = useState(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(null)       // { text, tone }
  const [bulkOpen, setBulkOpen] = useState(false)
  const moreRef = useRef(null)

  const autoEntry = useGradeAutoStore((s) => s.byKey[key] ?? null)
  const clipboard = useGradeClipboard()
  const liveHistogram = useLiveHistogram(tab === 'curves' && !autoEntry?.analysis)

  // A different owner: yesterday's note is not about this one.
  useEffect(() => { setNote(null); setBusy(false) }, [key])

  const runAuto = useCallback(async () => {
    if (!grade) return
    setBusy(true)
    setNote({ text: 'Looking at the footage…', tone: 'info' })
    const res = await analyzeGrade(target)
    setBusy(false)
    if (!res?.ok) {
      setNote({ text: `Auto could not run: ${res?.error ?? 'no answer from the engine'}.`, tone: 'problem' })
      return
    }
    const noOp = autoIsNoOp(res.auto)
    useGradeAutoStore.getState().put(target, { auto: res.auto, analysis: res.analysis, strength: 1, noOp })
    if (noOp) {
      setNote({ text: 'This footage already looks balanced, so Auto changed nothing.', tone: 'info' })
      return
    }
    await edit.commit((g) => applyAuto(g, res.auto, 1), 'Auto color grade')
    setNote({
      text: 'Auto set the tonal balance and the colour strength. Every value it chose is on the Basics and Tonal balance tabs; change any of them, or turn Strength down.',
      tone: 'info',
    })
  }, [grade, target, edit])

  const pickLut = useCallback(async () => {
    const open = window.xleth?.dialog?.openLutDialog
    if (typeof open !== 'function') {
      setNote({ text: 'The LUT file picker is not available in this build.', tone: 'problem' })
      return
    }
    const path = await open()
    if (!path) return
    const check = await checkLut(path)
    if (!check?.ok) {
      setNote({ text: `That file could not be used as a LUT: ${check?.error ?? 'unknown reason'}.`, tone: 'problem' })
      return
    }
    setNote(null)
    await edit.commit((g) => ({ ...g, lut: { path, amount: g.lut.amount > 0 ? g.lut.amount : 1 } }), 'Import LUT')
  }, [edit])

  const openMenu = () => {
    const r = moreRef.current?.getBoundingClientRect()
    setMenu(r ? { x: r.right, y: r.bottom + 2 } : { x: 0, y: 0 })
  }

  const histogram = useMemo(() => {
    const a = autoEntry?.analysis
    if (a?.luma) return { r: a.r, g: a.g, b: a.b, luma: a.luma }
    return liveHistogram
  }, [autoEntry, liveHistogram])

  if (!edit.ready || !grade) {
    return (
      <div className={styles.root} data-testid="xleth-grade-panel">
        <div className={styles.head}>
          <div className={styles.headText}>
            <h2 className={styles.title}>{info.title}</h2>
            {name ? <span className={styles.owner} title={name}>{name}</span> : null}
          </div>
        </div>
        <p className={styles.note}>
          {target?.level ? 'Loading the grade…' : 'Nothing to grade is selected.'}
        </p>
      </div>
    )
  }

  const off = grade.bypassed
  const neutral = isNeutral(grade)
  const field = (k) => ({
    onChange: (v) => edit.preview((g) => ({ ...g, [k]: v })),
    onCommit: (v) => edit.commit((g) => ({ ...g, [k]: v })),
    onCancel: () => edit.cancel(),
  })
  const histogramCaption = autoEntry?.analysis
    ? 'Behind the curve: the tones of the whole footage (from Auto’s analysis).'
    : histogram
      ? 'Behind the curve: the tones of the preview picture right now.'
      : 'Open the Preview to see the picture’s tones behind the curve.'

  return (
    <div className={styles.root} data-testid="xleth-grade-panel" data-level={target.level}>
      <div className={styles.head}>
        <div className={styles.headText}>
          <h2 className={styles.title}>{off ? `${info.title} · Off` : info.title}</h2>
          {name ? <span className={styles.owner} title={name}>{name}</span> : null}
        </div>
        <div className={styles.headActions}>
          <Button
            size="sm" glyph={<IcWand aria-hidden="true" />} disabled={busy} onClick={runAuto}
            data-testid="xleth-grade-auto"
            hint="Auto: looks at the whole footage and sets a sensible correction for faded, washed-out or colour-cast video. It only moves ordinary controls, so you can see and change everything it did."
          >
            {busy ? 'Working…' : 'Auto'}
          </Button>
          <Toggle
            size="sm" on={!off} data-testid="xleth-grade-on"
            onChange={(on) => setGradeBypassed(target, !on)}
            hint={off
              ? 'This grade is switched off. Its values are kept. Click to switch it back on.'
              : 'This grade is on. Click to switch it off and see the picture without it. Its values are kept.'}
          >
            On
          </Toggle>
          <IconButton
            ref={moreRef} size="sm" label="Copy, paste and reset" onClick={openMenu}
            hint="Copy this grade, paste one, or reset it."
          >
            <IcMore aria-hidden="true" />
          </IconButton>
        </div>
      </div>

      <p className={styles.blurb}>{info.blurb}</p>
      {note ? <p className={styles.note} data-tone={note.tone} role="status">{note.text}</p> : null}
      {edit.lutError && grade.lut.path
        ? <p className={styles.note} data-tone="problem" role="status">{`The LUT is not being applied: ${edit.lutError}.`}</p>
        : null}

      <div className={styles.tabs}>
        <Tabs label="Color grade sections" tabs={TABS} value={tab} onChange={setTab} />
      </div>

      <div className={styles.body} data-off={off || undefined}>
        {tab === 'basics' && (
          <>
            {autoEntry && !autoEntry.noOp ? (
              <Row label="Auto strength">
                <NumberBox
                  label="Auto strength" hideLabel width={96} min={0} max={1} step={0.01} defaultValue={1}
                  value={autoEntry.strength} format={amountFormat} parse={pctParse}
                  data-testid="xleth-grade-auto-strength"
                  onChange={(s) => {
                    useGradeAutoStore.getState().patch(target, { strength: s })
                    edit.preview((g) => applyAuto(g, autoEntry.auto, s))
                  }}
                  onCommit={(s) => {
                    useGradeAutoStore.getState().patch(target, { strength: s })
                    edit.commit((g) => applyAuto(g, autoEntry.auto, s), 'Auto strength')
                  }}
                  onCancel={() => edit.cancel()}
                  hint="How much of Auto's correction to use. 0 % is none of it, 100 % is all of it. Dark or stylised footage often wants less."
                />
              </Row>
            ) : null}
            {BASICS.map((b) => (
              <Row key={b.key} label={b.label} ends={b.ends}>
                <NumberBox
                  label={b.label} hideLabel width={96} min={b.min} max={b.max} step={b.step}
                  defaultValue={0} bipolar centre={0} pxPerRange={b.pxPerRange}
                  value={grade[b.key]} format={b.format} parse={b.parse}
                  data-testid={`xleth-grade-${b.key}`}
                  hint={b.hint}
                  {...field(b.key)}
                />
              </Row>
            ))}
            <div className={styles.actions}>
              <Button
                size="sm" disabled={sectionIsNeutral(grade, 'basics')}
                onClick={() => edit.commit((g) => resetSection(g, 'basics'), 'Reset basics')}
                hint="Put every control on this tab back to no change."
              >
                Reset basics
              </Button>
            </div>
          </>
        )}

        {tab === 'tonal' && (
          <>
            <div className={styles.wheels}>
              {WHEELS.map((w) => (
                <ColorWheel
                  key={w.key} name={w.name} plain={w.plain} hint={w.hint} value={grade[w.key]}
                  onPreview={(v) => edit.preview((g) => ({ ...g, [w.key]: v }))}
                  onCommit={(v) => edit.commit((g) => ({ ...g, [w.key]: v }))}
                  onCancel={() => edit.cancel()}
                />
              ))}
            </div>
            <p className={styles.caption}>
              Drag a wheel towards a colour to tint that part of the picture; the number under it makes
              that part darker or brighter.
            </p>
            <div className={styles.actions}>
              <Button
                size="sm" disabled={sectionIsNeutral(grade, 'wheels')}
                onClick={() => edit.commit((g) => resetSection(g, 'wheels'), 'Reset tonal balance')}
                hint="Put all three wheels and their brightness back to no change."
              >
                Reset tonal balance
              </Button>
            </div>
          </>
        )}

        {tab === 'curves' && (
          <>
            <CurveEditor
              curves={grade.curves}
              histogram={histogram}
              histogramCaption={histogramCaption}
              onPreview={(curves) => edit.preview((g) => ({ ...g, curves }))}
              onCommit={(curves) => edit.commit((g) => ({ ...g, curves }))}
              onCancel={() => edit.cancel()}
            />
            <div className={styles.actions}>
              <Button
                size="sm" disabled={sectionIsNeutral(grade, 'curves')}
                onClick={() => edit.commit((g) => resetSection(g, 'curves'), 'Reset curves')}
                hint="Put all four curves back to the straight diagonal."
              >
                Reset all curves
              </Button>
            </div>
          </>
        )}

        {tab === 'lut' && (
          <>
            <p className={styles.blurb}>
              A LUT is a finished look made in another program, saved as a .cube file. It is applied last,
              after everything else in this grade.
            </p>
            <Row label="File">
              {grade.lut.path
                ? <span className={styles.path} title={grade.lut.path}>{fileName(grade.lut.path)}</span>
                : <span className={styles.rowEnds}>No LUT</span>}
            </Row>
            <Row label="Amount">
              <NumberBox
                label="LUT amount" hideLabel width={96} min={0} max={1} step={0.01} defaultValue={1}
                disabled={!grade.lut.path}
                value={grade.lut.amount} format={amountFormat} parse={pctParse}
                onChange={(amount) => edit.preview((g) => ({ ...g, lut: { ...g.lut, amount } }))}
                onCommit={(amount) => edit.commit((g) => ({ ...g, lut: { ...g.lut, amount } }))}
                onCancel={() => edit.cancel()}
                hint="How much of the LUT's look to mix in. 0 % is none of it."
              />
            </Row>
            <div className={styles.actions}>
              <Button size="sm" onClick={pickLut} hint="Choose a .cube file. Only 3D LUTs can be imported.">
                {grade.lut.path ? 'Choose another…' : 'Choose a .cube file…'}
              </Button>
              <Button
                size="sm" disabled={!grade.lut.path}
                onClick={() => edit.commit((g) => resetSection(g, 'lut'), 'Remove LUT')}
                hint="Take the LUT off this grade. The file itself is not touched."
              >
                Remove LUT
              </Button>
            </div>
          </>
        )}

        {tab === 'scopes' && <GradeScopes />}
      </div>

      {menu ? (
        <Menu x={menu.x} y={menu.y} flipX onClose={() => setMenu(null)} label="Color grade actions">
          <MenuItem onSelect={() => { clipboard.copy(target.level, grade); setMenu(null) }}>
            Copy grade
          </MenuItem>
          <MenuItem
            disabled={!canPaste(clipboard, target.level)}
            onSelect={() => {
              setMenu(null)
              // Paste the values; this owner keeps its own on/off state.
              edit.commit({ ...cloneGrade(clipboard.grade), bypassed: grade.bypassed }, 'Paste color grade')
            }}
          >
            {canPaste(clipboard, target.level) || !clipboard.grade
              ? 'Paste grade'
              : `Paste grade (copied from a ${LEVEL_INFO[clipboard.level].name.toLowerCase()})`}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            disabled={neutral}
            onSelect={() => { setMenu(null); edit.commit(resetGrade(grade), `Reset ${info.title.toLowerCase()}`) }}
          >
            Reset whole grade
          </MenuItem>
          {target.level === 'source' ? (
            <>
              <MenuSeparator />
              <MenuItem onSelect={() => { setMenu(null); setBulkOpen(true) }}>
                Apply to other sources&hellip;
              </MenuItem>
            </>
          ) : null}
        </Menu>
      ) : null}

      {bulkOpen ? (
        <BulkApplyDialog fromSourceId={target.id} fromName={name} grade={grade} onClose={() => setBulkOpen(false)} />
      ) : null}
    </div>
  )
}
