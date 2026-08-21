/**
 * clipSourceDomain — timeline ticks ↔ source ticks for stretched clips.
 *
 * JS mirror of engine/src/model/ClipSourceAnchor.h. `clip.regionOffsetTicks` is
 * measured in SOURCE time: the engine applies it to the raw PCM *before* the
 * stretcher runs (ClipRenderCache.cpp), so a clip whose timeline duration is D
 * ticks only consumes D / stretchRatio source ticks.
 *
 * Consequence for every clip edit:
 *   - turning a timeline distance into a regionOffset  → divide by the ratio
 *   - comparing a regionOffset against a timeline span → multiply by the ratio
 *
 * Adding the two domains directly is the bug this module exists to prevent: a
 * 1.50× clip split in half used to give the right half an offset 1.5× too deep,
 * so it started late and ran out of source before its end (silent tail).
 *
 * Keep these two functions numerically identical to the C++ ones — the engine
 * splice path (S key) and the renderer split path must produce the same offsets.
 */

/** Sanitize a stretchRatio for use as a divisor (0/NaN/negative → unity). */
export function effectiveStretchRatio(stretchRatio) {
  const r = Number(stretchRatio)
  return Number.isFinite(r) && r > 0 ? r : 1.0
}

/** SOURCE ticks consumed over `timelineTicks` of timeline. Identity at unity. */
export function sourceTicksForTimelineTicks(timelineTicks, stretchRatio) {
  const r = effectiveStretchRatio(stretchRatio)
  if (r === 1.0) return timelineTicks
  return Math.round(timelineTicks / r)
}

/** TIMELINE ticks produced by `sourceTicks` of source. Identity at unity. */
export function timelineTicksForSourceTicks(sourceTicks, stretchRatio) {
  const r = effectiveStretchRatio(stretchRatio)
  if (r === 1.0) return sourceTicks
  return Math.round(sourceTicks * r)
}
