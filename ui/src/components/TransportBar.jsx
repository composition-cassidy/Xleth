import { useState, useEffect, useRef, useCallback, memo } from 'react'
import { SkipBack, Play, Pause, Square, SkipForward, Sliders } from 'lucide-react'
import AudioDeviceSelector from './AudioDeviceSelector.jsx'
import { subscribe } from '../transportStore.js'
import { playheadClock } from '../services/PlayheadClock.js'
import useMixerStore from '../stores/mixerStore.js'

function formatTime(ms) {
  const totalMs = Math.max(0, ms)
  const minutes = Math.floor(totalMs / 60000)
  const seconds = Math.floor((totalMs % 60000) / 1000)
  const millis  = Math.floor(totalMs % 1000)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
}

// Isolated position display — subscribes to 10fps updates without re-rendering
// the rest of the transport bar (play buttons, BPM editor, etc.).
const PositionDisplay = memo(function PositionDisplay() {
  const [pos, setPos] = useState({ ms: 0, beats: 0, bars: 1 })

  useEffect(() => {
    return playheadClock.onDisplayUpdate((posMs, bpm) => {
      const beats = posMs * bpm / 60000
      setPos({ ms: posMs, beats, bars: Math.floor(beats / 4) + 1 })
    })
  }, [])

  return (
    <div className="transport-position">
      <div className="transport-time">{formatTime(pos.ms)}</div>
      <div className="transport-beat-info">
        <span className="transport-label">BAR</span>
        <span className="transport-value">{Math.floor(pos.bars)}</span>
        <span className="transport-sep">/</span>
        <span className="transport-label">BEAT</span>
        <span className="transport-value">{(pos.beats % 4).toFixed(1)}</span>
      </div>
    </div>
  )
})

export default function TransportBar() {
  const [isPlaying, setIsPlaying] = useState(false)
  const [bpm, setBpm] = useState(140)
  const mixerVisible = useMixerStore(s => s.visible)
  const toggleMixer = useMixerStore(s => s.toggleMixer)

  const [editingBpm, setEditingBpm] = useState(false)
  const [bpmInput, setBpmInput] = useState('140')
  const bpmRef = useRef(null)

  // Transport store for control state (isPlaying, bpm — immediate response)
  useEffect(() => subscribe((s) => {
    setIsPlaying(prev => prev !== s.isPlaying ? s.isPlaying : prev)
    setBpm(prev => prev !== s.bpm ? s.bpm : prev)
  }), [])

  // Global keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      // Don't capture when editing BPM
      if (editingBpm) return
      // Don't capture if focus is on an input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return

      if (e.code === 'Space') {
        e.preventDefault()
        if (isPlaying) window.xleth?.pause()
        else window.xleth?.play()
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
  }, [isPlaying, editingBpm])

  // BPM editing
  const startEditBpm = useCallback(() => {
    setEditingBpm(true)
    setBpmInput(String(Math.round(bpm)))
    setTimeout(() => bpmRef.current?.select(), 0)
  }, [bpm])

  const commitBpm = useCallback(() => {
    setEditingBpm(false)
    const val = parseFloat(bpmInput)
    if (!isNaN(val) && val >= 20 && val <= 999) {
      console.log(`[UI] BPM → ${val}`)
      // Use the timeline-aware setBPM if available, else fallback
      if (window.xleth?.timeline?.setBPM) {
        window.xleth.timeline.setBPM(val)
      } else {
        // Legacy direct transport setter (Phase 0 compat)
        window.xleth?.play && fetch('') // no-op placeholder
      }
    }
  }, [bpmInput])

  const onBpmKeyDown = useCallback((e) => {
    if (e.key === 'Enter') commitBpm()
    if (e.key === 'Escape') setEditingBpm(false)
  }, [commitBpm])

  return (
    <div className="transport-bar">
      {/* ── Transport controls ─────────────────────────────────────────── */}
      <div className="transport-controls">
        <button
          className="transport-btn"
          onClick={() => window.xleth?.stop()}
          title="Rewind (Home)"
        >
          <SkipBack size={16} />
        </button>
        <button
          className="transport-btn"
          onClick={() => window.xleth?.stop()}
          title="Stop"
        >
          <Square size={14} />
        </button>
        {isPlaying ? (
          <button
            className="transport-btn transport-btn-active"
            onClick={() => window.xleth?.pause()}
            title="Pause (Space)"
          >
            <Pause size={16} />
          </button>
        ) : (
          <button
            className="transport-btn transport-btn-play"
            onClick={() => window.xleth?.play()}
            title="Play (Space)"
          >
            <Play size={16} />
          </button>
        )}
        <button
          className="transport-btn"
          onClick={() => {}}
          title="Forward"
        >
          <SkipForward size={16} />
        </button>
      </div>

      {/* ── Position display (isolated memo — only this subtree re-renders at 10fps) ── */}
      <PositionDisplay />

      {/* ── Mixer toggle ───────────────────────────────────────────────── */}
      <button
        className={`transport-btn ${mixerVisible ? 'transport-btn-active' : ''}`}
        onClick={toggleMixer}
        title="Toggle Mixer (M)"
      >
        <Sliders size={14} />
      </button>

      <AudioDeviceSelector />

      {/* ── Spacer ──────────────────────────────────────────────────────── */}
      <div className="transport-spacer" />

      {/* ── BPM ─────────────────────────────────────────────────────────── */}
      <div className="transport-bpm">
        {editingBpm ? (
          <input
            ref={bpmRef}
            type="number"
            className="transport-bpm-input"
            value={bpmInput}
            onChange={(e) => setBpmInput(e.target.value)}
            onBlur={commitBpm}
            onKeyDown={onBpmKeyDown}
            min={20}
            max={999}
            step={1}
            autoFocus
          />
        ) : (
          <button className="transport-bpm-display" onClick={startEditBpm} title="Click to edit BPM">
            {Math.round(bpm)}
          </button>
        )}
        <span className="transport-bpm-label">BPM</span>
      </div>

      {/* ── Shortcut hints ──────────────────────────────────────────────── */}
      <div className="transport-hints">
        <kbd>SPACE</kbd>
        <span>play/pause</span>
        <kbd>HOME</kbd>
        <span>rewind</span>
      </div>
    </div>
  )
}
