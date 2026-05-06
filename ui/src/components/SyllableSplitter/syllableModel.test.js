import { describe, expect, it } from 'vitest'
import {
  buildSplitterSections,
  createInitialSplitterState,
  getSelectableSyllables,
  serializeSplitterSyllables,
} from './syllableModel.js'

describe('syllable splitter model', () => {
  it('renders a leading placeholder plus six real syllables as ~, 1, 2, 3, 4, 5, 6', () => {
    const markers = [0.12, 0.34, 0.57, 0.83, 1.1, 1.42]
    const sections = buildSplitterSections(markers, [], 1.9, true)

    expect(sections.map(section => section.label)).toEqual(['~', '1', '2', '3', '4', '5', '6'])
    expect(sections.map(section => section.kind)).toEqual([
      'placeholder',
      'syllable',
      'syllable',
      'syllable',
      'syllable',
      'syllable',
      'syllable',
    ])
  })

  it('saves only six real selectable syllables when a placeholder is present', () => {
    const markers = [0.12, 0.34, 0.57, 0.83, 1.1, 1.42]
    const texts = ['', 'LOIS', 'WHERE', 'IS', 'MY', 'RED', 'BULL']
    const saved = serializeSplitterSyllables(markers, texts, 1.9, true)
    const selectable = getSelectableSyllables(saved)

    expect(saved).toHaveLength(6)
    expect(saved.map(syllable => syllable.number)).toEqual([1, 2, 3, 4, 5, 6])
    expect(saved.some(syllable => syllable.number === 0)).toBe(false)
    expect(selectable.map(entry => entry.number)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('reopens saved split data without shifting numbering', () => {
    const markers = [0.12, 0.34, 0.57, 0.83, 1.1, 1.42]
    const texts = ['', 'LOIS', 'WHERE', 'IS', 'MY', 'RED', 'BULL']
    const saved = serializeSplitterSyllables(markers, texts, 1.9, true)
    const reopened = createInitialSplitterState(saved, 1.9)
    const sections = buildSplitterSections(
      reopened.markers,
      reopened.texts,
      1.9,
      reopened.hasLeadingPlaceholder,
    )

    expect(reopened.markers).toEqual(markers)
    expect(sections.map(section => section.label)).toEqual(['~', '1', '2', '3', '4', '5', '6'])
    expect(serializeSplitterSyllables(
      reopened.markers,
      reopened.texts,
      1.9,
      reopened.hasLeadingPlaceholder,
    ).map(syllable => syllable.number)).toEqual([1, 2, 3, 4, 5, 6])
  })
})
