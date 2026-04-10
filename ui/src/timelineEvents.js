/**
 * Shared event bus for timeline data mutations.
 * Dispatch after any write that changes regions or sources so listeners
 * can re-fetch without polling.
 *
 * Events:
 *   'timeline-regions-changed'  — region added / modified / removed
 *   'timeline-sources-changed'  — source imported / removed
 *   'timeline-patterns-changed' — pattern added / updated / removed
 *   'timeline-pattern-blocks-changed' — pattern block added / moved / removed
 *   'timeline-pattern-changed'  — individual pattern notes/settings mutated (detail: { patternId })
 *   'open-piano-roll'           — request to open piano roll (detail: { patternId, blockId })
 *   'close-piano-roll'          — request to close piano roll
 *   'open-sampler-settings'     — request to open sampler panel (detail: { patternId })
 *   'close-sampler-settings'    — request to close sampler panel
 *   'piano-roll-detach'         — request to detach piano roll into a floating panel
 *   'piano-roll-dock'           — request to dock floating piano roll back into its tab
 */
export const timelineEvents = new EventTarget()
