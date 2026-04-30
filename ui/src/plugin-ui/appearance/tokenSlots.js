// Closed symbolic token slots for plugin UI appearance data.
// Layout JSON stores token ids such as "accent.primary"; CSS variables stay here.

export const TOKEN_SLOTS = {
  'surface.panel': {
    group: 'surface',
    label: 'Panel Surface',
    cssVar: '--theme-bg-primary',
  },
  'surface.control': {
    group: 'surface',
    label: 'Control Surface',
    cssVar: '--theme-bg-surface',
  },
  'surface.controlRaised': {
    group: 'surface',
    label: 'Raised Control',
    cssVar: '--theme-bg-elevated',
  },
  'surface.inset': {
    group: 'surface',
    label: 'Inset Surface',
    cssVar: '--theme-bg-inset',
  },

  'text.primary': {
    group: 'text',
    label: 'Primary Text',
    cssVar: '--theme-text',
  },
  'text.muted': {
    group: 'text',
    label: 'Muted Text',
    cssVar: '--theme-text-muted',
  },
  'text.subtle': {
    group: 'text',
    label: 'Subtle Text',
    cssVar: '--theme-text-subtle',
  },

  'accent.primary': {
    group: 'accent',
    label: 'Accent Primary',
    cssVar: '--theme-accent',
  },
  'accent.secondary': {
    group: 'accent',
    label: 'Accent Secondary',
    cssVar: '--theme-accent-hover',
  },
  'accent.focus': {
    group: 'accent',
    label: 'Focus Accent',
    cssVar: '--theme-border-focus',
  },

  'meter.good': {
    group: 'meter',
    label: 'Meter Good',
    cssVar: '--theme-success',
  },
  'meter.warn': {
    group: 'meter',
    label: 'Meter Warning',
    cssVar: '--theme-warning',
  },
  'meter.danger': {
    group: 'meter',
    label: 'Meter Danger',
    cssVar: '--theme-danger',
  },
  'meter.gr': {
    group: 'meter',
    label: 'Gain Reduction',
    cssVar: '--theme-dyn-gr-meter-fg',
  },
}

export const TOKEN_SLOT_GROUPS = Object.freeze({
  surface: Object.freeze(Object.keys(TOKEN_SLOTS).filter(tokenId => TOKEN_SLOTS[tokenId].group === 'surface')),
  text: Object.freeze(Object.keys(TOKEN_SLOTS).filter(tokenId => TOKEN_SLOTS[tokenId].group === 'text')),
  accent: Object.freeze(Object.keys(TOKEN_SLOTS).filter(tokenId => TOKEN_SLOTS[tokenId].group === 'accent')),
  meter: Object.freeze(Object.keys(TOKEN_SLOTS).filter(tokenId => TOKEN_SLOTS[tokenId].group === 'meter')),
})

export function getTokenSlot(tokenId) {
  return typeof tokenId === 'string' ? TOKEN_SLOTS[tokenId] || null : null
}

export function isKnownTokenId(tokenId) {
  return !!getTokenSlot(tokenId)
}

export function isTokenInGroup(tokenId, groupName) {
  const slot = getTokenSlot(tokenId)
  return !!slot && slot.group === groupName
}

export function getTokenOptionsForGroup(groupName) {
  return (TOKEN_SLOT_GROUPS[groupName] || []).map(tokenId => ({
    value: tokenId,
    label: TOKEN_SLOTS[tokenId].label,
    cssVar: TOKEN_SLOTS[tokenId].cssVar,
  }))
}

export function resolveTokenCssVar(tokenId, fallbackTokenId) {
  const slot = getTokenSlot(tokenId)
  if (slot) return slot.cssVar

  const fallbackSlot = getTokenSlot(fallbackTokenId)
  return fallbackSlot ? fallbackSlot.cssVar : null
}

// ── Pseudo-tokens for decoration slots ────────────────────────────────────────
// These are sentinel values meaning "no fill / no stroke / no tint".
// cssVar is null — runtime components omit the style property when null.

export const PSEUDO_TOKENS = Object.freeze({
  'fill.none':   { group: 'none', label: 'No Fill',   cssVar: null },
  'stroke.none': { group: 'none', label: 'No Stroke', cssVar: null },
  'tint.none':   { group: 'none', label: 'No Tint',   cssVar: null },
})

export function isPseudoToken(tokenId) {
  return Object.prototype.hasOwnProperty.call(PSEUDO_TOKENS, tokenId)
}

// ── Compound slot groups for decoration nodes ──────────────────────────────────
// fill:   surface.*, accent.*, fill.none
// stroke: accent.*, text.*, meter.*, stroke.none
// tint:   accent.*, text.*, tint.none

export const COMPOUND_SLOT_GROUPS = Object.freeze({
  // Mirror standard groups so isTokenInSlotGroup works for simple group names too
  surface: TOKEN_SLOT_GROUPS.surface,
  text:    TOKEN_SLOT_GROUPS.text,
  accent:  TOKEN_SLOT_GROUPS.accent,
  meter:   TOKEN_SLOT_GROUPS.meter,
  // Compound groups for decoration slots
  fill: Object.freeze([
    ...TOKEN_SLOT_GROUPS.surface,
    ...TOKEN_SLOT_GROUPS.accent,
    'fill.none',
  ]),
  stroke: Object.freeze([
    ...TOKEN_SLOT_GROUPS.accent,
    ...TOKEN_SLOT_GROUPS.text,
    ...TOKEN_SLOT_GROUPS.meter,
    'stroke.none',
  ]),
  tint: Object.freeze([
    ...TOKEN_SLOT_GROUPS.accent,
    ...TOKEN_SLOT_GROUPS.text,
    'tint.none',
  ]),
})

export function isTokenInSlotGroup(tokenId, slotGroupName) {
  const group = COMPOUND_SLOT_GROUPS[slotGroupName]
  return !!group && group.includes(tokenId)
}

export function isKnownTokenOrPseudo(tokenId) {
  return isKnownTokenId(tokenId) || isPseudoToken(tokenId)
}

export function resolveTokenOrPseudoCssVar(tokenId) {
  if (isPseudoToken(tokenId)) return null
  return resolveTokenCssVar(tokenId)
}
