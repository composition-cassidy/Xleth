import { useEffect, useState } from 'react'
import useInspectorStore from '../../stores/useInspectorStore.js'
import useNoteSelectionStore from '../../stores/useNoteSelectionStore.js'
import useLensPanelMode from '../../lensRoam/lensPanelMode.js'
import { useNoteSource } from '../../lensRoam/useLensKeys.js'
import TrackVideoProperties from '../timeline/TrackVideoProperties.jsx'
import ClipInspector from './ClipInspector.jsx'
import PatternSourceInspector from './PatternSourceInspector.jsx'
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

  // Advanced Lens editing follows the NOTES the user picked in the Piano Roll or
  // the Reel lane: the Lens panel of that note's source replaces the arrangement
  // selection while the notes were the last thing touched. Simple mode never does
  // this (Advanced only reveals more), and the arrangement selection is untouched.
  const advanced = useLensPanelMode((s) => s.mode) === 'advanced'
  const noteSelection = useNoteSelectionStore((s) => s.byPattern)
  const [lastTouched, setLastTouched] = useState('arrangement')
  // Order matters: when one click changes both (a Reel ghost selects its track AND
  // its note), the effect declared last wins, and that is the note.
  useEffect(() => { setLastTouched('arrangement') }, [selection])
  useEffect(() => { if (Object.keys(noteSelection).length) setLastTouched('notes') }, [noteSelection])
  const noteSource = useNoteSource(advanced && lastTouched === 'notes')

  if (advanced && lastTouched === 'notes' && noteSource) {
    return (
      <PatternSourceInspector
        key={`${noteSource.trackId}:${noteSource.regionId}`}
        selection={{ kind: 'blocks', count: 1, ...noteSource }}
      />
    )
  }

  if (!selection) return <Message>Select a clip or track to edit its properties</Message>

  if (selection.kind === 'track') return <TrackVideoProperties key={selection.trackId} trackId={selection.trackId} />

  if (selection.kind === 'clip') {
    if (!clip || clip.clip?.id !== selection.clipId || !clipActions) return <Message>Loading clip…</Message>
    return <ClipInspector key={selection.clipId} context={clip} actions={clipActions} />
  }

  if (selection.kind === 'blocks' && selection.count === 1 && selection.trackId != null && selection.regionId != null) {
    return <PatternSourceInspector key={`${selection.trackId}:${selection.regionId}`} selection={selection} />
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
