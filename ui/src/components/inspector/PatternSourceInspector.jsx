import { useEffect, useState } from 'react'
import { timelineEvents } from '../../timelineEvents.js'
import LensPanel from '../lensRoam/LensPanel.jsx'
import useTrackIdentityColors from './useTrackIdentityColors.js'
import styles from './Inspector.module.css'

/**
 * One selected Pattern block, shown as what it plays: the track's SOURCE
 * {trackId, regionId}. Its Lens is the source's default framing, so it applies to
 * every note of every pattern on this track that plays this source. (The block
 * itself has no properties; the track's Roam lives on the track.)
 *
 * selection: { trackId, regionId, patternId, blockId } from the Inspector store.
 */
export default function PatternSourceInspector({ selection }) {
  const { trackId, regionId } = selection
  const [data, setData] = useState({ tracks: [], region: null, source: null })

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const tl = window.xleth?.timeline
        const [tracks, regions, sources] = await Promise.all([
          tl?.getTracks?.(), tl?.getRegions?.(), tl?.getSources?.(),
        ])
        if (!alive) return
        const region = Array.isArray(regions) ? regions.find((r) => r.id === regionId) ?? null : null
        const source = region && Array.isArray(sources) ? sources.find((s) => s.id === region.sourceId) ?? null : null
        setData({ tracks: Array.isArray(tracks) ? tracks : [], region, source })
      } catch (err) {
        console.error('[Arrange] pattern source inspector refresh failed:', err)
      }
    }
    load()
    const on = () => load()
    const events = ['timeline-tracks-changed', 'timeline-regions-changed', 'timeline-sources-changed']
    events.forEach((e) => timelineEvents.addEventListener(e, on))
    return () => {
      alive = false
      events.forEach((e) => timelineEvents.removeEventListener(e, on))
    }
  }, [regionId])

  const colors = useTrackIdentityColors(data.tracks)
  const track = data.tracks.find((t) => t.id === trackId) ?? null
  const { region, source } = data
  const hasVideo = !!source && source.hasVideo !== false
  const name = track?.name ?? 'Pattern track'

  return (
    <div className={styles.root} data-testid="xleth-inspector-pattern-source">
      <header className={styles.head}>
        <span className={styles.swatch} style={{ background: colors[trackId] ?? undefined }} aria-hidden="true" />
        <div className={styles.headText}>
          <h2 className={styles.title} title={name}>{name}</h2>
          <span className={styles.meta}>{region?.name ? `Pattern source · ${region.name}` : 'Pattern source'}</span>
        </div>
      </header>

      <div className={styles.body}>
        {hasVideo ? (
          <LensPanel
            target={{ kind: 'source', trackId, regionId }}
            cellTrackId={trackId}
            context={`${name} · applies to all notes`}
            frameRef={{
              sourceId: region.sourceId,
              seconds: region.startTime ?? 0,
              aspect: source.width > 0 && source.height > 0 ? source.width / source.height : null,
            }}
          />
        ) : (
          <section className={styles.section} aria-label="Lens">
            <p className={styles.status}>
              {region ? 'This source has no picture, so there is nothing to frame.' : 'Loading source…'}
            </p>
          </section>
        )}
      </div>
    </div>
  )
}
