// A still image (a photo, or a generated solid colour / gradient) imports as ONE
// video frame. It is media you drag straight onto a track, never cut into
// samples: every clip of it shares one hidden full-frame region.
export const isStillSource = (s) =>
  !!s && s.hasVideo !== false && s.fps > 0 && s.duration > 0 && s.duration * s.fps < 1.5

// A dropped still starts one bar long; it holds its frame however far it is stretched.
export const STILL_CLIP_BEATS = 4
