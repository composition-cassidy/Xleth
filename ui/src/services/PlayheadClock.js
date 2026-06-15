/**
 * Client-side playhead interpolation at 60fps.
 *
 * Plain JS — no React. A single rAF loop updates positionMs via
 * performance.now()-based linear interpolation. Canvas listeners
 * draw directly (no setState). Display listeners fire at 10fps max.
 *
 * Transport IPC events provide drift correction via syncFromEngine().
 */

const LOCAL_SEEK_HOLD_MS = 500
const LOCAL_SEEK_MATCH_BEATS = 1 / 960
const LOCAL_SEEK_MATCH_MS = 2

export class PlayheadClock {
  constructor() {
    this.positionMs = 0
    this.positionBeatsValue = 0
    this.bpm = 140
    this.isPlaying = false
    this._startWallTime = 0
    this._startPositionMs = 0
    this._startPositionBeats = 0
    this._animFrame = null
    this._listeners = new Set()        // 60fps canvas callbacks
    this._displayListeners = new Set() // 10fps throttled UI callbacks
    this._lastDisplayUpdate = 0
    this._pendingLocalSeek = null
  }

  /** Called when transport state arrives from engine (IPC drift correction). */
  syncFromEngine(positionMs, bpm, isPlaying, positionBeats = null, options = {}) {
    this.bpm = bpm
    const beats = Number.isFinite(positionBeats)
      ? positionBeats
      : (positionMs / 1000) * (bpm / 60)

    if (options.source !== 'local' && this._shouldIgnoreStaleEngineSync(positionMs, isPlaying, beats)) {
      return
    }

    if (isPlaying && !this.isPlaying) {
      // Playback just started — anchor interpolation
      this._startWallTime = performance.now()
      this._startPositionMs = positionMs
      this._startPositionBeats = beats
      this.isPlaying = true
      this._tick()
    } else if (!isPlaying && this.isPlaying) {
      // Playback stopped — snap to engine position
      this.isPlaying = false
      this.positionMs = positionMs
      this.positionBeatsValue = beats
      cancelAnimationFrame(this._animFrame)
      this._notifyAll()
    } else if (isPlaying) {
      // Drift correction during playback — re-anchor only if drift > 30ms
      const interpolated = this._interpolate()
      const drift = Math.abs(interpolated - positionMs)
      if (drift > 30) {
        this._startWallTime = performance.now()
        this._startPositionMs = positionMs
        this._startPositionBeats = beats
      }
    } else {
      // Stopped — direct update (seeking while paused)
      this.positionMs = positionMs
      this.positionBeatsValue = beats
      this._notifyAll()
    }
  }

  /**
   * Immediately publishes a user-driven seek and briefly shields it from stale
   * transport polls that were already in flight before the engine applied seek.
   */
  seekLocally(positionMs, bpm, isPlaying, positionBeats = null) {
    const beats = Number.isFinite(positionBeats)
      ? positionBeats
      : (positionMs / 1000) * (bpm / 60)

    this._pendingLocalSeek = {
      positionMs,
      positionBeats: beats,
      expiresAt: performance.now() + LOCAL_SEEK_HOLD_MS,
    }

    this.syncFromEngine(positionMs, bpm, isPlaying, beats, { source: 'local' })
  }

  _shouldIgnoreStaleEngineSync(positionMs, isPlaying, positionBeats) {
    const pending = this._pendingLocalSeek
    if (!pending) return false

    if (isPlaying !== this.isPlaying) {
      this._pendingLocalSeek = null
      return false
    }

    const now = performance.now()
    const matchesPending =
      Math.abs(positionBeats - pending.positionBeats) <= LOCAL_SEEK_MATCH_BEATS ||
      Math.abs(positionMs - pending.positionMs) <= LOCAL_SEEK_MATCH_MS

    if (matchesPending || now > pending.expiresAt) {
      this._pendingLocalSeek = null
      return false
    }

    return true
  }

  _interpolate() {
    const elapsed = performance.now() - this._startWallTime
    return this._startPositionMs + elapsed
  }

  _tick() {
    if (!this.isPlaying) return

    this.positionMs = this._interpolate()
    this.positionBeatsValue = this._startPositionBeats
      + ((performance.now() - this._startWallTime) / 1000) * (this.bpm / 60)

    // Canvas listeners — every frame (must NOT setState)
    for (const cb of this._listeners) cb(this.positionMs, this.bpm, this.positionBeatsValue)

    // Display listeners — 10fps max (can setState)
    const now = performance.now()
    if (now - this._lastDisplayUpdate > 100) {
      this._lastDisplayUpdate = now
      for (const cb of this._displayListeners) cb(this.positionMs, this.bpm, this.positionBeatsValue)
    }

    this._animFrame = requestAnimationFrame(() => this._tick())
  }

  _notifyAll() {
    for (const cb of this._listeners) cb(this.positionMs, this.bpm, this.positionBeatsValue)
    for (const cb of this._displayListeners) cb(this.positionMs, this.bpm, this.positionBeatsValue)
  }

  /** Subscribe to 60fps frame updates. Callback must NOT call setState. */
  onFrame(callback) {
    this._listeners.add(callback)
    return () => this._listeners.delete(callback)
  }

  /** Subscribe to 10fps display updates. Callback CAN call setState. */
  onDisplayUpdate(callback) {
    this._displayListeners.add(callback)
    return () => this._displayListeners.delete(callback)
  }

  get positionBeats() { return this.positionBeatsValue }
  get positionBars() { return Math.floor(this.positionBeats / 4) + 1 }
  get positionSeconds() { return this.positionMs / 1000 }

  destroy() {
    if (this._animFrame) cancelAnimationFrame(this._animFrame)
    this._pendingLocalSeek = null
    this._listeners.clear()
    this._displayListeners.clear()
  }
}

// Singleton — shared across all components
export const playheadClock = new PlayheadClock()
