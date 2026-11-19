import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, NumberBox, SegmentedControl } from '../../ui-kit'
import {
  cloneKindLabel, clonesOf, isClone, isTrailClone, isVoiceClone, noteFilterFor, sourceOf, voiceNumberOf,
} from '../../clones/cloneModel.js'
import { setCloneSettings } from '../../clones/cloneApi.js'
import { normalizeClone, trailOpacityValueAt } from '../../motion/cloneMotion.js'
import { formatValue, numberBoxProps, propertyById } from '../../motion/schema.js'
import { buildNoteStrip } from '../../motion/useMotionData.js'
import { usePlayheadTick, useRefreshOn } from '../../lensRoam/useLensRoam.js'
import { requestMotionReveal } from '../timeline/motionReveal.js'
import { DelayPicker, TintField, delayText } from '../motionView/TrailControls.jsx'
import { TrackSection, TRow, trackStyles as t } from './TrackSection.jsx'
import styles from './CloneSection.module.css'

// The Inspector's Clone section (docs/XLETH_CLONE_SPEC.md):
//   Voice clone  which voice it is and how many notes it plays, and its Lens:
//                Linked (plays the source's Track Lens and hit curves) | Own (its
//                own Track Lens, seeded by the engine with a copy of the source's).
//   Trail clone  whom it follows and how far behind, Delay, Tint, Opacity. Its
//                added Roam (Offset X / Y) is RoamPanel's 'trail' variant.
// ClonesListSection: a source Pattern track's Clones, read-only.
// Every write is one setCloneSettings call (one undo step, cloneApi announces it).

const OPACITY = propertyById('trail.opacity')
const OPACITY_BOX = numberBoxProps(OPACITY)
const NOTE_EVENTS = Object.freeze([
  'timeline-patterns-changed', 'timeline-pattern-changed', 'timeline-pattern-blocks-changed', 'timeline-tracks-changed',
])

const LENS_OPTIONS = [
  { value: 'Linked', label: 'Linked', hint: "Play the source's Track Lens and hit curve: edit them once, every voice follows." },
  { value: 'Own', label: 'Own', hint: "Give this Voice clone its own Track Lens, starting from a copy of the source's." },
]

/**
 * How many note instances a Clone plays on the timeline (its Reel lane's count):
 * the source's blocks walked like the engine, filtered to this cell's voice.
 * null while loading. Refetches on the pattern / block / track events.
 */
export function useCloneNoteCount(track, tracks) {
  const sourceId = isClone(track) ? track.cloneOf : null
  const [state, setState] = useState(null)
  const token = useRef(0)
  const refresh = useCallback(async () => {
    if (sourceId === null) { setState(null); return }
    const mine = ++token.current
    const tl = window.xleth?.timeline
    try {
      const all = await tl?.getPatternBlocks?.()
      const blocks = (Array.isArray(all) ? all : []).filter((b) => b.trackId === sourceId)
      const ids = [...new Set(blocks.map((b) => b.patternId))]
      const pats = await Promise.all(ids.map((id) => tl?.getPattern?.(id)))
      if (mine !== token.current) return
      const patterns = {}
      for (const p of pats) if (p && p.id != null) patterns[p.id] = p
      setState({ blocks, patterns })
    } catch (err) {
      console.error('[Clones] note count refresh failed:', err?.message ?? err)
    }
  }, [sourceId])
  useEffect(() => { refresh() }, [refresh])
  useRefreshOn(NOTE_EVENTS, refresh)
  return useMemo(() => {
    if (!state || !track) return null
    return buildNoteStrip(state.blocks, state.patterns, { filterFor: (p) => noteFilterFor(tracks, track, p) }).count
  }, [state, track, tracks])
}

/** 'plays 12 notes' / 'plays 1 note' / 'counting notes…'. */
export const playsText = (n) => (n === null || n === undefined ? 'counting notes…' : `plays ${n} note${n === 1 ? '' : 's'}`)

function VoiceBody({ track, tracks, sourceName }) {
  const c = normalizeClone(track.clone)
  const [pending, setPending] = useState(null)
  useEffect(() => { setPending(null) }, [c?.lensMode])
  const voice = voiceNumberOf(tracks, track)
  const count = useCloneNoteCount(track, tracks)
  const mode = pending ?? c?.lensMode ?? 'Linked'
  const setMode = async (lensMode) => {
    if (lensMode === mode) return
    setPending(lensMode)
    const res = await setCloneSettings(track.id, { lensMode })
    if (!res?.changed) setPending(null)
  }
  return (
    <>
      <TRow label="Source"><span className={t.value}>{sourceName}</span></TRow>
      <TRow label="Voice">
        <span className={t.value} data-testid="clone-voice">{`Voice ${voice ?? '?'} · ${playsText(count)}`}</span>
      </TRow>
      <TRow label="Lens">
        <SegmentedControl
          size="sm" label="Clone Lens" value={mode} options={LENS_OPTIONS} onChange={setMode}
          hint={mode === 'Own'
            ? `Its own Track Lens: edit it in Motion view (its Lens rows) or on its notes. Linked goes back to ${sourceName}'s.`
            : `Plays ${sourceName}'s Track Lens and hit curve. Own gives it its own, starting from a copy.`}
          data-testid="clone-lens-mode"
        />
      </TRow>
      <p className={t.note}>
        {mode === 'Own'
          ? 'Its own Track Lens and hit curve. Per-note Lens keys still travel with each note.'
          : `Uses ${sourceName}'s Track Lens and hit curve. Per-note Lens keys travel with each note.`}
      </p>
    </>
  )
}

function TrailBody({ track, sourceName }) {
  const c = normalizeClone(track.clone)
  const keyed = (c?.opacityKeys?.length ?? 0) > 0
  const tick = usePlayheadTick(keyed)
  const [pending, setPending] = useState(null)
  useEffect(() => { setPending(null) }, [track.clone])
  const shown = { ...c, ...pending }
  const write = async (patch) => {
    setPending((p) => ({ ...p, ...patch }))
    const res = await setCloneSettings(track.id, patch)
    if (!res?.changed) setPending(null)
  }
  if (!c) return null
  const opacityNow = keyed ? trailOpacityValueAt(c, tick) : shown.opacity
  return (
    <>
      <TRow label="Follows">
        <span className={t.value} data-testid="clone-follows">{`${sourceName}, ${delayText(shown.delayTicks)} behind`}</span>
      </TRow>
      <TRow label="Delay">
        <DelayPicker
          value={shown.delayTicks} onCommit={(delayTicks) => write({ delayTicks })} width={120}
          data-testid="clone-delay"
        />
      </TRow>
      <TRow label="Tint">
        <TintField value={shown.tint} onCommit={(tint) => write({ tint })} width={120} data-testid="clone-tint" />
      </TRow>
      <TRow label="Opacity">
        <NumberBox
          {...OPACITY_BOX}
          label="Trail opacity" hideLabel width={72}
          value={opacityNow}
          disabled={keyed}
          onCommit={(v) => { const opacity = Math.min(1, Math.max(0, v)); if (opacity !== c.opacity) write({ opacity }) }}
          hint={keyed
            ? `Opacity is keyed: ${formatValue(OPACITY, opacityNow)} at the playhead. Edit its keys in Motion view.`
            : "How strongly the Trail's picture shows."}
          data-testid="clone-opacity"
        />
        {keyed ? (
          <Button
            size="sm" onClick={() => requestMotionReveal(track.id, ['trail'])}
            hint="Show this Trail's rows in Motion view (`), where its opacity keys are drawn and edited."
          >
            Show in Motion view
          </Button>
        ) : null}
      </TRow>
    </>
  )
}

/**
 * The Clone section of a Clone track. Props: track (getTracks shape, with `clone`),
 * tracks (every track: the source, the voice order).
 */
export default function CloneSection({ track, tracks }) {
  if (!isClone(track)) return null
  const src = sourceOf(tracks, track)
  const sourceName = src?.name ?? 'its source'
  const trail = isTrailClone(track)
  const c = normalizeClone(track.clone)
  const summary = trail
    ? `Follows ${sourceName}, ${c ? delayText(c.delayTicks) : ''} behind`
    : `Voice ${voiceNumberOf(tracks, track) ?? '?'} of ${sourceName} · Lens ${c?.lensMode === 'Own' ? 'own' : 'linked'}`
  return (
    <TrackSection
      id={trail ? 'trailClone' : 'voiceClone'} title="Clone" testId="xleth-inspector-clone"
      summary={summary}
      hint={trail
        ? `Trail clone: replays ${sourceName}'s whole picture a set time later, tinted and faded. Video only.`
        : `Voice clone: plays the notes ${sourceName} cannot, in its own cell. Video only; every note still sounds from ${sourceName}.`}
    >
      {trail
        ? <TrailBody track={track} sourceName={sourceName} />
        : isVoiceClone(track) ? <VoiceBody track={track} tracks={tracks} sourceName={sourceName} /> : null}
    </TrackSection>
  )
}

/** A source Pattern track's Clones, read-only (each: name, kind, voice or delay). Null without Clones. */
export function ClonesListSection({ track, tracks }) {
  const list = !track || isClone(track) ? [] : clonesOf(tracks, track.id)
  if (list.length === 0) return null
  const voices = list.filter(isVoiceClone).length
  const trails = list.length - voices
  const parts = []
  if (voices) parts.push(`${voices} voice${voices === 1 ? '' : 's'}`)
  if (trails) parts.push(`${trails} trail${trails === 1 ? '' : 's'}`)
  return (
    <TrackSection
      id="clonesList" title="Clones" testId="xleth-inspector-clones"
      summary={parts.join(' · ')}
      hint="Video-only copies this track drives. Select one in the track list to edit it."
    >
      <ul className={styles.list} aria-label={`Clones of ${track.name}`}>
        {list.map((c) => {
          const s = normalizeClone(c.clone)
          const detail = isTrailClone(c)
            ? `${delayText(s?.delayTicks ?? 0)} behind`
            : `voice ${voiceNumberOf(tracks, c) ?? '?'}`
          return (
            <li key={c.id} className={styles.item} data-testid={`clone-item-${c.id}`}>
              {isTrailClone(c) && s ? <span className={styles.tint} style={{ '--swatch': s.tint }} aria-hidden="true" /> : null}
              <span className={styles.name}>{c.name}</span>
              <span className={styles.kind}>{cloneKindLabel(c)}</span>
              <span className={styles.detail}>{detail}</span>
            </li>
          )
        })}
      </ul>
    </TrackSection>
  )
}
