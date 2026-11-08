import React, { useEffect, useState } from 'react'
import { NumberBox, SectionHeader, THIN_SPACE, MINUS } from '../../ui-kit'
import RowToggle from '../inspector/RowToggle.jsx'
import ClipFxPreview from '../inspector/ClipFxPreview.jsx'
import styles from './ClipPictureSection.module.css'

// The video companion of a clip FX: Swirl rides the vibrato, Wave the scratch.
// Their on / off switches stay in the Inspector (turning one on seeds it from
// Settings > Clip FX); their amounts and the live preview live here, in the
// editor of the FX they follow. Same values, ranges and defaults as the
// Inspector had, one setClipModulation per gesture (the editor store's
// commitVideo, the same merge-and-write path as its other controls).

const signed2 = (v) => (v < 0 ? `${MINUS}${Math.abs(v).toFixed(2)}` : Number(v).toFixed(2))
const parseNum = (text) => {
  const n = Number(String(text).replace(MINUS, '-').replace(/[^\d.+-]/g, ''))
  return Number.isFinite(n) ? n : null
}

// Source thumbnails for the preview, keyed by source id (session cache).
const thumbCache = new Map()

function useClipThumbnail(clip, wanted) {
  const [state, setState] = useState({ thumb: null, hasVideo: true })
  useEffect(() => {
    if (!clip || !wanted) return undefined
    let cancelled = false
    ;(async () => {
      try {
        const regions = await window.xleth?.timeline?.getRegions?.()
        const region = Array.isArray(regions) ? regions.find((r) => r.id === clip.regionId) : regions?.[clip.regionId]
        const sources = await window.xleth?.timeline?.getSources?.()
        const source = Array.isArray(sources) ? sources.find((s) => s.id === region?.sourceId) : sources?.[region?.sourceId]
        if (!source) { if (!cancelled) setState({ thumb: null, hasVideo: false }); return }
        const hasVideo = source.hasVideo !== false
        let thumb = thumbCache.get(source.id) ?? null
        if (!thumb && hasVideo && source.filePath) {
          thumb = await window.xleth?.project?.getSourceThumbnail?.(source.filePath, source.duration) ?? null
          if (thumb) thumbCache.set(source.id, thumb)
        }
        if (!cancelled) setState({ thumb, hasVideo })
      } catch (e) {
        console.warn('[ClipFx] clip thumbnail fetch failed', e)
      }
    })()
    return () => { cancelled = true }
  }, [clip?.id, clip?.regionId, wanted])
  return state
}

function Row({ label, children }) {
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <div className={styles.control}>{children}</div>
    </div>
  )
}

/**
 * Props: kind 'swirl' | 'wave', clip (with modulation.video), commitVideo(patch).
 */
export default function ClipPictureSection({ kind, clip, commitVideo }) {
  const vfx = clip?.modulation?.video ?? {}
  const on = kind === 'swirl' ? !!vfx.vibratoSwirlEnabled : !!vfx.scratchWaveEnabled
  const [draft, setDraft] = useState({})
  useEffect(() => { setDraft({}) }, [clip?.id, vfx.swirlAmount, vfx.waveAmount, vfx.waveFrequency, vfx.smearAmount])
  const { thumb, hasVideo } = useClipThumbnail(clip, on)

  const reason = (clip?.reversed || clip?.formantPreserve) ? 'Preview bypassed for this clip.'
    : !hasVideo ? 'Preview unavailable for this clip.'
    : null

  const name = kind === 'swirl' ? 'Swirl' : 'Wave'
  return (
    <section className={styles.section} aria-label={`${name}: picture`} data-testid={`clipfx-picture-${kind}`}>
      <SectionHeader>{`Picture: ${name}`}</SectionHeader>
      {!on ? (
        <p className={styles.note}>{`${name} is off. Turn it on in the Inspector's Video companion FX.`}</p>
      ) : (
        <div className={styles.body}>
          <div className={styles.fields}>
            {kind === 'swirl' ? (
              <Row label="Amount">
                <NumberBox
                  label="Swirl amount" hideLabel bipolar
                  value={Number(draft.swirlAmount ?? vfx.swirlAmount ?? 0.25)} min={-1} max={1} step={0.01} defaultValue={0.25}
                  format={signed2} parse={parseNum}
                  onChange={(x) => setDraft((d) => ({ ...d, swirlAmount: x }))}
                  onCommit={(x) => commitVideo({ swirlAmount: Number(x.toFixed(2)) })}
                />
              </Row>
            ) : (
              <>
                <Row label="Amount">
                  <NumberBox
                    label="Wave amount" hideLabel bipolar
                    value={Number(draft.waveAmount ?? vfx.waveAmount ?? 0.08)} min={-1} max={1} step={0.01} defaultValue={0.08}
                    format={signed2} parse={parseNum}
                    onChange={(x) => setDraft((d) => ({ ...d, waveAmount: x }))}
                    onCommit={(x) => commitVideo({ waveAmount: Number(x.toFixed(2)) })}
                  />
                </Row>
                <Row label="Frequency">
                  <NumberBox
                    label="Wave frequency" hideLabel
                    value={Number(draft.waveFrequency ?? vfx.waveFrequency ?? 8)} min={0.25} max={64} step={0.25} defaultValue={8}
                    format={(x) => `${Number(x).toFixed(2)}${THIN_SPACE}×`} parse={parseNum}
                    onChange={(x) => setDraft((d) => ({ ...d, waveFrequency: x }))}
                    onCommit={(x) => commitVideo({ waveFrequency: Number(x.toFixed(2)) })}
                  />
                </Row>
                <Row label="Smear">
                  <NumberBox
                    label="Smear amount" hideLabel bipolar
                    value={Number(draft.smearAmount ?? vfx.smearAmount ?? 0)} min={-1} max={1} step={0.01} defaultValue={0}
                    format={signed2} parse={parseNum}
                    onChange={(x) => setDraft((d) => ({ ...d, smearAmount: x }))}
                    onCommit={(x) => commitVideo({ smearAmount: Number(x.toFixed(2)) })}
                  />
                </Row>
                <Row label="Reverse">
                  <RowToggle
                    label="Reverse the wave with the scratch"
                    on={vfx.reverseWaveWithScratch ?? true}
                    onChange={(next) => commitVideo({ reverseWaveWithScratch: next })}
                    hint="Reverse the wave when the scratch plays backwards"
                  />
                </Row>
              </>
            )}
          </div>
          <ClipFxPreview
            thumbDataUrl={thumb}
            vfx={{ ...vfx, ...draft }}
            swirlOn={kind === 'swirl'}
            waveOn={kind === 'wave'}
            disabledReason={reason}
          />
        </div>
      )}
    </section>
  )
}
