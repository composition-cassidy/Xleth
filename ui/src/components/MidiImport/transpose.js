// Shared constants/helpers for the MIDI-import per-output-track transpose.
// Engine range is [-24, 24] semitones (see MidiImporter.cpp parseImportOptions);
// this mirrors that bound so an out-of-range value never reaches the engine
// and gets rejected there. 0 = no shift, the default for every output track,
// including drum sub-tracks (whose UI never exposes the control).
export const TRANSPOSE_MIN_SEMITONES = -24
export const TRANSPOSE_MAX_SEMITONES = 24
export const DEFAULT_TRANSPOSE_SEMITONES = 0

export function clampTransposeSemitones(value) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return DEFAULT_TRANSPOSE_SEMITONES
  return Math.max(TRANSPOSE_MIN_SEMITONES, Math.min(TRANSPOSE_MAX_SEMITONES, n))
}
