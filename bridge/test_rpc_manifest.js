'use strict';
//
// bridge/test_rpc_manifest.js — contract test for the RPC method manifest
// (AUDIT.md S1, see docs/rpc-manifest.md).
//
// Verifies, for every method declared in ui/rpc-manifest.js:
//   1. the manifest itself is well-formed (validateManifest),
//   2. the checked-in generated registries (bridge/src/XlethRpcExports.inc,
//      engine/src/XlethRpcDispatch.inc) are not stale (generator --check),
//   3. the built addon actually exports the method (catches a build that
//      predates a manifest change — the same failure Q11's strict mode turns
//      into a hard error at runtime),
//   4. the generated path works end-to-end through the real engine:
//      timeline_setBPM → timeline_getBPM round-trip, timeline_getTempoLocked,
//      and the binary-path getFrameRGBA call.
//
// Run after rebuilding the native addon:
//   cd bridge && node test_rpc_manifest.js
//

const path = require('path');
const fs   = require('fs');
const { spawnSync } = require('child_process');

// Prepend DLL dir so FFmpeg DLLs are found on Windows
const dllDir = path.resolve(__dirname, 'build/Release');
process.env.PATH = dllDir + ';' + process.env.PATH;

const { METHODS, validateManifest } = require(path.resolve(__dirname, '../ui/rpc-manifest.js'));

let passed = 0;
let failed = 0;
let total  = 0;

function assert(condition, label) {
  total++;
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

async function main() {
  console.log('=== xleth RPC manifest contract test ===\n');

  // ── 1. Manifest invariants ────────────────────────────────────────────────
  console.log('[ manifest invariants ]');
  let valid = false;
  try { valid = validateManifest(); } catch (e) { console.error('  ' + e.message); }
  assert(valid === true, 'validateManifest() passes');

  // ── 2. Generated registries are not stale ─────────────────────────────────
  console.log('\n[ generated .inc files match the manifest ]');
  const gen = spawnSync(process.execPath,
    [path.resolve(__dirname, '../scripts/generate-rpc-registries.js'), '--check'],
    { encoding: 'utf8' });
  if (gen.status !== 0) {
    console.error((gen.stdout || '') + (gen.stderr || ''));
  }
  assert(gen.status === 0, 'generate-rpc-registries.js --check reports no drift');

  // ── 3. Every manifest method is exported by the built addon ──────────────
  console.log('\n[ addon exports every manifest method ]');
  const addon = require('./build/Release/xleth_native.node');
  for (const m of METHODS) {
    assert(typeof addon[m.method] === 'function',
      `addon exports '${m.method}' (generated XlethRpcExports.inc)`);
  }

  // ── 4. End-to-end through the generated dispatch ──────────────────────────
  console.log('\n[ generated dispatch round-trip ]');
  const ok = addon.initialize();
  assert(ok === true, 'initialize() returns true');

  const PROJECT_DIR = path.resolve(__dirname, '_test_rpc_manifest');
  if (fs.existsSync(PROJECT_DIR)) fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  const created = addon.project_create(PROJECT_DIR, 'RpcManifestTest');
  assert(created === true, 'project_create() returns true');

  addon.timeline_setBPM(137);                       // XLETH_RPC_VOID branch
  const bpm = addon.timeline_getBPM();              // XLETH_RPC_VALUE branch
  assert(bpm === 137, `timeline_setBPM(137) -> timeline_getBPM() === 137 (got ${bpm})`);

  const locked = addon.timeline_getTempoLocked();
  assert(typeof locked === 'boolean', `timeline_getTempoLocked() returns boolean (got ${typeof locked})`);

  const trackA = addon.timeline_addTrack({ name: 'A', order: 0 });
  const trackB = addon.timeline_addTrack({ name: 'B', order: 1 });
  const trackC = addon.timeline_addTrack({ name: 'C', order: 2 });
  const flatLayout = addon.timeline_getTrackLayout();
  assert(flatLayout.folders.length === 0 && flatLayout.rootOrder.length === 3,
    'timeline_getTrackLayout() synthesizes the flat root layout');

  const folderId = addon.timeline_createTrackFolder({
    name: 'Folder 1', trackIds: [trackA, trackB], rootIndex: 0,
  });
  let folderLayout = addon.timeline_getTrackLayout();
  assert(folderId > 0 && folderLayout.folders[0].trackIds.join(',') === `${trackA},${trackB}`,
    'timeline_createTrackFolder() groups members through generated dispatch');
  assert(addon.timeline_setTrackFolderName(folderId, 'Renamed') === true,
    'timeline_setTrackFolderName() dispatches');
  assert(addon.timeline_setTrackFolderCollapsed(folderId, true) === true,
    'timeline_setTrackFolderCollapsed() dispatches');

  folderLayout = addon.timeline_getTrackLayout();
  folderLayout.rootOrder = [
    { kind: 'track', id: trackC },
    { kind: 'folder', id: folderId },
  ];
  folderLayout.folders[0].trackIds = [trackB, trackA];
  assert(addon.timeline_setTrackLayout(folderLayout) === true,
    'timeline_setTrackLayout() atomically reorders root items and members');
  assert(addon.timeline_getTracks().map(track => track.id).join(',') === `${trackC},${trackB},${trackA}`,
    'folder layout flattening updates canonical track order');

  const invalidLayout = JSON.parse(JSON.stringify(folderLayout));
  invalidLayout.rootOrder.push({ kind: 'track', id: trackC });
  assert(addon.timeline_setTrackLayout(invalidLayout) === false,
    'timeline_setTrackLayout() rejects duplicate entities atomically');
  assert(addon.timeline_removeTrackFolder(folderId) === true,
    'timeline_removeTrackFolder() ungroups without deleting tracks');
  assert(addon.timeline_getTracks().length === 3 && addon.timeline_getTrackLayout().folders.length === 0,
    'folder removal retains all mixer/timeline tracks');
  addon.undo_undo();
  assert(addon.timeline_getTrackLayout().folders[0]?.id === folderId,
    'folder removal undo restores exact folder identity');
  addon.undo_redo();
  assert(addon.timeline_getTrackLayout().folders.length === 0,
    'folder removal redo ungroups again');

  // Binary frame path: no video is loaded, so we only assert the generated
  // dispatch reaches the handler and returns without throwing. The Buffer
  // transport itself stays hand-written in ui/addon-worker.js by design.
  let frameThrew = false;
  let frame;
  try { frame = addon.getFrameRGBA(); } catch (e) { frameThrew = true; console.error('  ' + e.message); }
  assert(!frameThrew, 'getFrameRGBA() dispatches without throwing (no video loaded)');
  assert(frame === null || frame === undefined || typeof frame === 'object',
    'getFrameRGBA() returns null/undefined/object');

  console.log('\n[ final shutdown ]');
  addon.shutdown();
  assert(true, 'final shutdown() completed');

  console.log('\n' + '-'.repeat(50));
  console.log(`PASSED: ${passed}/${total} tests`);
  if (failed > 0) {
    console.error(`FAILED: ${failed}/${total} tests`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('\nUnhandled error:', err);
  process.exit(1);
});
