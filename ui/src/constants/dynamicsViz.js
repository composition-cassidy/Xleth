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

export const DYNAMICS_VIZ_SCHEMA_VERSION = 1

// Type-tag strings (must match the strings the bridge emits in the drain
// response: "compressor" → kVizTypeCompressor, "unknown" → kVizTypeUnknown).
export const VIZ_TYPE = Object.freeze({
  UNKNOWN:    'unknown',
  COMPRESSOR: 'compressor',
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

  const expectedSize = expectedType === VIZ_TYPE.COMPRESSOR
    ? COMPRESSOR_BUCKET.sizeBytes
    : 0
  if (expectedSize === 0) {
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
  const fields = expectedType === VIZ_TYPE.COMPRESSOR
    ? COMPRESSOR_BUCKET.fields
    : null

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

  function decode(i) {
    if (i < 0 || i >= count) return null
    const base = i * expectedSize
    const out = {}
    for (const key in fields) {
      out[key] = decodeAt(base, fields[key])
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
