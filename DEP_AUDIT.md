# Xleth Dependency Audit — 2026-04-28

## Summary
- Total npm deps: 19 (12 dependencies + 7 devDependencies + 0 optionalDependencies)
  - `ui/`: 6 dependencies + 7 devDependencies = 13
  - `bridge/`: 2 dependencies = 2
  - `shm_helper/`: 2 dependencies = 2
  - `scripts/`: 2 dependencies = 2
  - There is **no root `package.json`** — Xleth is structured as 4 sibling npm packages, not a workspace monorepo.
- SAFE TO REMOVE: 0
- NEEDS REVIEW: 3 (undeclared transitive dependencies that audit/build scripts rely on by name)
- KEEP (false-positive risk): 19 (all declared deps are used; classification given for completeness)
- electron-builder config issues: 5 (missing runtime files in `files` array; no native artifacts packaged)

Note: previous Codex incident lost the build by aggressive removal — this audit deliberately keeps anything that could plausibly be load-bearing. Every declared dep here has *direct evidence of use*. The risk this audit found is the **opposite** problem: scripts that depend on packages which are only present transitively.

---

## SAFE TO REMOVE

*(none)*

Every declared dependency in every workspace shows direct evidence of use — either an `import`/`require` reference in source, an invocation in an npm script, or a load by a config file. There is nothing in any of the four `package.json` files that I can prove is unused.

---

## NEEDS REVIEW

These are not removal candidates — they are **missing declarations** discovered during the audit. The build currently works only because `npm install` happens to hoist these into a location where `require.resolve` finds them. A future `npm install` on a different lockfile or Node version could silently break audit tooling.

### `@babel/parser` (used by `scripts/`, declared nowhere)
- Why ambiguous: `scripts/theming-audit.js:27` does `resolveDep('@babel/parser')` with `paths: [SCRIPTS_NODE_MODULES, UI_NODE_MODULES]`. It is only present because `@vitejs/plugin-react` pulls it transitively into `ui/node_modules/@babel/parser` (confirmed by `ls ui/node_modules/@babel/`).
- Question to resolve before removing: should `@babel/parser` be added explicitly to `scripts/package.json` so the theming audit doesn't silently break if `@vitejs/plugin-react`'s transitive graph changes?

### `@babel/traverse` (used by `scripts/`, declared nowhere)
- Why ambiguous: `scripts/theming-audit.js:28` does `resolveDep('@babel/traverse')` from the same hoisted location. Same transitive source as `@babel/parser`.
- Question to resolve before removing: same as above — promote to explicit `scripts/` dep, or accept the silent coupling to `@vitejs/plugin-react`?

### `esbuild` (used by `scripts/`, declared nowhere)
- Why ambiguous: `scripts/theming-audit-enrich-v2.js:100`, `scripts/theming-default-snapshot.js:32`, `scripts/theming-catalog-verify.js:55`, `scripts/theming-audit-enrich.js:50`, `scripts/theming-medium-sample.js:20` all spawn `node -e "require('esbuild').buildSync(...)"`. esbuild is present at `ui/node_modules/.bin/esbuild` because `vite` depends on it. The require resolves from a child-process `cwd`, which is more fragile than `require.resolve` with `paths:`.
- Question to resolve before removing: should `esbuild` be declared in `scripts/package.json` and the `node -e` calls invoked with an explicit cwd? Right now these scripts will only work if invoked from a directory where `node` happens to find `esbuild` — which is currently only true because of an undeclared install layout.

---

## KEEP — false-positive risk

All entries below have direct evidence of use. The "Reason kept" line is the explicit evidence so a reviewer doesn't need to re-derive it.

### `ui/` dependencies

#### `@fontsource/hanken-grotesk` @ ^5.2.8
- Reason kept: Imported in `ui/src/main.jsx:8-12` (5 weights, .css side-effect imports). Without these the app loads with no font assets.

#### `@xyflow/react` @ ^12.10.2
- Reason kept: Imported in `ui/src/components/mixer/NodeEditor.jsx` and `ui/src/NodeEditorWindow.jsx` (the secondary BrowserWindow opened by `?view=node-editor`).

#### `lucide-react` @ ^1.7.0
- Reason kept: Used across 46 source files (icon library). Confirmed by grep.

#### `react` @ ^18.3.1
- Reason kept: `ui/src/main.jsx:1` imports React; whole app is React-based.

#### `react-dom` @ ^18.3.1
- Reason kept: `ui/src/main.jsx:2` imports `react-dom/client` for `createRoot`. Used in 11 files including the test harness.

#### `zustand` @ ^5.0.12
- Reason kept: Used in 26 store files under `ui/src/stores/` and other consumers (e.g. `useGridEditStore.js`, `usePianoRollStore.js`). State management foundation.

### `ui/` devDependencies

#### `@playwright/test` @ ^1.59.1
- Reason kept: Imported in `ui/tests/baseline/capture.spec.ts:23-24` (`test`, `expect`, `_electron`, `ElectronApplication`, `Page`); driver for `npm run baseline:capture` / `baseline:check`. Loaded by name in `ui/playwright.config.ts:1`.

#### `@vitejs/plugin-react` @ ^4.3.4
- Reason kept: Loaded by config in `ui/vite.config.js:2,5` (`react()` plugin call). Without it, JSX is not transformed and the build produces a broken bundle. Also the transitive source of `@babel/*` that the scripts/ audit tooling depends on (see NEEDS REVIEW).

#### `concurrently` @ ^9.0.0
- Reason kept: Invoked from `ui/package.json` `dev` script: `concurrently --kill-others "vite" "wait-on ..."`. Binary present at `ui/node_modules/.bin/concurrently`.

#### `electron` @ ^41.0.0
- Reason kept: Invoked from `dev` and `start` npm scripts. `ui/main.js:3,292,432,457`, `ui/preload.js:3` `require('electron')`. Also referenced as a runtime by `bridge/package.json` and `shm_helper/package.json` `cmake-js` config (`runtime: "electron", runtimeVersion: "41.1.1"`).

#### `vite` @ ^6.0.0
- Reason kept: Invoked from `build`, `dev`, `baseline:build` npm scripts. `ui/vite.config.js:1` `defineConfig` import.

#### `vitest` @ ^2.0.0
- Reason kept: Invoked from `test`, `test:watch` npm scripts. `ui/vitest.config.ts:1` `defineConfig` import.

#### `wait-on` @ ^8.0.0
- Reason kept: Invoked from `dev` npm script: `wait-on http://localhost:5173 && electron .`. Binary present at `ui/node_modules/.bin/wait-on`.

### `bridge/` dependencies

#### `cmake-js` @ ^7.0.0
- Reason kept: Invoked from `build` and `rebuild` npm scripts (`cmake-js compile`, `cmake-js rebuild`). The `cmake-js` config block in `bridge/package.json:14-18` is also read by it (Electron 41.1.1 / x64).

#### `node-addon-api` @ ^8.0.0
- Reason kept: `bridge/CMakeLists.txt:79-83` resolves its include path via `node -p "require('node-addon-api').include"`. `bridge/src/XlethAddon.cpp:19` `#include <napi.h>` (the C++ wrapper this package provides). Native module — load is implicit through the .node file at build time.

### `shm_helper/` dependencies

#### `cmake-js` @ ^7.0.0
- Reason kept: Invoked from `build` and `rebuild` npm scripts in `shm_helper/package.json`. Same role as in `bridge/`.

#### `node-addon-api` @ ^8.0.0
- Reason kept: Required to build `shm_helper.cpp` (Windows file-mapping helper). Loaded at runtime by `ui/preload.js:18-21` via `require(shmPath)` — the resulting `.node` is the artifact, but its build-time dep is this package. Native module — keep regardless of static evidence.

### `scripts/` dependencies

#### `css-tree` @ ^3.1.0
- Reason kept: `scripts/theming-audit.js` references it (file in grep hits). The theming audit run via `npm run audit:theming`.

#### `fast-glob` @ ^3.3.2
- Reason kept: `scripts/theming-audit.js:30` `resolveDep('fast-glob')` — used to walk `ui/src/**` during the theming inventory.

---

## electron-builder config findings

Config file: `ui/electron-builder.json`. Current contents:

```json
{
  "appId": "com.xleth.app",
  "productName": "XLETH",
  "files": ["dist/**/*", "main.js", "preload.js"],
  "directories": { "output": "release" },
  "win": { "target": "nsis" }
}
```

There is no `extraResources`, `extraFiles`, `asarUnpack`, `afterPack`, or `afterSign` block. For an Electron 41 app that fork-spawns a separate Node worker and loads two native `.node` modules plus FFmpeg/GLEW DLLs and a JUCE-built engine, this config is **almost certainly insufficient for a working production NSIS build**. The dev workflow (`npm run dev`, `npm start`) loads everything from the project tree by relative path, which masks these gaps.

### `asarUnpack` patterns matching nothing on disk
- none (the field is not declared at all)

### `extraResources` / `extraFiles` pointing to missing paths
- none (the fields are not declared at all). However, these fields **should** exist and currently do not — see "files patterns that exclude something needed at runtime" below.

### `files` patterns that exclude something needed at runtime

Each of these is referenced by the running app from `__dirname` at `ui/`, so they need to be either in `files` (for asar inclusion) or in `extraResources`/`extraFiles` (for unpacked sibling files). The current config includes none of them:

1. **`ui/addon-worker.js`** — `ui/main.js:125` does `path.join(__dirname, 'addon-worker.js')` and forks it. Production builds will throw `MODULE_NOT_FOUND` at startup.
2. **`bridge/build/Release/xleth_native.node`** — `ui/addon-worker.js:42-43` does `path.resolve(__dirname, '../bridge/build/Release/xleth_native.node')` and `require()`s it. The whole engine bridge is unreachable in a packaged build.
3. **`bridge/build/Release/*.dll`** (FFmpeg/JUCE DLLs sitting next to the .node) — `ui/addon-worker.js:38-40` prepends this directory to `PATH` so the DLLs resolve. Not packaged.
4. **`shm_helper/build/Release/shm_helper.node`** — `ui/preload.js:18` does `path.resolve(__dirname, '../shm_helper/build/Release/shm_helper.node')` and `require()`s it. The zero-copy frame path collapses without it.
5. **`build/vcpkg_installed/x64-windows/bin/`** — `ui/addon-worker.js:39-40` prepends this to `PATH` for vcpkg-installed DLLs (FFmpeg/GLEW/etc). Not packaged.

These are **packaging gaps, not unused-dep findings**. The fix is to add `extraResources`/`extraFiles` entries and adjust the `__dirname`-relative paths in the JS for production (or use `app.getAppPath()` / `process.resourcesPath`). I am **not** proposing the change here — flagging only. Verifying that any of the above is actually a problem requires running `electron-builder` and inspecting `release/` output, which is outside this read-only audit.

---

## Verification

- `DEP_AUDIT.md` exists at the repo root with the structure above.
- All evidence cited is grep-derived from source (file paths and line numbers given).
- No mutating package-manager command was run. `package-lock.json` files were not touched.
- `git status` will show `DEP_AUDIT.md` as the only new file from this run.
