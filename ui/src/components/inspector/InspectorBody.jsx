import useInspectorStore from '../../stores/useInspectorStore.js'
import TrackVideoProperties from '../timeline/TrackVideoProperties.jsx'
import ClipInspector from './ClipInspector.jsx'
import styles from './Inspector.module.css'

function Message({ children, testId = 'xleth-inspector-empty' }) {
  return (
    <div className={styles.empty} data-testid={testId}>
      <p className={styles.emptyText}>{children}</p>
    </div>
  )
}

/**
 * Selection-driven: a track shows its identity and video properties, a clip
 * its clip properties. Anything else says plainly what it can and cannot show.
 */
export default function InspectorBody() {
  const selection = useInspectorStore((s) => s.selection)
  const clip = useInspectorStore((s) => s.clip)
  const clipActions = useInspectorStore((s) => s.clipActions)

  if (!selection) return <Message>Select a clip or track to edit its properties</Message>

  if (selection.kind === 'track') return <TrackVideoProperties key={selection.trackId} trackId={selection.trackId} />

  if (selection.kind === 'clip') {
    if (!clip || clip.clip?.id !== selection.clipId || !clipActions) return <Message>Loading clip…</Message>
    return <ClipInspector key={selection.clipId} context={clip} actions={clipActions} />
  }

  if (selection.kind === 'blocks') {
    return (
      <Message testId="xleth-inspector-blocks">
        {selection.count === 1 ? 'Pattern block selected.' : `${selection.count} pattern blocks selected.`}{' '}
        Pattern blocks have no properties here; select the track to edit its video settings.
      </Message>
    )
  }

  if (selection.kind === 'multi') {
    return (
      <Message testId="xleth-inspector-multi">
        {selection.count} {selection.noun} selected. The Inspector edits one {selection.noun === 'tracks' ? 'track' : 'clip'} at a time.
      </Message>
    )
  }

  return <Message>Select a clip or track to edit its properties</Message>
}
