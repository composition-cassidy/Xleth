import { useMemo } from 'react'
import { Button, SectionHeader, Select } from '../../ui-kit'
import { getGlobalStretchMethodLabel } from '../../constants/globalStretchMethods.js'
import { scratchCurveSummary } from '../timeline/clipScratch.js'
import { openClipFxEditor } from '../timeline/clipFxEditorOpeners.js'
import { getSyllableDisplayNumber } from '../SyllableSplitter/syllableModel.js'
import { VIBRATO_DEFAULTS, getClipModulationStatus } from './clipModulationStatus.js'
import RowToggle from './RowToggle.jsx'
import LensPanel from '../lensRoam/LensPanel.jsx'
import { sourceTimeForClip } from '../grid/zprTimeline/zprSourceFrame.js'
import { getTransportState } from '../../transportStore.js'
import styles from './Inspector.module.css'

// Stretch methods in the order the clip menu always listed them.
const STRETCH_METHODS = [1, 2, 3, 5, 4]

function Row({ label, children }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <div className={styles.rowControl}>{children}</div>
    </div>
  )
}

/**
 * Properties of one timeline clip: Reverse, Stretch, Formant; Vibrato and
 * Scratch, each a switch plus Edit (their shape, depth, rate, presets and the
 * rest live in their editor windows, which already had every one of them); and
 * the video companion switches, Swirl and Wave, whose amounts and preview now
 * live in the vibrato and scratch editors. Every setter is the arrangement's
 * own handler, the same RPC as before, so each edit is one engine undo entry.
 */
export default function ClipInspector({ context, actions }) {
  const { clip, region, source, track, trackColor } = context
  const clipId = clip.id
  const mod = clip.modulation ?? {}
  const v = mod.vibrato ?? {}
  const s = mod.scratch ?? {}
  const vfx = mod.video ?? {}
  const vibEnabled = v.enabled ?? false
  const scrEnabled = s.enabled ?? false
  const swirlOn = vfx.vibratoSwirlEnabled ?? false
  const waveOn = vfx.scratchWaveEnabled ?? false
  const hasVideo = !!source && source.hasVideo !== false
  const status = getClipModulationStatus(clip)

  const stretchOptions = useMemo(() => [
    { value: 0, label: `Global (${getGlobalStretchMethodLabel(actions.globalStretchMethod)})` },
    ...STRETCH_METHODS.map((m) => ({ value: m, label: getGlobalStretchMethodLabel(m) })),
  ], [actions.globalStretchMethod])

  let clipName = region?.name || 'Clip'
  if (clip.syllableIndex != null && clip.syllableIndex >= 0) {
    const syl = region?.syllables?.[clip.syllableIndex]
    const n = getSyllableDisplayNumber(region?.syllables, clip.syllableIndex)
    clipName = syl?.text ? `${n} ${syl.text}` : `Syllable ${n}`
  }

  const setVibrato = (patch) => actions.setVibrato(clipId, patch)
  const setScratch = (patch, options) => actions.setScratch(clipId, patch, options)
  const setVideo = (patch) => actions.setVideoFx(clipId, patch)


  const reversed = !!clip.reversed
  const formant = !!clip.formantPreserve

  // The still the Lens well frames: the source at this clip's first frame.
  const lensFrame = hasVideo && region
    ? {
        sourceId: region.sourceId,
        seconds: sourceTimeForClip(clip, region, clip.positionTicks ?? 0, getTransportState()?.bpm ?? 120),
        aspect: source?.width > 0 && source?.height > 0 ? source.width / source.height : null,
      }
    : null

  return (
    <div className={styles.root} data-testid="xleth-inspector-clip">
      <header className={styles.head}>
        <span className={styles.swatch} style={{ background: trackColor ?? undefined }} aria-hidden="true" />
        <div className={styles.headText}>
          <h2 className={styles.title} title={clipName}>{clipName}</h2>
          <span className={styles.meta}>
            {hasVideo ? 'Video clip' : 'Audio clip'}{track ? ` on ${track.name}` : ''}
          </span>
        </div>
      </header>

      <div className={styles.body}>
        <section className={styles.section} aria-label="Playback">
          <SectionHeader>Playback</SectionHeader>
          <Row label="Reverse">
            <RowToggle label="Reverse" on={reversed} onChange={() => actions.reverse(clipId)} hint="Play this clip backwards" />
          </Row>
          <Row label="Stretch">
            <Select
              size="sm"
              ariaLabel="Stretch method"
              value={clip.stretchMethod ?? 0}
              options={stretchOptions}
              onChange={(m) => actions.setStretchMethod(clipId, m)}
            />
          </Row>
          <Row label="Formant">
            <RowToggle
              label="Preserve formants"
              on={formant}
              onChange={(next) => actions.setFormantPreserve(clipId, next)}
              hint="Keep formants when the clip is pitched"
            />
          </Row>
        </section>

        {hasVideo && (
          <LensPanel
            target={{ kind: 'clip', clipId }}
            cellTrackId={clip.trackId}
            context={`${clipName} · this event only`}
            frameRef={lensFrame}
          />
        )}

        <section className={styles.section} aria-label="Modulation">
          <SectionHeader>Modulation</SectionHeader>
          <p className={styles.status} data-kind={status.kind}>{status.label}</p>
          <Row label="Vibrato">
            <RowToggle
              label="Vibrato"
              on={vibEnabled}
              onChange={(next) => {
                if (next && !v.enabled && (v.depthCents ?? 0) === 0) setVibrato({ ...VIBRATO_DEFAULTS, enabled: true })
                else setVibrato({ enabled: next })
              }}
              hint="Pitch vibrato on this clip"
            />
            <Button size="sm" onClick={() => openClipFxEditor('vibrato', clipId)} hint="Open the vibrato editor: shape, depth, rate, phase and the Swirl picture">
              Edit
            </Button>
          </Row>
          <Row label="Scratch">
            <RowToggle label="Scratch" on={scrEnabled} onChange={(next) => setScratch({ enabled: next })} hint="Scratch playback on this clip" />
            <Button size="sm" onClick={() => openClipFxEditor('scratch', clipId)} hint="Open the scratch editor: curve, presets, smoothing, edges and the Wave picture">
              Edit
            </Button>
          </Row>
          {scrEnabled ? <p className={styles.hint}>{scratchCurveSummary(s)}</p> : null}
        </section>

        <section className={styles.section} aria-label="Video companion FX">
          <SectionHeader>Video companion FX</SectionHeader>
          <Row label="Swirl">
            <RowToggle label="Swirl" on={swirlOn} onChange={(next) => setVideo({ vibratoSwirlEnabled: next })} hint="Swirl the picture with the vibrato. Amount: in the vibrato editor." />
          </Row>
          {swirlOn && !vibEnabled && <p className={styles.hint}>Activates when vibrato is on.</p>}
          <Row label="Wave">
            <RowToggle label="Wave" on={waveOn} onChange={(next) => setVideo({ scratchWaveEnabled: next })} hint="Ripple the picture with the scratch. Amounts: in the scratch editor." />
          </Row>
          {waveOn && !scrEnabled && <p className={styles.hint}>Activates when scratch is on.</p>}
        </section>
      </div>
    </div>
  )
}
