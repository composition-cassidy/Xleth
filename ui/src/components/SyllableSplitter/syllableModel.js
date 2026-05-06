const EPSILON_SECONDS = 0.0005

export const PLACEHOLDER_KIND = 'placeholder'
export const SYLLABLE_KIND = 'syllable'

function finiteNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback
}

function clampTime(value, regionDur) {
  const t = finiteNumber(Number(value), 0)
  return Math.max(0, Math.min(regionDur, t))
}

function sanitizeMarkers(markers, regionDur) {
  return [...(markers ?? [])]
    .map(marker => clampTime(marker, regionDur))
    .filter(marker => marker > EPSILON_SECONDS && marker < regionDur - EPSILON_SECONDS)
    .sort((a, b) => a - b)
}

export function isPlaceholderSyllable(syllable) {
  if (!syllable || typeof syllable !== 'object') return false
  return syllable.kind === PLACEHOLDER_KIND || syllable.number === 0
}

export function normalizeSavedSyllables(syllables = [], regionDur = 0) {
  const dur = Math.max(EPSILON_SECONDS, finiteNumber(Number(regionDur), 0))
  return (Array.isArray(syllables) ? syllables : [])
    .filter(syllable => !isPlaceholderSyllable(syllable))
    .map((syllable, index) => {
      const startTime = clampTime(syllable?.startTime, dur)
      const endTime = clampTime(
        syllable?.endTime == null ? dur : syllable.endTime,
        dur,
      )
      return {
        kind: SYLLABLE_KIND,
        startTime,
        endTime: Math.max(startTime, endTime),
        number: index + 1,
        text: syllable?.text || '',
      }
    })
    .sort((a, b) => a.startTime - b.startTime)
    .map((syllable, index) => ({
      ...syllable,
      number: index + 1,
    }))
}

export function createInitialSplitterState(syllables = [], regionDur = 0) {
  const realSyllables = normalizeSavedSyllables(syllables, regionDur)
  if (realSyllables.length === 0) {
    return {
      markers: [],
      texts: [''],
      hasLeadingPlaceholder: false,
    }
  }

  const hasLeadingPlaceholder = realSyllables[0].startTime > EPSILON_SECONDS
  const markers = hasLeadingPlaceholder
    ? realSyllables.map(syllable => syllable.startTime)
    : realSyllables.slice(1).map(syllable => syllable.startTime)
  const texts = hasLeadingPlaceholder
    ? ['', ...realSyllables.map(syllable => syllable.text || '')]
    : realSyllables.map(syllable => syllable.text || '')

  return {
    markers: sanitizeMarkers(markers, regionDur),
    texts: texts.length > 0 ? texts : [''],
    hasLeadingPlaceholder,
  }
}

export function buildSplitterSections(markers = [], texts = [], regionDur = 0, hasLeadingPlaceholder = false) {
  const dur = Math.max(EPSILON_SECONDS, finiteNumber(Number(regionDur), 0))
  const sortedMarkers = sanitizeMarkers(markers, dur)

  if (sortedMarkers.length === 0) {
    return [{
      kind: SYLLABLE_KIND,
      label: '1',
      number: 1,
      start: 0,
      end: dur,
      text: texts[0] || '',
    }]
  }

  if (!hasLeadingPlaceholder) {
    const edges = [0, ...sortedMarkers, dur]
    return edges.slice(0, -1).map((start, index) => ({
      kind: SYLLABLE_KIND,
      label: String(index + 1),
      number: index + 1,
      start,
      end: edges[index + 1],
      text: texts[index] || '',
    }))
  }

  const sections = [{
    kind: PLACEHOLDER_KIND,
    label: '~',
    number: 0,
    start: 0,
    end: sortedMarkers[0],
    text: texts[0] || '',
  }]

  for (let i = 0; i < sortedMarkers.length; i++) {
    sections.push({
      kind: SYLLABLE_KIND,
      label: String(i + 1),
      number: i + 1,
      start: sortedMarkers[i],
      end: sortedMarkers[i + 1] ?? dur,
      text: texts[i + 1] || '',
    })
  }

  return sections
}

export function serializeSplitterSyllables(markers = [], texts = [], regionDur = 0, hasLeadingPlaceholder = false) {
  return buildSplitterSections(markers, texts, regionDur, hasLeadingPlaceholder)
    .filter(section => section.kind === SYLLABLE_KIND)
    .map((section, index) => ({
      startTime: section.start,
      endTime: section.end,
      number: index + 1,
      text: section.text || '',
    }))
}

export function getSelectableSyllables(syllables = []) {
  return (Array.isArray(syllables) ? syllables : [])
    .map((syllable, sourceIndex) => ({ syllable, sourceIndex }))
    .filter(({ syllable }) => !isPlaceholderSyllable(syllable))
    .map((entry, index) => ({
      ...entry,
      number: index + 1,
    }))
}

export function getSyllableDisplayNumber(syllables = [], sourceIndex = -1) {
  const selectable = getSelectableSyllables(syllables)
  return selectable.find(entry => entry.sourceIndex === sourceIndex)?.number ?? sourceIndex + 1
}
