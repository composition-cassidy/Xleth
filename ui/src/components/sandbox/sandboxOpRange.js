// ── Which part of the buffer does this op act on? ───────────────────────────
//
// The op stack is non-destructive and text-only: a row says "Cut" and a range,
// and nothing on the waveform says WHERE that cut happened. That is the single
// biggest reason the stack reads as a log rather than an editable document —
// you cannot point at an entry and see its effect.
//
// This is the one place that knows how to read a range out of an op's params,
// shared by the canvas (which highlights the range of the selected op) and the
// stack rail (which offers "zoom to this op"). Ops with no meaningful range —
// a whole-buffer gain, a pitch shift, an autotune — return null rather than
// pretending to cover everything, because a highlight over the entire waveform
// communicates nothing.
//
// Sample indices are in the CURRENT rendered buffer's timeline, which is only
// exactly right for the op at the top of the stack: an op that changes length
// shifts everything after it. Treated as a locator, never as an authority —
// the engine's own params remain the truth, this only decides where to point.
export function opSampleRange(op) {
  const p = op?.params
  if (!p) return null
  switch (op.type) {
    case 'trim':
    case 'cut':
    case 'reverse':
    case 'declip':
      return rangeOf(p.startSample, p.endSample)
    case 'denoise':
      return rangeOf(p.noiseStartSample, p.noiseEndSample)
    case 'gain':
      // Only a gain scoped to a range has somewhere to point. endSample -1 is
      // the engine's "to the end", i.e. the whole layer, and rangeOf would
      // happily sort (0, -1) into a one-sample range — so it is ruled out here.
      return p.endSample > p.startSample ? rangeOf(p.startSample, p.endSample) : null
    case 'fade':
      // The engine fades [startSample, startSample + lengthSamples) — a fade
      // can sit anywhere, not only against an edge (FadeParams, applyFade).
      // This used to assume the edge, so a fade drawn over a selection in the
      // middle of the layer was highlighted at the start or the end instead.
      if (Number.isFinite(p.startSample)) return rangeOf(p.startSample, p.startSample + (p.lengthSamples ?? 0))
      // Params with no start (older stacks): fade-in runs from the start of the
      // buffer, fade-out ends at its end — which this cannot know without the
      // buffer length, so the caller supplies it.
      return p.fadeIn ? rangeOf(0, p.lengthSamples) : { fromEnd: true, lengthSamples: p.lengthSamples }
    case 'crossfade':
      return rangeOf(p.atSample - (p.lengthSamples ?? 0) / 2, p.atSample + (p.lengthSamples ?? 0) / 2)
    case 'paste':
      return rangeOf(p.atSample, p.atSample + (p.clipboardLengthSamples ?? 0))
    case 'splice':
      return rangeOf(p.atSample, p.atSample + (p.gapSamples ?? 0))
    case 'gainEnvelope': {
      const pts = p.points || []
      if (pts.length < 2) return null
      return rangeOf(pts[0].samplePos, pts[pts.length - 1].samplePos)
    }
    case 'spectralPaint': {
      const dabs = p.dabs || []
      if (!dabs.length) return null
      let lo = Infinity, hi = -Infinity
      for (const d of dabs) {
        lo = Math.min(lo, d.centerSample - d.halfWidthSamples)
        hi = Math.max(hi, d.centerSample + d.halfWidthSamples)
      }
      return rangeOf(lo, hi)
    }
    default:
      return null
  }
}

function rangeOf(a, b) {
  const start = Math.round(Math.min(a, b))
  const end = Math.round(Math.max(a, b))
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  return { startSample: start, endSample: end }
}

// Resolve the fade-from-the-end form against a real buffer length. Kept
// separate so opSampleRange itself stays a pure read of the params.
export function resolveOpRange(range, numSamples) {
  if (!range) return null
  if (range.fromEnd) {
    const end = Math.max(0, Math.floor(numSamples) || 0)
    const start = Math.max(0, end - (range.lengthSamples ?? 0))
    return end > start ? { startSample: start, endSample: end } : null
  }
  return range
}
