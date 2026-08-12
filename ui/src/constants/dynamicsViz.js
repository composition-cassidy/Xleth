// ─── dynamicsViz.js ──────────────────────────────────────────────────────────
// Mirror of engine/src/audio/viz/DynamicsVizFrame.h on the JS side.
//
// Bump these constants ONLY in lockstep with the C++ header, otherwise the
// runtime parser will (correctly) refuse to decode buckets and the viz node
// will fall back to the "Visualization unavailable" placeholder.
//
// All offsets are byte offsets into the bucket struct, computed at compile
// time on the C++ side. We re-state them here so the parser can use a
// DataView without copying — the payload arrives as an ArrayBuffer over IPC.

export const DYNAMICS_VIZ_SCHEMA_VERSION = 3

// Type-tag strings (must match the strings the bridge emits in the drain
// response: "compressor" → kVizTypeCompressor, "limiter" → kVizTypeLimiter,
// "unknown" → kVizTypeUnknown).
export const VIZ_TYPE = Object.freeze({
  UNKNOWN:    'unknown',
  COMPRESSOR: 'compressor',
  LIMITER:    'limiter',
  TRANSIENT:  'transient',
  MULTIBAND:  'multiband',
  RESONANCE:  'resonance',
  UNIFLANGE:  'uniflange',
  APEX:       'apex',
})

// ── Bucket layouts ──────────────────────────────────────────────────────────
//
// CompressorBucket — 40 bytes total.
//   uint64  sampleClock     @  0
//   uint32  bucketSamples   @  8
//   uint32  flags           @ 12
//   float32 inLevelDb       @ 16
//   float32 outLevelDb      @ 20
//   float32 detectorDb      @ 24
//   float32 grDb            @ 28
//   float32 ioInDb          @ 32
//   float32 ioOutDb         @ 36

export const COMPRESSOR_BUCKET = Object.freeze({
  sizeBytes: 40,
  fields: Object.freeze({
    sampleClock:   { offset:  0, type: 'u64'   },
    bucketSamples: { offset:  8, type: 'u32'   },
    flags:         { offset: 12, type: 'u32'   },
    inLevelDb:     { offset: 16, type: 'float' },
    outLevelDb:    { offset: 20, type: 'float' },
    detectorDb:    { offset: 24, type: 'float' },
    grDb:          { offset: 28, type: 'float' },
    ioInDb:        { offset: 32, type: 'float' },
    ioOutDb:       { offset: 36, type: 'float' },
  }),
})

// LimiterBucket — 56 bytes total.
//   uint64  sampleClock     @  0
//   uint32  bucketSamples   @  8
//   uint32  flags           @ 12
//   float32 inLevelDb       @ 16   (peak abs, post-gain pre-limit)
//   float32 outLevelDb      @ 20   (peak abs, post-limit)
//   float32 gainReductionDb @ 24   (max GR dB, positive = more reduction)
//   float32 inEnergyDb      @ 28   (mean-square dB; cheap RMS-like, NOT LUFS)
//   float32 outEnergyDb     @ 32
//   float32 ceilingDb       @ 36
//   float32 gainDb          @ 40
//   float32 releaseMs       @ 44
//   float32 reserved0       @ 48
//   (4 bytes pad to 56)     @ 52
export const LIMITER_BUCKET = Object.freeze({
  sizeBytes: 56,
  fields: Object.freeze({
    sampleClock:     { offset:  0, type: 'u64'   },
    bucketSamples:   { offset:  8, type: 'u32'   },
    flags:           { offset: 12, type: 'u32'   },
    inLevelDb:       { offset: 16, type: 'float' },
    outLevelDb:      { offset: 20, type: 'float' },
    gainReductionDb: { offset: 24, type: 'float' },
    inEnergyDb:      { offset: 28, type: 'float' },
    outEnergyDb:     { offset: 32, type: 'float' },
    ceilingDb:       { offset: 36, type: 'float' },
    gainDb:          { offset: 40, type: 'float' },
    releaseMs:       { offset: 44, type: 'float' },
  }),
})

// TransientBucket — 56 bytes total.
//   uint64  sampleClock     @  0
//   uint32  bucketSamples   @  8
//   uint32  flags           @ 12
//   float32 inLevelDb       @ 16   (peak abs input)
//   float32 outLevelDb      @ 20   (peak abs output)
//   float32 fastEnvDb       @ 24   (last-sample fast envelope; NaN in MIDI mode)
//   float32 slowEnvDb       @ 28   (last-sample slow envelope; NaN in MIDI mode)
//   float32 gainDb          @ 32   (signed: positive = boost, negative = cut)
//   float32 attackAmount    @ 36   (param normalised to [-1, 1])
//   float32 sustainAmount   @ 40   (param normalised to [-1, 1])
//   float32 speedMs         @ 44
//   float32 thresholdDb     @ 48
//   float32 mix             @ 52   (param normalised to [0, 1])
export const TRANSIENT_BUCKET = Object.freeze({
  sizeBytes: 56,
  fields: Object.freeze({
    sampleClock:   { offset:  0, type: 'u64'   },
    bucketSamples: { offset:  8, type: 'u32'   },
    flags:         { offset: 12, type: 'u32'   },
    inLevelDb:     { offset: 16, type: 'float' },
    outLevelDb:    { offset: 20, type: 'float' },
    fastEnvDb:     { offset: 24, type: 'float' },
    slowEnvDb:     { offset: 28, type: 'float' },
    gainDb:        { offset: 32, type: 'float' },
    attackAmount:  { offset: 36, type: 'float' },
    sustainAmount: { offset: 40, type: 'float' },
    speedMs:       { offset: 44, type: 'float' },
    thresholdDb:   { offset: 48, type: 'float' },
    mix:           { offset: 52, type: 'float' },
  }),
})

// MultibandBucket — 80 bytes total. Mirrors MultibandBucket in
// engine/src/audio/viz/DynamicsVizFrame.h. Used by the Overdone (3-band OTT)
// effect; positive gain-reduction convention matches Compressor / Limiter.
//
//   uint64  sampleClock          @  0
//   uint32  bucketSamples        @  8
//   uint32  flags                @ 12
//   float32 inputPeakDb          @ 16
//   float32 outputPeakDb         @ 20
//   float32 depth                @ 24   (percent, 0..100)
//   float32 time                 @ 28   (percent, 0..100)
//   float32 lowCrossoverHz       @ 32
//   float32 highCrossoverHz      @ 36
//   float32 lowInputDb           @ 40
//   float32 lowOutputDb          @ 44
//   float32 lowGainReductionDb   @ 48   (positive = more reduction)
//   float32 midInputDb           @ 52
//   float32 midOutputDb          @ 56
//   float32 midGainReductionDb   @ 60
//   float32 highInputDb          @ 64
//   float32 highOutputDb         @ 68
//   float32 highGainReductionDb  @ 72
//   float32 reserved0            @ 76
export const MULTIBAND_BUCKET = Object.freeze({
  sizeBytes: 80,
  fields: Object.freeze({
    sampleClock:          { offset:  0, type: 'u64'   },
    bucketSamples:        { offset:  8, type: 'u32'   },
    flags:                { offset: 12, type: 'u32'   },
    inputPeakDb:          { offset: 16, type: 'float' },
    outputPeakDb:         { offset: 20, type: 'float' },
    depth:                { offset: 24, type: 'float' },
    time:                 { offset: 28, type: 'float' },
    lowCrossoverHz:       { offset: 32, type: 'float' },
    highCrossoverHz:      { offset: 36, type: 'float' },
    lowInputDb:           { offset: 40, type: 'float' },
    lowOutputDb:          { offset: 44, type: 'float' },
    lowGainReductionDb:   { offset: 48, type: 'float' },
    midInputDb:           { offset: 52, type: 'float' },
    midOutputDb:          { offset: 56, type: 'float' },
    midGainReductionDb:   { offset: 60, type: 'float' },
    highInputDb:          { offset: 64, type: 'float' },
    highOutputDb:         { offset: 68, type: 'float' },
    highGainReductionDb:  { offset: 72, type: 'float' },
  }),
})

// ResonanceBucket -- 1584 bytes total. Mirrors ResonanceBucket in
// engine/src/audio/viz/DynamicsVizFrame.h. Arrays are fixed 128-bin
// log-frequency summaries for display only:
//   spectrum  @  48, 128 floats, normalized [0,1] where 0 ~= -120 dB
//   reduction @ 560, 128 floats, normalized [0,1] against 24 dB GR
//   weighting @1072, 128 floats, raw suppression sensitivity [0,2.5]
export const RESONANCE_BUCKET = Object.freeze({
  sizeBytes: 1584,
  bucketCount: 128,
  arrays: Object.freeze({
    spectrum:  { offset:   48, count: 128 },
    reduction: { offset:  560, count: 128 },
    weighting: { offset: 1072, count: 128 },
  }),
  fields: Object.freeze({
    sampleClock:   { offset:  0, type: 'u64'   },
    bucketSamples: { offset:  8, type: 'u32'   },
    flags:         { offset: 12, type: 'u32'   },
    sampleRate:    { offset: 16, type: 'float' },
    fftSize:       { offset: 20, type: 'float' },
    qualityIndex:  { offset: 24, type: 'float' },
    stereoMode:    { offset: 28, type: 'float' },
    activity:      { offset: 32, type: 'float' },
    bucketCount:   { offset: 36, type: 'float' },
    maxReductionDb:{ offset: 40, type: 'float' },
  }),
})

// UniFlangeBucket — 32 bytes total. Mirrors UniFlangeBucket in
// engine/src/audio/viz/DynamicsVizFrame.h. Unlike the other bucket types,
// these four fields are SIGNED LINEAR amplitude (not dB, not abs peak) —
// min/max sample excursion over the bucket — so the UI can draw a real
// above/below-center waveform shape for the dry (pre-effect) and wet
// (post cross-mix, pre dry/wet blend) taps.
//
//   uint64  sampleClock     @  0
//   uint32  bucketSamples   @  8
//   uint32  flags           @ 12
//   float32 dryMin          @ 16
//   float32 dryMax          @ 20
//   float32 wetMin          @ 24
//   float32 wetMax          @ 28
export const UNIFLANGE_BUCKET = Object.freeze({
  sizeBytes: 32,
  fields: Object.freeze({
    sampleClock:   { offset:  0, type: 'u64'   },
    bucketSamples: { offset:  8, type: 'u32'   },
    flags:         { offset: 12, type: 'u32'   },
    dryMin:        { offset: 16, type: 'float' },
    dryMax:        { offset: 20, type: 'float' },
    wetMin:        { offset: 24, type: 'float' },
    wetMax:        { offset: 28, type: 'float' },
  }),
})

// ApexBucket — 4192 bytes total. Mirrors ApexBucket in
// engine/src/audio/viz/DynamicsVizFrame.h.
//
// This bucket is much larger and much rarer than the others: it carries a
// 2048-point FFT magnitude spectrum, so the engine emits one per >= 1024 audio
// samples (~31-47 Hz) instead of the shared 64-sample (~700 Hz) cadence. A
// 30 Hz drain therefore returns one or two buckets, not a burst.
//
// bucketSamples is 1024 rounded UP to the engine's block boundary, so it varies
// with buffer size (441-sample blocks at 44.1 kHz give 1323). Read it; never
// assume 1024.
//
//   uint64  sampleClock       @    0
//   uint32  bucketSamples     @    8
//   uint32  flags             @   12
//   float32 inputPeakDb       @   16   (peak abs input, post LOW CUT)
//   float32 outputPeakDb      @   20   (peak abs final output)
//   float32 bandGrDb[4]       @   24   (max GR dB, positive = reduction)
//   float32 bandOutDb[4]      @   40   (peak band output level, dB)
//   float32 bandInDb[4]       @   56   (max band DETECTOR level, dB)
//   float32 lookaheadSamples  @   72
//   float32 latencySamples    @   76   (total reported = lookahead + sat OS)
//   float32 splitLoHz         @   80
//   float32 splitHiHz         @   84
//   float32 sampleRate        @   88
//   float32 spectrumBins      @   92   (valid entries in spectrum[])
//   float32 spectrum[1024]    @   96   (magnitude dB, 0 dB = full-scale sine)
//
// bandInDb[b] is the level band b's transfer curve was actually looked up with
// (post PRE GAIN, pre curve gain), carrying that band's detector ballistics —
// i.e. the X coordinate of the moving dot on the curve editor. COMP OFF reports
// the plain band peak; OFF / MUTED report -120.
//
// Band order in bandGrDb / bandOutDb / bandInDb is LOW, MID, HIGH, MASTER.
// spectrum[] is floored at -120 dB; bin i covers i * sampleRate / 2048 Hz.
export const APEX_BUCKET = Object.freeze({
  sizeBytes: 4192,
  numBands: 4,
  spectrumBins: 1024,
  fftSize: 2048,
  arrays: Object.freeze({
    bandGrDb:  { offset: 24, count: 4 },
    bandOutDb: { offset: 40, count: 4 },
    bandInDb:  { offset: 56, count: 4 },
    spectrum:  { offset: 96, count: 1024 },
  }),
  fields: Object.freeze({
    sampleClock:      { offset:  0, type: 'u64'   },
    bucketSamples:    { offset:  8, type: 'u32'   },
    flags:            { offset: 12, type: 'u32'   },
    inputPeakDb:      { offset: 16, type: 'float' },
    outputPeakDb:     { offset: 20, type: 'float' },
    lookaheadSamples: { offset: 72, type: 'float' },
    latencySamples:   { offset: 76, type: 'float' },
    splitLoHz:        { offset: 80, type: 'float' },
    splitHiHz:        { offset: 84, type: 'float' },
    sampleRate:       { offset: 88, type: 'float' },
    spectrumBins:     { offset: 92, type: 'float' },
  }),
})

// ── Defensive parser ────────────────────────────────────────────────────────
//
// parseDrainResponse(resp, expectedType) verifies the payload metadata and
// returns a parser handle:
//   { ok: true, count, view, decode(i) }  on success
//   { ok: false, reason: 'string' }       on schema/type/size mismatch
//
// The parser is zero-copy where possible: we hold the ArrayBuffer + a
// DataView and decode on demand rather than copying every bucket.
//
// `expectedType` is the VIZ_TYPE.* string the caller is willing to accept.

export function parseDrainResponse(resp, expectedType = VIZ_TYPE.COMPRESSOR) {
  if (!resp || typeof resp !== 'object') {
    return { ok: false, reason: 'no-response' }
  }
  if (resp.type !== expectedType) {
    return { ok: false, reason: `type-mismatch:${resp.type}` }
  }
  if (resp.schema !== DYNAMICS_VIZ_SCHEMA_VERSION) {
    return { ok: false, reason: `schema-mismatch:${resp.schema}` }
  }

  let expectedSize = 0
  let fields = null
  if (expectedType === VIZ_TYPE.COMPRESSOR) {
    expectedSize = COMPRESSOR_BUCKET.sizeBytes
    fields = COMPRESSOR_BUCKET.fields
  } else if (expectedType === VIZ_TYPE.LIMITER) {
    expectedSize = LIMITER_BUCKET.sizeBytes
    fields = LIMITER_BUCKET.fields
  } else if (expectedType === VIZ_TYPE.TRANSIENT) {
    expectedSize = TRANSIENT_BUCKET.sizeBytes
    fields = TRANSIENT_BUCKET.fields
  } else if (expectedType === VIZ_TYPE.MULTIBAND) {
    expectedSize = MULTIBAND_BUCKET.sizeBytes
    fields = MULTIBAND_BUCKET.fields
  } else if (expectedType === VIZ_TYPE.RESONANCE) {
    expectedSize = RESONANCE_BUCKET.sizeBytes
    fields = RESONANCE_BUCKET.fields
  } else if (expectedType === VIZ_TYPE.UNIFLANGE) {
    expectedSize = UNIFLANGE_BUCKET.sizeBytes
    fields = UNIFLANGE_BUCKET.fields
  } else if (expectedType === VIZ_TYPE.APEX) {
    expectedSize = APEX_BUCKET.sizeBytes
    fields = APEX_BUCKET.fields
  }
  if (expectedSize === 0 || fields === null) {
    return { ok: false, reason: `unsupported-type:${expectedType}` }
  }
  if (resp.bucketSize !== expectedSize) {
    return { ok: false, reason: `bucket-size-mismatch:${resp.bucketSize}` }
  }

  const ab = resp.frames
  if (!ab || typeof ab.byteLength !== 'number') {
    return { ok: false, reason: 'no-frames' }
  }

  const count = (resp.count | 0)
  if (count === 0 || ab.byteLength === 0) {
    return { ok: true, count: 0, view: null, decode: () => null }
  }
  if (ab.byteLength < count * expectedSize) {
    return { ok: false, reason: 'short-payload' }
  }

  const view = new DataView(ab)

  const littleEndian = true // x86_64 / ARM little-endian (Windows-only project)

  function decodeAt(byteOffset, fieldDescriptor) {
    if (fieldDescriptor.type === 'float')
      return view.getFloat32(byteOffset + fieldDescriptor.offset, littleEndian)
    if (fieldDescriptor.type === 'u32')
      return view.getUint32(byteOffset + fieldDescriptor.offset, littleEndian)
    if (fieldDescriptor.type === 'u64') {
      // BigUint64 is widely supported in modern Electron — safe here.
      return view.getBigUint64(byteOffset + fieldDescriptor.offset, littleEndian)
    }
    return 0
  }

  function decodeFloatArray(byteOffset, descriptor, wantedCount) {
    const n = Math.max(0, Math.min(descriptor.count, wantedCount | 0))
    const values = new Array(n)
    const arrayBase = byteOffset + descriptor.offset
    for (let i = 0; i < n; i++) {
      values[i] = view.getFloat32(arrayBase + i * 4, littleEndian)
    }
    return values
  }

  function decode(i) {
    if (i < 0 || i >= count) return null
    const base = i * expectedSize
    const out = {}
    for (const key in fields) {
      out[key] = decodeAt(base, fields[key])
    }
    if (expectedType === VIZ_TYPE.RESONANCE) {
      const declaredCount = Number.isFinite(out.bucketCount)
        ? Math.round(out.bucketCount)
        : RESONANCE_BUCKET.bucketCount
      const bucketCount = Math.max(0, Math.min(RESONANCE_BUCKET.bucketCount, declaredCount))
      out.spectrum = decodeFloatArray(base, RESONANCE_BUCKET.arrays.spectrum, bucketCount)
      out.reduction = decodeFloatArray(base, RESONANCE_BUCKET.arrays.reduction, bucketCount)
      out.weighting = decodeFloatArray(base, RESONANCE_BUCKET.arrays.weighting, bucketCount)
    }
    if (expectedType === VIZ_TYPE.APEX) {
      // Trust the struct's own declared bin count over the compile-time
      // constant, but never read past the array the layout describes.
      const declaredBins = Number.isFinite(out.spectrumBins)
        ? Math.round(out.spectrumBins)
        : APEX_BUCKET.spectrumBins
      const bins = Math.max(0, Math.min(APEX_BUCKET.spectrumBins, declaredBins))
      out.bandGrDb  = decodeFloatArray(base, APEX_BUCKET.arrays.bandGrDb,  APEX_BUCKET.numBands)
      out.bandOutDb = decodeFloatArray(base, APEX_BUCKET.arrays.bandOutDb, APEX_BUCKET.numBands)
      out.bandInDb  = decodeFloatArray(base, APEX_BUCKET.arrays.bandInDb,  APEX_BUCKET.numBands)
      out.spectrum  = decodeFloatArray(base, APEX_BUCKET.arrays.spectrum,  bins)
    }
    return out
  }

  return { ok: true, count, view, decode, fields }
}

// ── Compressor-specific source keys (manifest allow-list) ───────────────────
// Mirrors what the manifest declares; centralised so the runtime can validate
// at registration time. These are the public names accepted by visualizer
// nodes targeting the Compressor effect.

export const COMPRESSOR_VIZ_SOURCES = Object.freeze({
  LEVEL_HISTORY:           'compressor.levelHistory',
  GAIN_REDUCTION_HISTORY:  'compressor.gainReductionHistory',
  TRANSFER_CURVE:          'compressor.transferCurve',
  DETECTOR:                'compressor.detector',
  COMBINED:                'compressor.combined',
})

// ── Limiter source keys (manifest allow-list) ───────────────────────────────
// Mirrors the COMPRESSOR_VIZ_SOURCES layout. Source values land in the
// Limiter manifest's vizSources array and the runtime VisualizerNode dispatch.
export const LIMITER_VIZ_SOURCES = Object.freeze({
  REALTIME:                'limiter.realtime',
  GAIN_REDUCTION_HISTORY:  'limiter.gainReductionHistory',
  METER_ONLY:              'limiter.meterOnly',
})

// ── Transient source keys (manifest allow-list) ─────────────────────────────
// Backed by the TransientBucket viz pipeline (engine: XlethTransientProcEffect →
// DynamicsVizCollector<TransientBucket>; UI: transientPainter.js).
export const TRANSIENT_VIZ_SOURCES = Object.freeze({
  SHAPER:        'transient.shaper',
  ENVELOPE:      'transient.envelope',
  GAIN_CHANGE:   'transient.gainChange',
})

// ── Overdone (multiband) source keys (manifest allow-list) ──────────────────
// Backed by the MultibandBucket viz pipeline (engine: XlethOTTEffect →
// DynamicsVizCollector<MultibandBucket>; UI: multibandPainter.js). Source
// keys are namespaced under "overdone." so the runtime dispatch can route
// them to the multiband painter set; the underlying engine type tag is
// VIZ_TYPE.MULTIBAND.
export const OVERDONE_VIZ_SOURCES = Object.freeze({
  MULTIBAND: 'overdone.multiband',
  BANDS:     'overdone.bands',
  GR:        'overdone.gainReduction',
})

// Resonance Suppressor source keys (manifest allow-list). Backed by the
// ResonanceBucket pipeline; all sources read the same bucket and differ only
// in painter emphasis.
export const RESONANCE_VIZ_SOURCES = Object.freeze({
  COMBINED:  'resonance.combined',
  SPECTRUM:  'resonance.spectrum',
  REDUCTION: 'resonance.reduction',
  WEIGHTING: 'resonance.weighting',
})

// APEX source keys (manifest allow-list). Backed by the ApexBucket pipeline;
// every source reads the SAME bucket — the engine emits one batched payload
// per tick and the painters differ only in which slice of it they draw. Adding
// a source here must never mean adding a second drain.
export const APEX_VIZ_SOURCES = Object.freeze({
  SPECTRUM:       'apex.spectrum',
  GAIN_REDUCTION: 'apex.gainReduction',
  BAND_LEVELS:    'apex.bandLevels',
  COMBINED:       'apex.combined',
})
