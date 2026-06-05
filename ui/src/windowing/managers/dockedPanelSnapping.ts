export const DOCK_SPLITTER_SNAP_THRESHOLD_PX = 8;

export interface DockSplitterSnapInput {
  rawPosition: number;
  targets: readonly number[];
  threshold?: number;
  disabled?: boolean;
}

export interface DockSplitterSnapResult {
  position: number;
  snapped: boolean;
  target: number | null;
}

export function snapDockSplitterPosition({
  rawPosition,
  targets,
  threshold = DOCK_SPLITTER_SNAP_THRESHOLD_PX,
  disabled = false,
}: DockSplitterSnapInput): DockSplitterSnapResult {
  if (disabled || !Number.isFinite(rawPosition) || threshold < 0) {
    return { position: rawPosition, snapped: false, target: null };
  }

  let bestTarget: number | null = null;
  let bestDistance = Infinity;

  for (const target of targets) {
    if (!Number.isFinite(target)) continue;
    const distance = Math.abs(rawPosition - target);
    if (distance > threshold) continue;
    if (
      distance < bestDistance
      || (distance === bestDistance && (bestTarget === null || target < bestTarget))
    ) {
      bestDistance = distance;
      bestTarget = target;
    }
  }

  if (bestTarget === null) {
    return { position: rawPosition, snapped: false, target: null };
  }

  return { position: bestTarget, snapped: true, target: bestTarget };
}
