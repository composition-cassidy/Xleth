const GLOBAL_STRETCH_METHOD_LABELS = {
  1: 'TD-PSOLA',
  2: 'Rubber Band',
  3: 'WSOLA',
  4: 'Phase Vocoder',
  5: 'WORLD',
}

export const GLOBAL_STRETCH_METHOD_OPTIONS = [
  2,
  3,
  1,
  5,
  4,
].map(value => ({
  value,
  label: GLOBAL_STRETCH_METHOD_LABELS[value],
}))

export function sanitizeGlobalStretchMethod(value) {
  const numericValue = Number(value)
  return Number.isInteger(numericValue) && GLOBAL_STRETCH_METHOD_LABELS[numericValue]
    ? numericValue
    : 1
}

export function getGlobalStretchMethodLabel(value) {
  return GLOBAL_STRETCH_METHOD_LABELS[sanitizeGlobalStretchMethod(value)] || 'TD-PSOLA'
}
