// Effective playback duration in seconds for a SampleRegion.
//
// For regions whose audio has been swapped with a longer file, the resize cap
// and waveform fetch span need to extend past the original video range so the
// audio tail is reachable. The video itself holds on its last frame past the
// region's video end (FrameCollector clamps to ev->sourceEndTime - 0.001s).
//
// Uses max(video, swappedAudio) — never shrinks below the original video range
// even if swapped audio is shorter, so existing arrangements aren't disrupted.
export function getRegionPlaybackDurationSec(region) {
  if (!region) return 0
  const videoDur = Math.max(0, (region.endTime ?? 0) - (region.startTime ?? 0))
  const audioDur = (region.hasSwappedAudio && region.swappedAudioDurationSec > 0)
    ? region.swappedAudioDurationSec : 0
  return Math.max(videoDur, audioDur)
}
