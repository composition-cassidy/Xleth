import { useEffect, useMemo, useState } from 'react'
import {
  Button, NumberBox, SectionHeader, SegmentedControl, Select,
} from '../../ui-kit'
import { cellGeometry, lensIsNeutral } from '../../lensRoam/lensRoamModel.js'
import { ZOOM_SCALE, degFmt, pctFmt, zoomFmt } from '../../lensRoam/lensFormats.js'
import useLensPanelMode from '../../lensRoam/lensPanelMode.js'
import { useLensValue, useTrackGeometry } from '../../lensRoam/useLensRoam.js'
import styles from '../inspector/Inspector.module.css'
import lens from './lensRoam.module.css'
import LensFrameCanvas from './LensFrameCanvas.jsx'
import { ClipLensAdvanced, SourceLensExtras } from './LensAdvanced.jsx'

// Lens: how the video is framed INSIDE its grid cell (docs/XLETH_LENS_ROAM_SPEC.md).
// One Lens panel for a Clip Track event or a Pattern Track source. Edits go
// through lensRoamApi: each commit is one engine UndoManager command, and
// nothing is sent while a gesture is in flight.
//
// Simple | Advanced: Advanced only REVEALS more (spec "UI"). Simple is the framing
// box, Fit, the number boxes and, for a Pattern Track source, the hit-curve
// presets with Strength and Short notes. Advanced adds the layer stack and the
// keyframe lanes (LensAdvanced.jsx). The choice is remembered per user.

const FIT_OPTIONS = [
  { value: 'Stretch', label: 'Stretch', hint: 'Stretch the source to the cell, ignoring its shape. What projects made before Lens do.' },
  { value: 'Cover', label: 'Cover', hint: 'Fill the cell and crop what overflows. Zoom 1.00 is this fit.' },
  { value: 'Contain', label: 'Contain', hint: 'Fit the whole source inside the cell and leave the rest empty.' },
]

const MODE_OPTIONS = [
  { value: 'simple', label: 'Simple' },
  { value: 'advanced', label: 'Advanced' },
]

const FLIP_OPTIONS = [
  { value: 'FollowTrack', label: 'Follow track', hint: "Use the track's own flip cycle, unchanged." },
  { value: 'None', label: 'None', hint: 'Never flip this picture, whatever the track cycle says.' },
  { value: 'Horizontal', label: 'Horizontal', hint: 'Always mirror left to right, after the framing.' },
  { value: 'Vertical', label: 'Vertical', hint: 'Always mirror top to bottom, after the framing.' },
]

function Row({ label, children }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <div className={styles.rowControl}>{children}</div>
    </div>
  )
}

/** The still the well shows: one JPEG of the source at `seconds`, best effort. */
function useSourceFrame(frameRef) {
  const sourceId = frameRef?.sourceId ?? null
  const seconds = frameRef?.seconds ?? 0
  const [url, setUrl] = useState(null)
  useEffect(() => {
    let alive = true
    setUrl(null)
    const video = window.xleth?.video
    if (sourceId == null || typeof video?.getFrameAtTime !== 'function') return undefined
    Promise.resolve(video.getFrameAtTime(sourceId, seconds, 640, 640))
      .then((u) => { if (alive) setUrl(u || null) })
      .catch(() => { if (alive) setUrl(null) })
    return () => { alive = false }
  }, [sourceId, Math.round(seconds * 30)])
  return url
}

/**
 * @param {object} props
 * @param {{kind:'clip', clipId:number} | {kind:'source', trackId:number, regionId:number}} props.target
 * @param {number} props.cellTrackId  the track whose cell this Lens frames (its aspect)
 * @param {string} props.context      the header line, e.g. "Chorus · applies to all notes"
 * @param {{sourceId:number, seconds:number, aspect:number|null}|null} props.frameRef
 * @param {{startTick:number, lengthTicks:number}} [props.clipTiming]  a clip target's place on the timeline (the lanes' time base)
 */
export default function LensPanel({ target, cellTrackId, context, frameRef, clipTiming }) {
  const { lens: value, ready, preview, commit, commitDraft, cancel, reset } = useLensValue(target)
  const { layout, track } = useTrackGeometry(cellTrackId)
  const geo = useMemo(() => cellGeometry(layout, track), [layout, track])
  const frameUrl = useSourceFrame(frameRef)
  const panelMode = useLensPanelMode((st) => st.mode)
  const setPanelMode = useLensPanelMode((st) => st.setMode)
  const advanced = panelMode === 'advanced'

  if (!ready) {
    return (
      <section className={styles.section} aria-label="Lens">
        <SectionHeader>Lens</SectionHeader>
        <p className={lens.context}>{context}</p>
        <p className={lens.note}>Loading lens…</p>
      </section>
    )
  }

  const cellAspect = geo?.aspect ?? (layout ? layout.canvasWidth / layout.canvasHeight : 16 / 9)
  const srcAspect = frameRef?.aspect ?? cellAspect

  const set = (patch) => { commit(patch) }

  const neutral = lensIsNeutral(value)

  return (
    <section className={styles.section} aria-label="Lens" data-testid="xleth-lens-panel">
      <SectionHeader>Lens</SectionHeader>
      <div className={lens.modeRow}>
        <p className={lens.context} title={context} data-testid="xleth-lens-context">{context}</p>
        <SegmentedControl
          size="sm" label="Lens panel mode" options={MODE_OPTIONS} value={panelMode}
          onChange={setPanelMode}
          hint="Simple is the framing and the presets. Advanced adds the keyframe lanes. Nothing in Simple moves."
        />
      </div>

      <LensFrameCanvas
        lens={value}
        cellAspect={cellAspect}
        srcAspect={srcAspect}
        frameUrl={frameUrl}
        onPreview={preview}
        onCommit={commitDraft}
        onCancel={cancel}
      />

      <Row label="Fit">
        <SegmentedControl
          size="sm"
          label="Lens fit"
          options={FIT_OPTIONS}
          value={value.fit}
          onChange={(fit) => set({ fit })}
          hint="How the source is fitted to the cell before the framing. Zoom 1.00 is this fit."
        />
      </Row>
      <Row label="Zoom">
        <NumberBox
          label="Zoom" hideLabel width={88} scale={ZOOM_SCALE} defaultValue={1}
          value={value.zoom} format={zoomFmt.format} parse={zoomFmt.parse}
          onChange={(zoom) => preview({ zoom })}
          onCommit={(zoom) => set({ zoom })}
          onCancel={cancel}
          hint="Zoom into the frame. 1.00 is the chosen fit; above 1 crops in, below 1 pulls out."
        />
      </Row>
      <Row label="Center X">
        <NumberBox
          label="Center X" hideLabel width={88} min={0} max={1} defaultValue={0.5}
          value={value.centerX} format={pctFmt.format} parse={pctFmt.parse}
          onChange={(centerX) => preview({ centerX })}
          onCommit={(centerX) => set({ centerX })}
          onCancel={cancel}
          hint="Which point of the source sits at the middle of the cell, across the source. 50 % is centred."
        />
      </Row>
      <Row label="Center Y">
        <NumberBox
          label="Center Y" hideLabel width={88} min={0} max={1} defaultValue={0.5}
          value={value.centerY} format={pctFmt.format} parse={pctFmt.parse}
          onChange={(centerY) => preview({ centerY })}
          onCommit={(centerY) => set({ centerY })}
          onCancel={cancel}
          hint="Which point of the source sits at the middle of the cell, down the source. 50 % is centred."
        />
      </Row>
      <Row label="Rotate">
        <NumberBox
          label="Rotate" hideLabel width={88} min={-360} max={360} defaultValue={0} pxPerRange={1440}
          value={value.rotationDeg} format={degFmt.format} parse={degFmt.parse}
          onChange={(rotationDeg) => preview({ rotationDeg })}
          onCommit={(rotationDeg) => set({ rotationDeg })}
          onCancel={cancel}
          hint="Turn the picture inside the cell. Positive is clockwise."
        />
      </Row>
      <Row label="Flip">
        <Select
          size="sm" ariaLabel="Lens flip" value={value.flip} options={FLIP_OPTIONS}
          onChange={(flip) => set({ flip })}
          hint="Mirror the framed picture. Follow track keeps the track's own flip cycle."
        />
      </Row>
      <div className={lens.actions}>
        <Button
          size="sm" onClick={() => reset()} disabled={neutral}
          hint="Put zoom, centre, rotation and flip back to neutral. The fit stays."
        >
          Reset
        </Button>
      </div>
      {target.kind === 'source' && <SourceLensExtras target={target} lens={value} advanced={advanced} />}
      {target.kind === 'clip' && advanced && (
        <ClipLensAdvanced clipId={target.clipId} trackId={cellTrackId} lens={value} clipTiming={clipTiming} />
      )}
    </section>
  )
}
