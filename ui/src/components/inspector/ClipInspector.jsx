import { useEffect, useMemo, useState } from 'react'
import { Button, NumberBox, SectionHeader, SegmentedControl, Select, Toggle, THIN_SPACE, MINUS } from '../../ui-kit'
import { getGlobalStretchMethodLabel } from '../../constants/globalStretchMethods.js'
import { VIBRATO_SHAPES, VIBRATO_SYNC_DIVISIONS } from '../timeline/clipVibrato.js'
import {
  SCRATCH_BABY_DEFAULT_COUNT,
  SCRATCH_BABY_DEFAULT_LENGTH_BEATS,
  SCRATCH_BABY_LENGTHS,
  SCRATCH_DEFAULTS,
  SCRATCH_EDGE_MODES,
  SCRATCH_PRESETS,
  clampScratchCount,
  inferBabyScratchSettings,
  scratchCurveSummary,
  scratchPresetKeyForScratch,
} from '../timeline/clipScratch.js'
import { openClipFxEditor } from '../timeline/clipFxEditorOpeners.js'
import { getSyllableDisplayNumber } from '../SyllableSplitter/syllableModel.js'
import { VIBRATO_DEFAULTS, getClipModulationStatus } from './clipModulationStatus.js'
import ClipFxPreview from './ClipFxPreview.jsx'
import styles from './Inspector.module.css'

// Stretch methods in the order the clip menu always listed them.
const STRETCH_METHODS = [1, 2, 3, 5, 4]

const signed2 = (v) => (v < 0 ? `${MINUS}${Math.abs(v).toFixed(2)}` : Number(v).toFixed(2))
const parseNum = (text) => {
  const n = Number(String(text).replace(MINUS, '-').replace(/[^\d.+-]/g, ''))
  return Number.isFinite(n) ? n : null
}

// Source thumbnails for the video-companion preview, keyed by source id.
const thumbCache = new Map()

function Row({ label, children }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <div className={styles.rowControl}>{children}</div>
    </div>
  )
}

/**
 * Properties of one timeline clip. These used to live inside the clip's
 * right-click menu (stretch method, formant, vibrato, scratch, video companion
 * FX); the menu keeps the verbs. Every setter is the arrangement's own handler,
 * the same RPC as before, so each edit is one engine undo entry. Value fields
 * preview locally while dragged and commit once on release.
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

  // Live preview of video-companion values while a field is dragged. Cleared
  // when the committed values come back (not on release: avoids a flicker).
  const [videoDraft, setVideoDraft] = useState({})
  useEffect(() => { setVideoDraft({}) }, [clipId, vfx.swirlAmount, vfx.waveAmount, vfx.waveFrequency, vfx.smearAmount])

  const [thumb, setThumb] = useState(() => (source ? thumbCache.get(source.id) ?? null : null))
  useEffect(() => {
    if (!source) { setThumb(null); return }
    const cached = thumbCache.get(source.id)
    if (cached) { setThumb(cached); return }
    setThumb(null)
    if (!hasVideo || !(swirlOn || waveOn) || !source.filePath) return
    let cancelled = false
    ;(async () => {
      try {
        const url = await window.xleth?.project?.getSourceThumbnail(source.filePath, source.duration)
        if (url) thumbCache.set(source.id, url)
        if (!cancelled && url) setThumb(url)
      } catch (e) {
        console.warn('[Arrange] clip thumbnail fetch failed', e)
      }
    })()
    return () => { cancelled = true }
  }, [source, hasVideo, swirlOn, waveOn])

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

  const scrPresetKey = scratchPresetKeyForScratch(s)
  const baby = inferBabyScratchSettings(s) ?? {
    count: SCRATCH_BABY_DEFAULT_COUNT,
    lengthBeats: SCRATCH_BABY_DEFAULT_LENGTH_BEATS,
  }
  const updateBaby = (patch) => setScratch({}, {
    presetKey: 'babyScratch',
    scratchCount: patch.count ?? baby.count,
    lengthBeats: patch.lengthBeats ?? baby.lengthBeats,
  })

  const reversed = !!clip.reversed
  const formant = !!clip.formantPreserve
  const previewReason = (reversed || formant) ? 'Preview bypassed for this clip.'
    : !hasVideo ? 'Preview unavailable for this clip.'
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

      <section className={styles.section} aria-label="Playback">
        <SectionHeader>Playback</SectionHeader>
        <Row label="Reverse">
          <Toggle size="sm" on={reversed} onChange={() => actions.reverse(clipId)} hint="Play this clip backwards">
            Reverse
          </Toggle>
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
          <Toggle size="sm" on={formant} onChange={(next) => actions.setFormantPreserve(clipId, next)} hint="Keep formants when the clip is pitched">
            Preserve
          </Toggle>
        </Row>
      </section>

      <section className={styles.section} aria-label="Modulation">
        <SectionHeader>Modulation</SectionHeader>
        <p className={styles.status} data-kind={status.kind}>{status.label}</p>

        <Row label="Vibrato">
          <Toggle
            size="sm"
            on={vibEnabled}
            onChange={(next) => {
              if (next && !v.enabled && (v.depthCents ?? 0) === 0) setVibrato({ ...VIBRATO_DEFAULTS, enabled: true })
              else setVibrato({ enabled: next })
            }}
          >
            {vibEnabled ? 'On' : 'Off'}
          </Toggle>
        </Row>
        {vibEnabled && (
          <div className={styles.group}>
            <Row label="Depth">
              <NumberBox
                label="Vibrato depth" hideLabel
                value={Math.round(v.depthCents ?? 0)} min={0} max={1200} step={1} defaultValue={VIBRATO_DEFAULTS.depthCents}
                format={(x) => `${Math.round(x)}${THIN_SPACE}¢`} parse={parseNum}
                onCommit={(x) => setVibrato({ depthCents: Math.round(x) })}
              />
            </Row>
            <Row label="Rate">
              <SegmentedControl
                size="sm" label="Vibrato rate mode"
                value={v.rateMode ?? 'freeHz'}
                options={[{ value: 'freeHz', label: 'Free' }, { value: 'tempoSync', label: 'Sync' }]}
                onChange={(mode) => setVibrato({ rateMode: mode })}
              />
            </Row>
            {(v.rateMode ?? 'freeHz') === 'freeHz' ? (
              <Row label="Hz">
                <NumberBox
                  label="Vibrato rate" hideLabel
                  value={Number(v.rateHz ?? 5)} min={0.01} max={20} step={0.01} defaultValue={VIBRATO_DEFAULTS.rateHz}
                  format={(x) => `${Number(x).toFixed(2)}${THIN_SPACE}Hz`} parse={parseNum}
                  onCommit={(x) => setVibrato({ rateHz: Number(x.toFixed(2)) })}
                />
              </Row>
            ) : (
              <Row label="Sync">
                <Select
                  size="sm" ariaLabel="Vibrato sync division"
                  value={v.syncDivision ?? 'eighth'}
                  options={VIBRATO_SYNC_DIVISIONS.map(([val, lbl]) => ({ value: val, label: lbl }))}
                  onChange={(val) => setVibrato({ syncDivision: val })}
                />
              </Row>
            )}
            <Row label="Shape">
              <Select
                size="sm" ariaLabel="Vibrato shape"
                value={v.shape ?? 'sine'}
                options={VIBRATO_SHAPES.map(([val, lbl]) => ({ value: val, label: lbl }))}
                onChange={(val) => setVibrato({ shape: val })}
              />
            </Row>
            <Row label="">
              <Button size="sm" onClick={() => openClipFxEditor('vibrato', clipId)}>Open graph editor</Button>
            </Row>
          </div>
        )}

        <Row label="Scratch">
          <Toggle size="sm" on={scrEnabled} onChange={(next) => setScratch({ enabled: next })}>
            {scrEnabled ? 'On' : 'Off'}
          </Toggle>
        </Row>
        {scrEnabled && (
          <div className={styles.group}>
            <Row label="Preset">
              <Select
                size="sm" ariaLabel="Scratch preset"
                value={scrPresetKey}
                options={[
                  { value: 'custom', label: 'Custom', disabled: true },
                  ...SCRATCH_PRESETS.map((p) => ({ value: p.key, label: p.label })),
                ]}
                onChange={(val) => setScratch({}, { presetKey: val })}
              />
            </Row>
            <Row label="Smooth">
              <NumberBox
                label="Scratch smoothing" hideLabel
                value={Number(s.smoothingMs ?? SCRATCH_DEFAULTS.smoothingMs)} min={0} max={50} step={0.1}
                defaultValue={SCRATCH_DEFAULTS.smoothingMs} unit="ms"
                onCommit={(x) => setScratch({ smoothingMs: Number(x.toFixed(1)) })}
              />
            </Row>
            <Row label="Edge">
              <Select
                size="sm" ariaLabel="Scratch edge mode"
                value={s.edgeMode ?? SCRATCH_DEFAULTS.edgeMode}
                options={SCRATCH_EDGE_MODES.map(([val, lbl]) => ({ value: val, label: lbl }))}
                onChange={(val) => setScratch({ edgeMode: val })}
              />
            </Row>
            {scrPresetKey === 'babyScratch' && (
              <>
                <Row label="Count">
                  <NumberBox
                    label="Scratch count" hideLabel
                    value={baby.count} min={1} max={8} step={1} defaultValue={SCRATCH_BABY_DEFAULT_COUNT}
                    quantize={(x) => clampScratchCount(Math.round(x))}
                    format={(x) => String(Math.round(x))} parse={parseNum}
                    onCommit={(x) => updateBaby({ count: clampScratchCount(Math.round(x)) })}
                  />
                </Row>
                <Row label="Length">
                  <Select
                    size="sm" ariaLabel="Scratch length"
                    value={baby.lengthBeats}
                    options={SCRATCH_BABY_LENGTHS.map(([length, label]) => ({ value: length, label }))}
                    onChange={(val) => updateBaby({ lengthBeats: val })}
                  />
                </Row>
              </>
            )}
            <p className={styles.hint}>{scratchCurveSummary(s)}</p>
            <Row label="">
              <Button size="sm" onClick={() => openClipFxEditor('scratch', clipId)}>Open graph editor</Button>
            </Row>
          </div>
        )}
      </section>

      <section className={styles.section} aria-label="Video companion FX">
        <SectionHeader>Video companion FX</SectionHeader>
        <Row label="Swirl">
          <Toggle size="sm" on={swirlOn} onChange={(next) => setVideo({ vibratoSwirlEnabled: next })} hint="Swirl the picture with the vibrato">
            {swirlOn ? 'On' : 'Off'}
          </Toggle>
        </Row>
        {swirlOn && !vibEnabled && <p className={styles.hint}>Activates when vibrato is on.</p>}
        {swirlOn && (
          <div className={styles.group}>
            <Row label="Amount">
              <NumberBox
                label="Swirl amount" hideLabel bipolar
                value={Number(vfx.swirlAmount ?? 0.25)} min={-1} max={1} step={0.01} defaultValue={0.25}
                format={signed2} parse={parseNum}
                onChange={(x) => setVideoDraft((d) => ({ ...d, swirlAmount: x }))}
                onCommit={(x) => setVideo({ swirlAmount: Number(x.toFixed(2)) })}
              />
            </Row>
          </div>
        )}
        <Row label="Wave">
          <Toggle size="sm" on={waveOn} onChange={(next) => setVideo({ scratchWaveEnabled: next })} hint="Ripple the picture with the scratch">
            {waveOn ? 'On' : 'Off'}
          </Toggle>
        </Row>
        {waveOn && !scrEnabled && <p className={styles.hint}>Activates when scratch is on.</p>}
        {waveOn && (
          <div className={styles.group}>
            <Row label="Amount">
              <NumberBox
                label="Wave amount" hideLabel bipolar
                value={Number(vfx.waveAmount ?? 0.08)} min={-1} max={1} step={0.01} defaultValue={0.08}
                format={signed2} parse={parseNum}
                onChange={(x) => setVideoDraft((d) => ({ ...d, waveAmount: x }))}
                onCommit={(x) => setVideo({ waveAmount: Number(x.toFixed(2)) })}
              />
            </Row>
            <Row label="Freq">
              <NumberBox
                label="Wave frequency" hideLabel
                value={Number(vfx.waveFrequency ?? 8)} min={0.25} max={64} step={0.25} defaultValue={8}
                format={(x) => `${Number(x).toFixed(2)}${THIN_SPACE}×`} parse={parseNum}
                onChange={(x) => setVideoDraft((d) => ({ ...d, waveFrequency: x }))}
                onCommit={(x) => setVideo({ waveFrequency: Number(x.toFixed(2)) })}
              />
            </Row>
            <Row label="Smear">
              <NumberBox
                label="Smear amount" hideLabel bipolar
                value={Number(vfx.smearAmount ?? 0)} min={-1} max={1} step={0.01} defaultValue={0}
                format={signed2} parse={parseNum}
                onChange={(x) => setVideoDraft((d) => ({ ...d, smearAmount: x }))}
                onCommit={(x) => setVideo({ smearAmount: Number(x.toFixed(2)) })}
              />
            </Row>
            <Row label="Reverse">
              <Toggle
                size="sm" on={vfx.reverseWaveWithScratch ?? true}
                onChange={(next) => setVideo({ reverseWaveWithScratch: next })}
                hint="Reverse the wave when the scratch plays backwards"
              >
                With scratch
              </Toggle>
            </Row>
          </div>
        )}
        {(swirlOn || waveOn) && (
          <div className={styles.group}>
            <ClipFxPreview
              thumbDataUrl={thumb}
              vfx={{ ...vfx, ...videoDraft }}
              swirlOn={swirlOn}
              waveOn={waveOn}
              disabledReason={previewReason}
            />
          </div>
        )}
      </section>
    </div>
  )
}
