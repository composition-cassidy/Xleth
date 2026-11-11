import { useState, useEffect, useRef, useCallback, memo } from 'react'
import { SkipBack, Play, Pause, Square, SkipForward, Lock, LockOpen, Crosshair } from 'lucide-react'
import { subscribe } from '../transportStore.js'
import { playheadClock } from '../services/PlayheadClock.js'
import useMixerStore from '../stores/mixerStore.js'
import useAutoScrollStore from '../stores/autoScrollStore.js'
import { isSamplePickerKeyTarget } from '../stores/samplePickerGate.js'
import { IconButton, NumberBox, THIN_SPACE, logScale } from '../ui-kit'
import styles from './TransportBar.module.css'

const BPM_SCALE = logScale(20, 999)
const BPM_DEFAULT = 140
const roundBpm = (v) => Math.round(v * 10) / 10
const formatBpm = (v) => `${Number.isInteger(roundBpm(v)) ? roundBpm(v) : roundBpm(v).toFixed(1)}${THIN_SPACE}BPM`
const parseBpm = (text) => {
  const n = parseFloat(String(text).replace(/bpm/i, ''))
  return Number.isFinite(n) ? n : null
}

export function formatTime(ms) {
  const totalMs = Math.max(0, ms)
  const minutes = Math.floor(totalMs / 60000)
  const seconds = Math.floor((totalMs % 60000) / 1000)
  const millis  = Math.floor(totalMs % 1000)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
}

/** BAR.BEAT, both 1-based, from a position in beats (4/4, as before). */
export function formatBarBeat(positionBeats) {
  const beats = Math.max(0, Number.isFinite(positionBeats) ? positionBeats : 0)
  const bar = Math.floor(beats / 4) + 1
  const beat = Math.floor(beats % 4) + 1
  return `${bar}.${beat}`
}

// Isolated position readouts: subscribe to 10fps updates without re-rendering
// the rest of the transport (play buttons, BPM editor, etc.).
const PositionDisplay = memo(function PositionDisplay() {
  const [pos, setPos] = useState({ ms: 0, beats: 0 })

  useEffect(() => {
    return playheadClock.onDisplayUpdate((posMs, bpm, positionBeats) => {
      const beats = Number.isFinite(positionBeats) ? positionBeats : posMs * bpm / 60000
      setPos({ ms: posMs, beats })
    })
  }, [])

  const time = formatTime(pos.ms)
  const barBeat = formatBarBeat(pos.beats)
  return (
    <>
      <output
        className={styles.readout}
        aria-label={`Time ${time}`}
        data-hint="Song position: minutes, seconds, milliseconds"
      >
        {time}
      </output>
      <output
        className={styles.readout}
        aria-label={`Bar ${barBeat.split('.')[0]}, beat ${barBeat.split('.')[1]}`}
        data-hint="Song position: bar and beat"
      >
        {barBeat}
      </output>
    </>
  )
})

/**
 * Transport: rewind, stop, play/pause, forward, timecode, BAR.BEAT, BPM with
 * tempo lock, auto-scroll. Rendered as the centred cluster of the top bar.
 * Owns the global transport keys (Space, Home, M), unchanged.
 */
export default function TransportBar() {
  const [isPlaying, setIsPlaying] = useState(false)
  const [bpm, setBpm] = useState(140)
  const autoScrollEnabled = useAutoScrollStore(s => s.enabled)
  const toggleAutoScroll = useAutoScrollStore(s => s.toggle)

  const [tempoLocked, setTempoLocked] = useState(true)
  const [spacebarMode, setSpacebarMode] = useState('play-pause')
  const playStartBeatsRef = useRef(0)

  // Load tempo-lock state from engine on mount
  useEffect(() => {
    window.xleth?.timeline?.getTempoLocked?.().then(v => setTempoLocked(v)).catch(() => {})
  }, [])

  // Load spacebar mode from settings and listen for live changes from SettingsPanel
  useEffect(() => {
    window.xleth?.settings?.get?.('spacebarMode')?.then(v => {
      setSpacebarMode(v === 'play-stop' ? 'play-stop' : 'play-pause')
    })

    const onModeChange = (e) => setSpacebarMode(e.detail.mode)
    window.addEventListener('xleth:spacebarMode-changed', onModeChange)
    return () => window.removeEventListener('xleth:spacebarMode-changed', onModeChange)
  }, [])

  // Transport store for control state (isPlaying, bpm — immediate response)
  useEffect(() => subscribe((s) => {
    setIsPlaying(prev => prev !== s.isPlaying ? s.isPlaying : prev)
    setBpm(prev => prev !== s.bpm ? s.bpm : prev)
  }), [])

  // Global keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      // Don't capture if focus is on an input (the tempo editor included)
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      // The Sample Picker sheet owns the spacebar (and other transport keys) while
      // focus is inside it. Out in the arrangement the transport keeps its keys.
      if (isSamplePickerKeyTarget(e)) return

      if (e.code === 'Space') {
        e.preventDefault()
        if (spacebarMode === 'play-stop') {
          if (isPlaying) {
            window.xleth?.stop()
            if (window.xleth && window.xleth.transport && window.xleth.transport.seek) {
              window.xleth.transport.seek(playStartBeatsRef.current)
            }
          } else {
            playStartBeatsRef.current = playheadClock.positionBeats
            window.xleth?.play()
          }
        } else {
          if (isPlaying) window.xleth?.pause()
          else window.xleth?.play()
        }
      } else if (e.code === 'Home') {
        e.preventDefault()
        window.xleth?.stop()
        console.log('[UI] Transport: rewind (Home)')
      } else if (e.code === 'KeyM') {
        e.preventDefault()
        useMixerStore.getState().toggleMixer()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isPlaying, spacebarMode])

  // Tempo: dragging and typing are the kit NumberBox's job; only the commit
  // (the undo boundary) reaches the engine, exactly as the old editor did.
  const commitBpm = useCallback((val) => {
    if (!(val >= 20 && val <= 999)) return
    console.log(`[UI] BPM → ${val}`)
    // Use the timeline-aware setBPM if available, else fallback
    if (window.xleth?.timeline?.setBPM) {
      window.xleth.timeline.setBPM(val)
    } else {
      // Legacy direct transport setter (Phase 0 compat)
      window.xleth?.play && fetch('') // no-op placeholder
    }
  }, [])

  const playLabel = isPlaying ? 'Pause' : 'Play'
  const tempoLockLabel = tempoLocked
    ? 'Tempo lock on: clips keep their speed when the BPM changes'
    : 'Tempo lock off: clips keep a fixed stretch ratio'
  const autoScrollLabel = autoScrollEnabled
    ? 'Auto scroll on: the timeline follows the playhead during playback'
    : 'Auto scroll off: the timeline stays put during playback'

  return (
    <div className={styles.cluster} role="group" aria-label="Transport" data-testid="transport-cluster">
      <div className={styles.group}>
        <IconButton
          label="Rewind"
          onClick={() => window.xleth?.stop()}
          hint="Rewind to the start"
          hintMods="Home"
        >
          <SkipBack aria-hidden="true" />
        </IconButton>
        <IconButton
          label="Stop"
          onClick={() => window.xleth?.stop()}
          hint="Stop"
        >
          <Square aria-hidden="true" />
        </IconButton>
        <IconButton
          className={styles.play}
          label={playLabel}
          data-playing={isPlaying ? 'true' : 'false'}
          onClick={() => (isPlaying ? window.xleth?.pause() : window.xleth?.play())}
          hint={playLabel}
          hintMods={spacebarMode === 'play-stop' ? 'Space: play / stop and return' : 'Space: play / pause'}
        >
          {isPlaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
        </IconButton>
        {/* Forward has never been wired to the engine. It stays visible so the
            transport reads as a set, but it is disabled rather than a button
            that silently does nothing. */}
        <IconButton
          label="Forward (not available yet)"
          disabled
          hint="Forward: not available yet"
        >
          <SkipForward aria-hidden="true" />
        </IconButton>
      </div>

      <span className={styles.sep} aria-hidden="true" />
      <PositionDisplay />
      <span className={styles.sep} aria-hidden="true" />

      <div className={styles.group}>
        <NumberBox
          label="Tempo"
          hideLabel
          size="md"
          width={88}
          value={bpm}
          scale={BPM_SCALE}
          step={1}
          pxPerRange={1000}
          quantize={roundBpm}
          defaultValue={BPM_DEFAULT}
          format={formatBpm}
          parse={parseBpm}
          onCommit={commitBpm}
          hint="Tempo in BPM"
          hintMods="Drag: change · Shift: fine · Double-click: type · Ctrl+click: 140"
        />
        <IconButton
          label="Tempo lock"
          pressed={tempoLocked}
          tone="quiet"
          onClick={() => {
            const next = !tempoLocked
            setTempoLocked(next)
            window.xleth?.timeline?.setTempoLocked?.(next)
          }}
          hint={tempoLockLabel}
        >
          {tempoLocked ? <Lock aria-hidden="true" /> : <LockOpen aria-hidden="true" />}
        </IconButton>
      </div>

      <span className={styles.sep} aria-hidden="true" />

      <IconButton
        label="Auto scroll"
        pressed={autoScrollEnabled}
        onClick={toggleAutoScroll}
        hint={autoScrollLabel}
      >
        <Crosshair aria-hidden="true" />
      </IconButton>
    </div>
  )
}
