// Placeholder decal asset — used when a decal assetId cannot be resolved.
// Freeform-A ships with this sentinel only; the real decal registry comes in Freeform-D.

export const PLACEHOLDER_DECAL_ID = 'builtin.placeholder.missing'

export const PLACEHOLDER_DECAL = Object.freeze({
  id:       PLACEHOLDER_DECAL_ID,
  label:    'Missing Asset (Placeholder)',
  tintable: false,
  widthPx:  64,
  heightPx: 64,
})
