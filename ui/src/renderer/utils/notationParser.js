// Base tick unit at 960 PPQ: a 16th note = 1/4 beat = 240 ticks
const TICKS_PER_16TH = 240
const TICKS_PER_32ND = 120

/**
 * Parse a notation string into clip placement descriptors.
 *
 * @param {string} str           Notation string (e.g. "11_1*2_")
 * @param {number} syllableCount Number of valid syllables (1-based max index)
 * @param {number} cursorTick    Absolute tick to begin counting from
 * @param {number} offsetPercent audioOffsetPercent for modifier tokens (', #, x)
 * @returns {{ placements: Array, errors: Array, totalTicks: number }}
 *
 * Token grammar (base unit = 16th note = 240 ticks at 960 PPQ):
 *   N          digit 1–9, 16th note (240t), audioOffsetPercent = 0
 *   N*         8th note (480t), audioOffsetPercent = 0
 *   N**        quarter (960t), etc. (each * doubles duration)
 *   N'  N#     32nd note (120t), audioOffsetPercent = offsetPercent
 *   Nx         TWO 32nd clips back-to-back at offsetPercent, 240t total
 *   _          16th rest (240t, no placement)
 *   /          32nd rest (120t, no placement)
 *   ~          no-op, zero ticks
 *   unknown    push to errors, advance 0 ticks, continue
 */
export function parseNotation(str, syllableCount, cursorTick, offsetPercent) {
  const placements = []
  const errors = []
  let tick = cursorTick
  let i = 0

  while (i < str.length) {
    const char = str[i]
    const position = i

    if (char === '~') {
      i++
      continue
    }

    if (char === '_') {
      tick += TICKS_PER_16TH
      i++
      continue
    }

    if (char === '/') {
      tick += TICKS_PER_32ND
      i++
      continue
    }

    const code = char.charCodeAt(0)
    if (code >= 49 && code <= 57) { // '1'–'9'
      const syllableIndex = code - 49 // convert to 0-based
      i++

      // N* N** N*** … — each star doubles from the 16th-note base
      if (i < str.length && str[i] === '*') {
        let starCount = 0
        while (i < str.length && str[i] === '*') { starCount++; i++ }
        const durationTicks = TICKS_PER_16TH * Math.pow(2, starCount)
        if (syllableIndex < syllableCount) {
          placements.push({ syllableIndex, startTick: tick, audioOffsetPercent: 0 })
        } else {
          errors.push({ char, position, reason: `Syllable ${syllableIndex + 1} out of range` })
        }
        tick += durationTicks
        continue
      }

      // N' or N# — 32nd note with offsetPercent
      if (i < str.length && (str[i] === "'" || str[i] === '#')) {
        i++
        if (syllableIndex < syllableCount) {
          placements.push({ syllableIndex, startTick: tick, audioOffsetPercent: offsetPercent })
        } else {
          errors.push({ char, position, reason: `Syllable ${syllableIndex + 1} out of range` })
        }
        tick += TICKS_PER_32ND
        continue
      }

      // Nx — two 32nd clips back-to-back, 240t total
      if (i < str.length && str[i] === 'x') {
        i++
        if (syllableIndex < syllableCount) {
          placements.push({ syllableIndex, startTick: tick, audioOffsetPercent: offsetPercent })
          placements.push({ syllableIndex, startTick: tick + TICKS_PER_32ND, audioOffsetPercent: offsetPercent })
        } else {
          errors.push({ char, position, reason: `Syllable ${syllableIndex + 1} out of range` })
        }
        tick += TICKS_PER_16TH
        continue
      }

      // Plain N — 16th note, audioOffsetPercent = 0
      if (syllableIndex < syllableCount) {
        placements.push({ syllableIndex, startTick: tick, audioOffsetPercent: 0 })
      } else {
        errors.push({ char, position, reason: `Syllable ${syllableIndex + 1} out of range` })
      }
      tick += TICKS_PER_16TH
      continue
    }

    // Unknown token: record error, advance 0 ticks
    errors.push({ char, position, reason: 'Unknown token' })
    i++
  }

  return { placements, errors, totalTicks: tick - cursorTick }
}
