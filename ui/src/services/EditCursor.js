/**
 * EditCursor — client-side edit anchor, independent of transport engine.
 *
 * Pure JS. Zero IPC, zero async, zero refs. Instant read/write.
 * Determines where paste / duplicate / insert operations land.
 *
 * Sync points (done by TimelineView):
 *   - User clicks ruler → setPosition + fire-and-forget transport.seek
 *   - Playback stops    → setPosition(enginePos)
 *   - Playback playing  → setPosition(enginePos) at 10fps via PlayheadClock
 *   - Paste / duplicate → setPosition advances synchronously BEFORE any await,
 *                         so rapid spamming reads fresh values.
 */

import { PPQ } from '../constants/timeline.js'

class EditCursor {
  constructor() {
    this.beatPosition = 0
  }

  getPosition() {
    return this.beatPosition
  }

  setPosition(beat) {
    this.beatPosition = Math.max(0, beat)
  }

  advance(durationTicks, ppq = PPQ) {
    this.beatPosition += durationTicks / ppq
  }
}

export const editCursor = new EditCursor()
