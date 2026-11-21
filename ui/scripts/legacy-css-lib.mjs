// Shared by scripts/check-legacy-css.mjs and the vitest guard. Keep dependency-free.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const UI_ROOT = path.resolve(HERE, '..');
export const BASELINE_PATH = path.join(HERE, 'legacy-css-baseline.json');

/** Lines in a file the way `wc -l` counts them (a final line without a newline still counts). */
export function countLines(text) {
  if (text.length === 0) return 0;
  const newlines = (text.match(/\n/g) || []).length;
  return text.endsWith('\n') ? newlines : newlines + 1;
}

export function readBaseline() {
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
}

/** Current line count of the frozen legacy stylesheet named in the baseline file. */
export function currentLines(baseline = readBaseline()) {
  return countLines(fs.readFileSync(path.join(UI_ROOT, baseline.file), 'utf8'));
}

/**
 * The ratchet: the stylesheet may shrink but never grow.
 * status: 'over'  -> fails (the file grew past the baseline)
 *         'under' -> passes, but the baseline can be lowered (`--update`)
 *         'equal' -> passes
 */
export function evaluate(lines, maxLines) {
  if (lines > maxLines) return { status: 'over', delta: lines - maxLines };
  if (lines < maxLines) return { status: 'under', delta: maxLines - lines };
  return { status: 'equal', delta: 0 };
}
