// `npm run check:legacy-css`: fail if the frozen legacy stylesheet (src/styles/app.css)
// has MORE lines than scripts/legacy-css-baseline.json allows.
//
// The baseline only ever goes down. After deleting legacy rules run
//   npm run check:legacy-css -- --update
// to lower it to the new count. `--update` refuses to raise it: if you need
// more lines, the new styles belong in ui-kit/ (ui/DESIGN.md section 2).

import fs from 'node:fs';
import { BASELINE_PATH, currentLines, evaluate, readBaseline } from './legacy-css-lib.mjs';

const update = process.argv.includes('--update');
const baseline = readBaseline();
const lines = currentLines(baseline);
const { status, delta } = evaluate(lines, baseline.maxLines);

console.log(`[UIKit] ${baseline.file}: ${lines} lines (baseline ${baseline.maxLines})`);

if (status === 'over') {
  console.error(
    `[UIKit] FAIL: ${baseline.file} grew by ${delta} line(s). Legacy CSS is frozen: put new styles in ui/src/ui-kit/ ` +
      'and delete the legacy rule they replace (see ui/DESIGN.md section 2).',
  );
  process.exit(1);
}

if (status === 'under') {
  if (update) {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify({ ...baseline, maxLines: lines }, null, 2) + '\n');
    console.log(`[UIKit] baseline lowered ${baseline.maxLines} -> ${lines} (-${delta}). Commit scripts/legacy-css-baseline.json.`);
  } else {
    console.log(`[UIKit] ${delta} line(s) below the baseline: run \`npm run check:legacy-css -- --update\` and commit it.`);
  }
}
