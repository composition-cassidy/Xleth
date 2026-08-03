/**
 * Normalize one Ctrl+C snapshot before it replaces the timeline clipboard.
 * Clips and pattern blocks may coexist in a mixed timeline selection.
 */
export function normalizeTimelineClipboardPayloads(clips, patternBlocks) {
  return {
    clips: Array.isArray(clips) && clips.length > 0 ? clips : null,
    patternBlocks: Array.isArray(patternBlocks) && patternBlocks.length > 0
      ? patternBlocks
      : null,
  }
}
