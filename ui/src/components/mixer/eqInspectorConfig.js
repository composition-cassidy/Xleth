// Field descriptors for the EQ SelectedBandInspector.
// Pure data — no React, no store imports.
//
// Each entry drives one EQ inspector knob:
//   key      — matches the engine/store parameter name (e.g. 'dyn_thresh')
//   label    — compact label shown to the left of the input
//   min/max  — HTML input bounds (also used for clamp validation)
//   step     — input step attribute
//   def      — default value when the band field is absent
//   decimals — how many decimal places the value is formatted to

export const DYN_FIELDS = [
  { key: 'dyn_thresh',  label: 'Thr',   min: -60, max: 0,    step: 1,    def: -20,  decimals: 0 },
  { key: 'dyn_ratio',   label: 'Ratio', min: 1,   max: 20,   step: 0.1,  def: 4,    decimals: 1 },
  { key: 'dyn_attack',  label: 'Atk',   min: 0.1, max: 100,  step: 0.1,  def: 10,   decimals: 1 },
  { key: 'dyn_release', label: 'Rel',   min: 1,   max: 1000, step: 1,    def: 100,  decimals: 0 },
]

export const SPEC_FIELDS = [
  { key: 'spec_sens',    label: 'Sens',  min: 0,   max: 1,    step: 0.01, def: 0.5,  decimals: 2 },
  { key: 'spec_depth',   label: 'Dep',   min: -30, max: 30,   step: 0.1,  def: 0,    decimals: 1 },
  { key: 'spec_sel',     label: 'Sel',   min: 1,   max: 20,   step: 0.1,  def: 5,    decimals: 1 },
  { key: 'spec_attack',  label: 'Atk',   min: 0.1, max: 100,  step: 0.1,  def: 10,   decimals: 1 },
  { key: 'spec_release', label: 'Rel',   min: 1,   max: 1000, step: 1,    def: 100,  decimals: 0 },
]

export function getInspectorFields(mode) {
  if (mode === 1) return DYN_FIELDS
  if (mode === 2) return SPEC_FIELDS
  return []
}

export function inspectorHasGR(mode) {
  return mode === 1
}
