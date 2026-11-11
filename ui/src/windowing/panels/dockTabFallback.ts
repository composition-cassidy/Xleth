// What the Piano Roll and Sampler tabs show when nothing was chosen for them
// (ui/DESIGN.md 14, 15, round 3): a detail-dock tab never opens onto an empty
// dock while the project has something it could show. Pure functions over
// renderer state; nothing here calls the engine.

export interface PatternLike {
  id: number;
  regionId?: number | null;
}

export type PatternMap = Record<string | number, PatternLike | null | undefined>;

function sortedPatterns(allPatterns: PatternMap | null | undefined): PatternLike[] {
  return Object.values(allPatterns ?? {})
    .filter((p): p is PatternLike => !!p && Number.isInteger(p.id) && p.id >= 0)
    .sort((a, b) => a.id - b.id);
}

/**
 * The pattern the Piano Roll opens when none is open: the one last open in it
 * this session (the only place a pattern's notes are edited, so the most
 * recently edited one), else the first. Null only when the project has no
 * patterns.
 */
export function fallbackPatternId(
  allPatterns: PatternMap | null | undefined,
  lastPatternId: number | null | undefined,
): number | null {
  const list = sortedPatterns(allPatterns);
  if (list.length === 0) return null;
  if (lastPatternId != null && list.some((p) => p.id === lastPatternId)) return lastPatternId;
  return list[0].id;
}

function regionOf(allPatterns: PatternMap | null | undefined, patternId: number | null | undefined): number | null {
  if (patternId == null) return null;
  const regionId = allPatterns?.[patternId]?.regionId;
  return typeof regionId === 'number' && Number.isInteger(regionId) && regionId >= 0 ? regionId : null;
}

/**
 * The sample region the Sampler shows. Whoever opened the panel for a region
 * wins (`explicitRegionId`, from "Sampler settings" or a sample's own menu).
 * Otherwise it follows the Piano Roll: the open pattern's sampler, else the
 * last pattern that was open, else the first pattern that plays a sample.
 * Null only when no pattern in the project plays a sample.
 */
export function fallbackSamplerRegionId(
  explicitRegionId: unknown,
  allPatterns: PatternMap | null | undefined,
  openPatternId: number | null | undefined,
  lastPatternId: number | null | undefined,
): number | null {
  if (typeof explicitRegionId === 'number' && Number.isInteger(explicitRegionId) && explicitRegionId >= 0) return explicitRegionId;
  const open = regionOf(allPatterns, openPatternId);
  if (open != null) return open;
  const last = regionOf(allPatterns, lastPatternId);
  if (last != null) return last;
  for (const p of sortedPatterns(allPatterns)) {
    const r = regionOf(allPatterns, p.id);
    if (r != null) return r;
  }
  return null;
}
