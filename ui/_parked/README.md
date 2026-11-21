# _parked

Code that is kept but not part of the app. This folder is outside `src/` (so vite, vitest, eslint and stylelint never see it)
and `.gitignore` here ignores everything but this file, so the contents exist **on this machine only**. Git history is the backup.

## plugin-ui-designer/

The Plugin UI Designer (round 2 step 21, `DESIGNER_DECISION = PRESERVE`). Nothing in the app imported it: its only entry point was the
`VITE_XLETH_PLUGIN_UI_DESIGNER` build flag behind the `dev:designer` / `build:designer` / `start:designer` npm scripts, which are removed.

- `designer/` is the former `ui/src/plugin-ui/designer/` (52 files, about 12,500 lines, including `styles/designer.css`).
- `runtime-tests/` holds the describe blocks that were cut out of four runtime tests because they exercised Designer helpers
  (`getVizSourceOptions`, `inspectorHelpers`, `AppearanceFields`). They keep their original relative imports, so they resolve again
  when restored next to `src/plugin-ui/runtime/__tests__/`.
- The plugin-ui **runtime** (`src/plugin-ui/runtime`, `schema`, `manifests`, `layouts`, `appearance`) stays in `src/`: the devices import 17 of its files.
  `validationStatus.js` (the hard / soft error classification the schema tests use) now lives in `src/plugin-ui/schema/`; the parked copy is unchanged.

### Restore

Last commit that contained the designer in `src/plugin-ui/designer/`: `21c966e19b58bce58a3312c6ac2d40680b8f1140`.

```bash
git checkout 21c966e -- ui/src/plugin-ui/designer          # the folder
git show 21c966e:ui/package.json                           # the three designer npm scripts
```
Then put `runtime-tests/*.designer.test.jsx` back beside the runtime tests they were cut from, and re-add the three scripts.
