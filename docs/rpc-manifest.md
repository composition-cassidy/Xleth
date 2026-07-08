# RPC Method Manifest — single source of truth for the RPC surface (AUDIT.md S1)

**Status:** slices 1–6 done (timeline/undo/transport, project, patterns, audio, effects —
161 methods in the manifest, incl. the `graph:` broadcast mechanism proven on effects.js).
Remaining methods migrate domain-by-domain in later passes (see "Migration plan" below).

## The problem

One engine method used to require **five hand-maintained name registries** (AUDIT.md §1.2):

1. `ui/preload.js` — wrapper: `getBPM: () => invoke('xleth:timeline:getBPM')`
2. `ui/electron-main/*.js` — channel: `ipcMain.handle('xleth:timeline:getBPM', safeHandler(() => callWorker('timeline_getBPM')))`
3. worker method string — the `'timeline_getBPM'` in that `callWorker` call
4. `bridge/src/XlethAddon.cpp` — wrapper fn + `exports.Set("timeline_getBPM", …)`
5. `engine/src/XlethEngineService.cpp` — `if (method == "timeline_getBPM") return Timeline_GetBPM(info).raw();`

Five string constants, zero compile-time checking, and (before Q11, commit `db300c0`)
a silent-null failure mode if any one is missed.

## Decision: method manifest, not generic passthrough

AUDIT.md S1 offered two options. We chose the **manifest**. Reasons specific to this codebase:

- **All 289 addon wrapper functions are provably mechanical.** Every single one is
  `return dispatchToService(info, "<name>");` — verified by regex over XlethAddon.cpp
  (289 matches, 0 non-trivial bodies). They are pure name tables and can be *generated*
  with zero behavior change. A generic `invoke('xleth:call', method, args)` passthrough
  would collapse only the preload/main layers and leave both C++ registries hand-maintained.
- **Channel names must not change.** The renderer, the smoke suite, and the phase0-compat
  double-mappings (`xleth:currentFrame` *and* `xleth:frameRGBA` → `getFrameRGBA`) all
  reference today's channel strings. The manifest *generates the identical channels*;
  a passthrough would replace them (or duplicate them behind a compat layer, which is
  the worst of both).
- **Binary paths must stay explicit.** `getFrameRGBA`/`getCurrentFrame`/`getFrameBuffer`/
  `midi_importFull` have hand-written transport handling in `ui/addon-worker.js`
  (frame Buffer send, ArrayBuffer→Buffer conversion). A generic passthrough blurs exactly
  this distinction. The manifest instead *declares* `binary: 'frame' | 'midiImport'` as
  metadata while the worker keeps its explicit branches — the manifest documents which
  methods are special; it does not genericize them.
- **Electron security posture.** Per-channel `ipcMain.handle` registration with a fixed
  handler is a narrower renderer-facing surface than one generic call channel + allowlist.
- **Double-registration is loud.** `ipcMain.handle` throws if a channel is registered
  twice, so a method accidentally left in both the manifest and a hand-written module
  fails at boot, not silently.

## What the manifest looks like

**`ui/rpc-manifest.js`** — plain CommonJS (requireable from preload, electron-main,
bridge contract tests, vitest, and the generator). One entry per engine method:

```js
{
  method:   'timeline_getBPM',                     // worker msg + addon export + engine dispatch name
  channels: ['xleth:timeline:getBPM'],             // ipcMain.handle channel(s) → this method
  api:      { 'timeline.getBPM': 'xleth:timeline:getBPM' },  // window.xleth.* wrapper(s) → channel
  handler:  'Timeline_GetBPM',                     // C++ handler symbol in XlethEngineService.cpp
  returns:  'value',                               // 'value' | 'void' (dispatch wrapper shape)
  binary:   null,                                  // null | 'frame' | 'midiImport' — stays explicit in addon-worker.js
  graph:    'track',                               // (optional) 'track' | 'master' — graph mutation, broadcasts
                                                   // xleth:graph:changed via main.js's graphHandler; absent = plain
}
```

### The `graph` field — declarative graph-changed broadcast (S1 slice 6)

The effect-chain and wire mutations (`effects.js`, later `effects-graph.js`) are pure
engine pass-throughs **plus one fixed post-call side effect**: after the worker call
resolves, main.js broadcasts `xleth:graph:changed` to every renderer (main window +
node-editor children), keyed by the track id (`trackKey = (_, trackId) => String(trackId)`,
first IPC arg) or by `'master'` (`masterKey`). Hand-written modules expressed this by
wrapping the handler in `graphHandler(keyFn, fn)` instead of `safeHandler(fn)`.

The manifest expresses it as **data**, exactly like `binary` declares the worker's
explicit binary branches without genericizing them:

- `graph: 'track' | 'master'` on an entry declares the broadcast and its key.
- `rpc-registry.js` maps the value to the canonical key function (imported from
  `electron-main/effects.js`, the same functions `effects-graph.js` shares) and
  registers the channel through main.js's `graphHandler` instead of plain `safeHandler`.
- `graphHandler`, `broadcastGraphChanged` and the key functions themselves are
  **unchanged and stay in main.js / effects.js** — the manifest only selects the wrapper
  at registration time.
- `validateManifest()` rejects any value outside `{'track', 'master'}`; absent or `null`
  means plain pass-through.
- The C++ side is untouched by the field: generated exports/dispatch lines are identical
  to a plain pass-through (the broadcast is a main-process concern only).

This is the **one sanctioned exception** to "no per-call main-process logic in the
manifest": the broadcast is a fixed, declarative side effect shared by every graph
mutation, not per-method business logic. Anything beyond it (dialogs, arg fixups,
timers, settings reads) still disqualifies an entry.

`channels` is a list because the phase0 legacy surface maps two channels to one method
(`xleth:currentFrame` + `xleth:frameRGBA`). `api` is a map because several wrapper paths
can point at the same channel (`getCurrentFrame` and `video.getFrameBuffer` both invoke
`xleth:currentFrame`).

## How each registry is produced from it

| Layer | Mechanism | Runtime or generated |
|-------|-----------|----------------------|
| preload wrappers | `attachRpcWrappers(window.xleth, invoke)` (exported by the manifest) sets each `api` path to `(...args) => invoke(channel, ...args)` | runtime |
| ipcMain channels | `ui/electron-main/rpc-registry.js` → `init({ safeHandler, graphHandler })` loops the manifest: `ipcMain.handle(channel, wrap((_evt, ...args) => callWorker(method, args)))` where `wrap` is `safeHandler`, or `graphHandler(trackKey \| masterKey, …)` when the entry declares `graph:` | runtime |
| worker method string | same `method` field, passed by the generated handler | runtime |
| addon exports | `bridge/src/XlethRpcExports.inc` — X-macro list `XLETH_RPC_EXPORT("timeline_getBPM")`, expanded in `XlethAddon.cpp::Init()` to `exports.Set(name, Function::New(env, …dispatchToService(info, name)…))` | **generated, checked in** |
| engine dispatch | `engine/src/XlethRpcDispatch.inc` — `XLETH_RPC_VALUE("timeline_getBPM", Timeline_GetBPM)` / `XLETH_RPC_VOID(…)`, expanded at the top of `XlethEngineService::dispatch()` | **generated, checked in** |

Generator: **`scripts/generate-rpc-registries.js`** (also `--check` mode that fails if the
checked-in `.inc` files are stale). The `.inc` files are committed so the C++ builds need
no CMake/Node coupling; staleness is enforced by the contract test instead.

`addon-worker.js` is untouched: it was already generic (`xleth[method](...args)`), and its
binary special cases stay hand-written by design.

## What guards it

- **`bridge/test_rpc_manifest.js`** (auto-discovered by `run_contract_tests.js`):
  validates manifest invariants (unique methods/channels, well-formed entries, binary
  methods limited to the worker's known special-case set), runs the generator in
  `--check` mode, loads the built `xleth_native.node` and asserts every manifest method
  is exported, then round-trips `timeline_setBPM(137)` → `timeline_getBPM() === 137`
  and calls `getFrameRGBA()` through the generated dispatch.
- **`ui/src/rpcManifest.test.js`** (vitest): pins the exact channel strings and API paths
  for migrated methods (regression against accidental renames) and unit-tests
  `attachRpcWrappers`.
- **Q11 strict mode**: `XLETH_STRICT_IPC=1` still turns any missing addon export into a
  thrown error at the worker — a manifest entry whose `.inc` regeneration was skipped
  fails loudly, exactly like a hand-registry typo did.
- The smoke suite's IPC round-trip (`getBPM`/`getTempoLocked`) exercises the *generated*
  path end-to-end through the real app after this slice.

## How a method is added now

1. Add **one entry** to `ui/rpc-manifest.js`.
2. Run `node scripts/generate-rpc-registries.js` (refreshes both `.inc` files).
3. Write the C++ handler in `XlethEngineService.cpp` (the `handler` symbol named in the
   entry) — this is the one genuinely non-generatable piece: the handler body is C++.
4. Rebuild the bridge.

That's one name written once, plus the handler implementation. Previously: five files,
five strings, no checking.

## Phase 1 slice (this commit)

| method | why it's in the slice |
|--------|----------------------|
| `timeline_getBPM` | simple value query; exercised by smoke test 3 |
| `timeline_getTempoLocked` | second value query; also in the smoke round-trip |
| `timeline_setBPM` | void mutation — proves the `XLETH_RPC_VOID` dispatch shape |
| `getFrameRGBA` | **binary frame path**: two legacy channels, four API wrapper paths, worker `frame` special-case — proves binary stays explicit while names come from the manifest |

Hand-written registrations for exactly these methods were removed from `preload.js`,
`electron-main/timeline.js`, `electron-main/phase0-compat.js`, `XlethAddon.cpp`, and
`XlethEngineService.cpp`. Everything else is untouched.

## Migration plan for the remaining ~292 methods

Same discipline as the S5 stages: one domain per pass, each pass = manifest entries +
delete the hand-written lines + regenerate + full suite (contract tests, vitest, smoke)
+ isolated commit. Natural units follow the `ui/electron-main/` modules:

1. **timeline.js** (rest of it) + **undo-redo.js** + **transport.js** — pure pass-throughs, no arg fixups; biggest single win
2. **project.js** — pass-throughs; keep the dialog handlers (`xleth:dialog:*`) hand-written (they own Electron dialogs, not engine calls)
3. **patterns.js** — all `timeline_*` region/syllable/pattern/note pass-throughs
4. **audio.js** — mostly pass-throughs; keep the device/diagnostics handlers that touch `runtimePaths`
5. **effects.js** ✅ (slice 6) + **effects-graph.js** — the `graphHandler`-wrapped mutations
   migrate with the `graph: 'track' | 'master'` field (see above; decided and proven on
   effects.js's 8 chain mutations). effects-graph.js's 8 wire mutations use the identical
   pattern — declare `graph:` on each, nothing new to design. Its graph-owned effect-instance
   handlers must be re-verified individually (same pass-through discipline). Excluded from
   effects.js and left hand-written there: `setEffectVisualizationEnabled` (`!!enabled`
   coercion) and `drainEffectVizFrames` (`maxBuckets|0` + binary viz payload)
6. **phase0-compat.js** (rest) — flat legacy channels incl. the `xleth:trigger` default-arg fixup (`vel ?? 1.0`): needs either a manifest `argDefaults` field or stays hand-written; the remaining binary paths (`getCurrentFrame` alias set is already done; `getFrameBuffer`) come here
7. **vst3.js / export.js / diagnostics.js / quick-launchers.js / preview-visibility.js** — heavy main-process logic (dialogs, intervals, file IO); only their pure pass-through lines migrate, the rest is *not* RPC and stays
8. **Last:** the 7 legacy alias exports (`transport_getState`, `audio_get/startAudioPerformanceCapture*`, `sync_getStats`) — fold into Q8 (kill aliases) rather than teaching the manifest about them
9. **Out of scope permanently (AUDIT.md §4.3):** the WORLD-poll and shm frame-output paths inline in main.js stay as they are pending perf re-verification

A handler with *any* per-call logic in main.js (arg fixups, progress intervals, dialogs,
settings reads) does **not** migrate — the manifest is only for pure pass-throughs.
When in doubt, leave it hand-written; the manifest must never grow a mini-DSL for
main-process business logic.

## Later (not this phase)

- Generate the engine's `.inc` for **all** methods and delete the ~300-line if-chain body
  (S2's split of XlethEngineService.cpp can then use the manifest's `handler` column as
  its seam inventory).
- Ship the manifest next to `addon-worker.js` in packaged builds and assert at worker
  startup that its hardcoded binary special-case set equals the manifest's `binary`
  entries.
- Replace the linear if-chain with a generated static lookup table if dispatch ever shows
  up in a profile (it hasn't; do not do this speculatively — §4.3).
