import { useEffect, useMemo, useRef, useState } from 'react'
import { timelineEvents } from '../../timelineEvents.js'
import useTrackIdentityColors from '../inspector/useTrackIdentityColors.js'
import { buildGhostNotes } from './pianoRollNotes.js'

// What the Piano Roll needs to know about where its pattern sits, all through
// existing read-only calls (getTracks, getPatternBlocks, getPattern):
//   noteColor  the identity colour of the track the pattern's first block is on
//              (null when the pattern is not placed: the notes fall back to the
//              value colour);
//   ghosts     notes of other patterns overlapping that block (pianoRollNotes).
// Nothing here runs during a drag: refetches follow the timeline's own change
// events, which fire after a commit.

function overlappingPatternIds(blocks, patternId) {
  const mine = blocks.filter((b) => b.patternId === patternId)
  if (!mine.length) return []
  const anchor = mine.reduce((a, b) => (b.positionTicks < a.positionTicks ? b : a))
  const start = anchor.positionTicks
  const end = anchor.positionTicks + anchor.durationTicks
  const ids = new Set()
  for (const b of blocks) {
    if (b.patternId === patternId) continue
    if (b.positionTicks < end && b.positionTicks + b.durationTicks > start) ids.add(b.patternId)
  }
  return Array.from(ids).sort((a, b) => a - b)
}

export default function usePatternContext(patternId, pattern, { ghostsEnabled = true } = {}) {
  const [tracks, setTracks] = useState([])
  const [blocks, setBlocks] = useState([])
  const [others, setOthers] = useState({})
  const valid = Number.isInteger(patternId) && patternId >= 0

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const t = await window.xleth?.timeline?.getTracks?.()
        if (alive && Array.isArray(t)) setTracks(t)
      } catch (e) {
        console.warn('[PianoRoll] getTracks failed:', e?.message)
      }
    }
    load()
    timelineEvents.addEventListener('timeline-tracks-changed', load)
    return () => { alive = false; timelineEvents.removeEventListener('timeline-tracks-changed', load) }
  }, [])

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const b = await window.xleth?.timeline?.getPatternBlocks?.()
        if (alive && Array.isArray(b)) setBlocks(b)
      } catch (e) {
        console.warn('[PianoRoll] getPatternBlocks failed:', e?.message)
      }
    }
    load()
    timelineEvents.addEventListener('timeline-pattern-blocks-changed', load)
    return () => { alive = false; timelineEvents.removeEventListener('timeline-pattern-blocks-changed', load) }
  }, [])

  const otherIds = useMemo(
    () => (valid && ghostsEnabled ? overlappingPatternIds(blocks, patternId) : []),
    [blocks, patternId, valid, ghostsEnabled],
  )
  const otherKey = otherIds.join(',')

  const timerRef = useRef(null)
  useEffect(() => {
    const ids = otherKey ? otherKey.split(',').map(Number) : []
    if (!ids.length) { setOthers({}); return undefined }
    let alive = true
    const load = async () => {
      const next = {}
      for (const id of ids) {
        try {
          const p = await window.xleth?.timeline?.getPattern?.(id)
          if (p) next[id] = p
        } catch (e) {
          console.warn('[PianoRoll] getPattern (ghosts) failed:', e?.message)
        }
      }
      if (alive) setOthers(next)
    }
    load()
    // An edit anywhere refires patterns-changed; coalesce bursts.
    const onChanged = () => {
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(load, 200)
    }
    timelineEvents.addEventListener('timeline-patterns-changed', onChanged)
    return () => {
      alive = false
      clearTimeout(timerRef.current)
      timelineEvents.removeEventListener('timeline-patterns-changed', onChanged)
    }
  }, [otherKey])

  const identity = useTrackIdentityColors(tracks)
  const anchorTrackId = useMemo(() => {
    if (!valid) return null
    const mine = blocks.filter((b) => b.patternId === patternId)
    if (!mine.length) return null
    return mine.reduce((a, b) => (b.positionTicks < a.positionTicks ? b : a)).trackId
  }, [blocks, patternId, valid])

  const ghosts = useMemo(() => {
    if (!valid || !ghostsEnabled || !pattern) return null
    const list = buildGhostNotes({ patternId, pattern, blocks, patternsById: others })
    return list.length ? list : null
  }, [valid, ghostsEnabled, pattern, patternId, blocks, others])

  return {
    noteColor: anchorTrackId != null ? identity[anchorTrackId] || null : null,
    ghosts,
    placed: anchorTrackId != null,
  }
}
