export function createPeakEntry() {
  return {
    peakL: 0,
    peakR: 0,
    holdL: 0,
    holdR: 0,
    holdTimeL: 0,
    holdTimeR: 0,
    hasTelemetry: false,
    lastTelemetryMs: 0,
  }
}

function ensurePeakEntry(snapshot, trackId) {
  if (!snapshot.tracks[trackId]) {
    snapshot.tracks[trackId] = createPeakEntry()
  }
  return snapshot.tracks[trackId]
}

function clearPeakEntry(entry) {
  entry.peakL = 0
  entry.peakR = 0
  entry.holdL = 0
  entry.holdR = 0
  entry.holdTimeL = 0
  entry.holdTimeR = 0
  entry.hasTelemetry = false
  entry.lastTelemetryMs = 0
}

function mergePeakEntry(entry, peakL, peakR, now) {
  entry.peakL = peakL
  entry.peakR = peakR
  entry.hasTelemetry = true
  entry.lastTelemetryMs = now

  if (peakL >= entry.holdL) {
    entry.holdL = peakL
    entry.holdTimeL = now
  }
  if (peakR >= entry.holdR) {
    entry.holdR = peakR
    entry.holdTimeR = now
  }
  if (now - entry.holdTimeL > 1500) entry.holdL *= 0.95
  if (now - entry.holdTimeR > 1500) entry.holdR *= 0.95
}

function toPeakValue(value) {
  return Number.isFinite(value) ? value : 0
}

export function clearAllMeterTelemetry(snapshot) {
  for (const entry of Object.values(snapshot.tracks)) {
    clearPeakEntry(entry)
  }
  clearPeakEntry(snapshot.master)
}

export function prunePeakSnapshotTracks(snapshot, trackIds) {
  const liveIds = new Set(trackIds.map(String))
  for (const trackId of Object.keys(snapshot.tracks)) {
    if (!liveIds.has(trackId)) delete snapshot.tracks[trackId]
  }
}

export function mergeMeterTelemetry(snapshot, data, now) {
  const seenTrackIds = new Set()
  const tracks = data?.tracks

  if (tracks && typeof tracks === 'object') {
    for (const [trackId, peaks] of Object.entries(tracks)) {
      const entry = ensurePeakEntry(snapshot, trackId)
      mergePeakEntry(
        entry,
        toPeakValue(peaks?.peakL),
        toPeakValue(peaks?.peakR),
        now,
      )
      seenTrackIds.add(trackId)
    }
  }

  for (const [trackId, entry] of Object.entries(snapshot.tracks)) {
    if (!seenTrackIds.has(trackId)) clearPeakEntry(entry)
  }

  if (data?.master && typeof data.master === 'object') {
    mergePeakEntry(
      snapshot.master,
      toPeakValue(data.master.peakL),
      toPeakValue(data.master.peakR),
      now,
    )
  } else {
    clearPeakEntry(snapshot.master)
  }
}
