/**
 * Client-side playhead interpolation at 60fps.
 *
 * Plain JS — no React. A single rAF loop updates positionMs via
 * performance.now()-based linear interpolation. Canvas listeners
 * draw directly (no setState). Display listeners fire at 10fps max.
 *
 * Transport IPC events provide drift correction via syncFromEngine().
 */

class PlayheadClock {
  constructor() {
    this.positionMs = 0
    this.bpm = 140
    this.isPlaying = false
    this._startWallTime = 0
    this._startPositionMs = 0
    this._animFrame = null
    this._listeners = new Set()        // 60fps canvas callbacks
    this._displayListeners = new Set() // 10fps throttled UI callbacks
    this._lastDisplayUpdate = 0
  }

  /** Called when transport state arrives from engine (IPC drift correction). */
  syncFromEngine(positionMs, bpm, isPlaying) {
    this.bpm = bpm

    if (isPlaying && !this.isPlaying) {
      // Playback just started — anchor interpolation
      this._startWallTime = performance.now()
      this._startPositionMs = positionMs
      this.isPlaying = true
      this._tick()
    } else if (!isPlaying && this.isPlaying) {
      // Playback stopped — snap to engine position
      this.isPlaying = false
      this.positionMs = positionMs
      cancelAnimationFrame(this._animFrame)
      this._notifyAll()
    } else if (isPlaying) {
      // Drift correction during playback — re-anchor only if drift > 30ms
      const interpolated = this._interpolate()
      const drift = Math.abs(interpolated - positionMs)
      if (drift > 30) {
        this._startWallTime = performance.now()
        this._startPositionMs = positionMs
      }
    } else {
      // Stopped — direct update (seeking while paused)
      this.positionMs = positionMs
      this._notifyAll()
    }
  }

  _interpolate() {
    const elapsed = performance.now() - this._startWallTime
    return this._startPositionMs + elapsed
  }

  _tick() {
    if (!this.isPlaying) return

    this.positionMs = this._interpolate()

    // Canvas listeners — every frame (must NOT setState)
    for (const cb of this._listeners) cb(this.positionMs, this.bpm)

    // Display listeners — 10fps max (can setState)
    const now = performance.now()
    if (now - this._lastDisplayUpdate > 100) {
      this._lastDisplayUpdate = now
      for (const cb of this._displayListeners) cb(this.positionMs, this.bpm)
    }

    this._animFrame = requestAnimationFrame(() => this._tick())
  }

  _notifyAll() {
    for (const cb of this._listeners) cb(this.positionMs, this.bpm)
    for (const cb of this._displayListeners) cb(this.positionMs, this.bpm)
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

  get positionBeats() { return (this.positionMs / 1000) * (this.bpm / 60) }
  get positionBars() { return Math.floor(this.positionBeats / 4) + 1 }
  get positionSeconds() { return this.positionMs / 1000 }

  destroy() {
    if (this._animFrame) cancelAnimationFrame(this._animFrame)
    this._listeners.clear()
    this._displayListeners.clear()
  }
}

// Singleton — shared across all components
export const playheadClock = new PlayheadClock()
