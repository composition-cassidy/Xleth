/**
 * The output pearl's rules (FL Studio style), as pure functions so the four places that use a
 * pearl (track headers, mixer strips, sampler slots, Sandbox layers) behave identically.
 *
 *   - Lit = heard. Click turns this one on or off.
 *   - Right-click (or Shift+click, or S on the keyboard) solos it: it is turned on and every other
 *     one is turned off.
 *   - Right-click the only lit one: everything is turned back on.
 *
 * The rules work on the mute flags. Older projects may also carry the engine's separate solo flag;
 * any pearl action folds that into the mute flags and clears it, so what is lit is always what is
 * heard.
 */
export interface PearlItem<Id> {
  id: Id;
  muted: boolean;
  soloed?: boolean;
}

export interface PearlChange<Id> {
  id: Id;
  /** New mute flag, when it changes. */
  muted?: boolean;
  /** True when the item's legacy solo flag must be cleared. */
  clearSolo?: boolean;
}

/** Whether an item is heard, honouring a legacy solo flag if any item still has one. */
export function isHeard<Id>(item: PearlItem<Id>, items: ReadonlyArray<PearlItem<Id>>): boolean {
  const anySoloed = items.some((i) => i.soloed);
  return anySoloed ? !!item.soloed && !item.muted : !item.muted;
}

export function pearlPlan<Id>(
  items: ReadonlyArray<PearlItem<Id>>,
  targetId: Id,
  action: 'toggle' | 'solo',
): PearlChange<Id>[] {
  const heard = new Map(items.map((i) => [i.id, isHeard(i, items)] as const));
  const next = new Map(items.map((i) => [i.id, !heard.get(i.id)] as const)); // muted = not heard
  if (!items.some((i) => i.id === targetId)) return [];

  if (action === 'toggle') {
    next.set(targetId, !!heard.get(targetId));
  } else {
    const lit = items.filter((i) => heard.get(i.id)).map((i) => i.id);
    const onlyThis = lit.length === 1 && lit[0] === targetId;
    for (const i of items) next.set(i.id, onlyThis ? false : i.id !== targetId);
  }

  const out: PearlChange<Id>[] = [];
  for (const i of items) {
    const c: PearlChange<Id> = { id: i.id };
    if (next.get(i.id) !== !!i.muted) c.muted = next.get(i.id);
    if (i.soloed) c.clearSolo = true;
    if (c.muted !== undefined || c.clearSolo) out.push(c);
  }
  return out;
}

/** The hint every pearl shows. */
export const PEARL_HINT = 'Output: click to turn on or off';
export const PEARL_HINT_MODS = 'Right-click (or Shift+click, S): solo · Right-click the only lit one: everything back on';
