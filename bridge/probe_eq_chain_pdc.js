'use strict';
//
// bridge/probe_eq_chain_pdc.js - [RSBaseline]/[PDCNotify] EQ chain-PDC runtime probe
//
// Resonance-suppressor rewrite, phase P0, Step 3
// (docs/RESONANCE_SUPPRESSOR_AUDIT.md section 3.1, "EQ - LIKELY broken PDC
// propagation"), extended for the latency-changed notification fix.
//
// Question: does switching an EQ band to Spectral through the SAME path the UI
// uses - eqStore.setBandParam -> window.xleth.audio.eqSetBandParam ->
// addon.audio_eqSetBandParam -> Audio_EQ_SetBandParam -> XlethParametricEQ::
// setBandParam -> refreshLatencySamples() -> setLatencySamples() - update the
// latency the MIXER uses for inter-track PDC? Same for the global-param RPC
// (audio_eqSetGlobalParam -> eq->setParameterValue: linphase, oversample).
//
// Two different numbers matter and they are NOT the same thing:
//   effect latency   audio_getEffectLatency -> XlethEffectBase::getLatencySamples()
//                    - the processor's own, always-current figure. It CANNOT
//                    tell a stale chain from a fresh one.
//   chain latency    AudioGraph::outputLatencySamples_, written ONLY by
//                    computePDC(); the audio thread reads it every block
//                    (MixEngine ~7021) to size each track's compensation delay.
//                    The bridge exposes it through telemetry
//                    maxAudibleTrackLatencySamples and transport_getState()
//                    livePresentationMaxTrackLatencySamples. Both are
//                    recomputed live-on-read from MixEngine::
//                    getLatencyCompensationSnapshot(), which reads the cached
//                    chain value and does NOT call computePDC itself, so a read
//                    cannot heal a stale value. With ONE audible track, that max
//                    IS this track's chain (insert) latency.
//
// Before the fix (c4d3e5f, VERDICT=CONFIRMED): the RPC moved the effect latency
// 0 -> 4096 and the chain stayed 0 (and stayed 4096 after Spectral off).
// After the fix: XlethEffectBase::setLatencySamples raises the owning graph's
// LatencyChangeSignal; MixEngine's applier thread recomputes PDC on its next
// pass (~10 ms). The chain must therefore reach the effect latency within the
// poll window below, with NO unrelated graph edit and NO explicit refresh.
//
// Sequence (all on one track, one EQ insert, one band):
//   C  control, generic owner path (audio_setEffectParameter "b0_mode"): proves
//      the chain read DOES move when PDC is recomputed (inline, immediately).
//   R  the UI band path (audio_eqSetBandParam ... 'mode' 2, then 0).
//   G  the UI global path (audio_eqSetGlobalParam 'linphase' 1/0, 'oversample' 1/0).
//
// Exit: 0 = PASS, 1 = FAIL, 0 + VERDICT=BLOCKED when there is no audio device.
// Deliberately not named test_*.js, so bridge/run_contract_tests.js (which globs
// test_*.js) does not adopt a device-dependent script into the contract suite.
//
//   node bridge/probe_eq_chain_pdc.js
//

const fs = require('fs');
const os = require('os');
const path = require('path');

const P = '[PDCNotify]';
const log = (...a) => console.log(P, ...a);

const repoRoot = path.resolve(__dirname, '..');
const dllDirs = [
  path.join(__dirname, 'build', 'Release'),
  path.join(repoRoot, 'build', 'vcpkg_installed', 'x64-windows', 'bin'),
  path.join(repoRoot, 'build', 'engine', 'Release'),
].filter((d) => fs.existsSync(d));
process.env.PATH = dllDirs.join(';') + ';' + process.env.PATH;
process.env.XLETH_BRIDGE_DISABLE_PREVIEW_GPU = '1';

let addon;
try {
  addon = require('./build/Release/xleth_native.node');
} catch (err) {
  log(`VERDICT=BLOCKED reason="cannot load bridge/build/Release/xleth_native.node: ${err.message}"`);
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const asObj = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const nodeIdOf = (raw) => {
  const o = asObj(raw);
  if (o && typeof o === 'object') return o.nodeId;
  if (typeof o === 'number') return o;
  return -1;
};

// The applier thread services pending changes every ~10 ms (15.6 ms Windows
// timer granularity); 1 s is generous headroom, not an expected wait.
const HEAL_TIMEOUT_MS = 1000;
const POLL_MS = 5;

function readAll(label, trackId, nodeId, quiet = false) {
  const eff = asObj(addon.audio_getEffectLatency(trackId, nodeId));
  const tel = addon.audio_getAudioPerformanceTelemetry();
  const tr = addon.transport_getState();
  const row = {
    label,
    effectLatency: eff.latencySamples,
    chainTelemetry: tel.maxAudibleTrackLatencySamples,
    chainTransport: tr.livePresentationMaxTrackLatencySamples,
  };
  if (!quiet) {
    log(`read  ${label.padEnd(40)} effect=${String(row.effectLatency).padStart(5)}  `
      + `chain(telemetry)=${String(row.chainTelemetry).padStart(5)}  `
      + `chain(transport)=${String(row.chainTransport).padStart(5)}`
      + (row.healMs !== undefined ? `  healedAfter=${row.healMs}ms` : ''));
  }
  return row;
}

// Poll until BOTH chain reads equal the effect latency, or time out.
async function readHealed(label, trackId, nodeId) {
  const t0 = Date.now();
  let row = readAll(label, trackId, nodeId, true);
  while (!(row.chainTelemetry === row.effectLatency && row.chainTransport === row.effectLatency)
         && Date.now() - t0 < HEAL_TIMEOUT_MS) {
    await sleep(POLL_MS);
    row = readAll(label, trackId, nodeId, true);
  }
  row.healMs = Date.now() - t0;
  row.healed = row.chainTelemetry === row.effectLatency && row.chainTransport === row.effectLatency;
  readAll(label, trackId, nodeId); // print the final state
  log(`      ${label}: ${row.healed ? 'healed' : 'STILL STALE'} after ${row.healMs} ms`);
  return row;
}

const results = [];
function expect(cond, what) {
  results.push({ ok: !!cond, what });
  log(`${cond ? 'PASS' : 'FAIL'}  ${what}`);
}

(async () => {
  log('=== EQ chain-PDC probe (RPC paths vs generic owner path) ===');

  for (const fn of ['initialize', 'project_create', 'timeline_addTrack', 'audio_addEffect', 'audio_eqAddBand',
                    'audio_eqSetBandParam', 'audio_eqSetGlobalParam', 'audio_setEffectParameter',
                    'audio_getEffectLatency', 'audio_getAudioPerformanceTelemetry', 'transport_getState']) {
    if (typeof addon[fn] !== 'function') {
      log(`VERDICT=BLOCKED reason="addon.${fn} is not exported; missing API: ${fn}"`);
      process.exit(0);
    }
  }

  try {
    if (addon.initialize() !== true) throw new Error('initialize() returned falsy');
  } catch (err) {
    log(`VERDICT=BLOCKED reason="engine init failed (needs an audio device): ${err.message}"`);
    process.exit(0);
  }

  const projDir = path.join(os.tmpdir(), '_xleth_pdcnotify_eq_pdc');
  fs.rmSync(projDir, { recursive: true, force: true });
  addon.project_create(projDir, 'PdcNotifyEqPdc');
  addon.setBPM(120);

  const trackId = addon.timeline_addTrack({ name: 'EqLatent', volume: 1.0, order: 0 });
  const nodeId = nodeIdOf(addon.audio_addEffect(trackId, 'xletheq', 0));
  const band = addon.audio_eqAddBand(trackId, nodeId);
  log(`setup trackId=${trackId} nodeId=${nodeId} bandIndex=${band}`);
  if (!(trackId >= 0) || !(nodeId >= 0) || band !== 0) {
    log('VERDICT=BLOCKED reason="could not create track + EQ insert + band 0"');
    process.exit(0);
  }

  const rows = {};
  rows.C0 = readAll('C0 baseline', trackId, nodeId);
  expect(rows.C0.effectLatency === 0 && rows.C0.chainTelemetry === 0 && rows.C0.chainTransport === 0,
    'C0 baseline effect and chain latency are 0');

  // ── Control: generic owner path, recomputes inline (no wait).
  addon.audio_setEffectParameter(trackId, nodeId, 'b0_mode', 2);
  rows.C1 = readAll('C1 generic path b0_mode=2 (immediate)', trackId, nodeId);
  expect(rows.C1.effectLatency === 4096 && rows.C1.chainTelemetry === 4096 && rows.C1.chainTransport === 4096,
    'C1 generic path: chain = 4096 immediately (control still works)');
  addon.audio_setEffectParameter(trackId, nodeId, 'b0_mode', 0);
  rows.C2 = readAll('C2 generic path b0_mode=0 (immediate)', trackId, nodeId);
  expect(rows.C2.chainTelemetry === 0 && rows.C2.chainTransport === 0,
    'C2 generic path: chain back to 0 immediately');

  // ── The UI band path. Exactly eqStore.setBandParam(bandIndex, 'mode', 2).
  let ok = addon.audio_eqSetBandParam(trackId, nodeId, 0, 'mode', 2);
  log(`call  audio_eqSetBandParam(${trackId}, ${nodeId}, 0, 'mode', 2) -> ${ok}`);
  rows.R1 = await readHealed('R1 eqSetBandParam mode=2', trackId, nodeId);
  expect(ok === true && rows.R1.effectLatency === 4096, 'R1 RPC moved the effect latency to 4096');
  expect(rows.R1.healed && rows.R1.chainTelemetry === 4096,
    `R1 Spectral ON via eqSetBandParam: chain = 4096 (healed in ${rows.R1.healMs} ms)`);

  ok = addon.audio_eqSetBandParam(trackId, nodeId, 0, 'mode', 0);
  log(`call  audio_eqSetBandParam(${trackId}, ${nodeId}, 0, 'mode', 0) -> ${ok}`);
  rows.R2 = await readHealed('R2 eqSetBandParam mode=0', trackId, nodeId);
  expect(ok === true && rows.R2.healed && rows.R2.effectLatency === 0 && rows.R2.chainTelemetry === 0,
    `R2 Spectral OFF via eqSetBandParam: chain = 0 (healed in ${rows.R2.healMs} ms)`);

  // ── Mirror (discriminating OFF): raise via the generic path (inline, so the
  // chain is 4096 for sure), then lower via the RPC. Pre-fix this stayed 4096.
  addon.audio_setEffectParameter(trackId, nodeId, 'b0_mode', 2);
  rows.M0 = readAll('M0 generic b0_mode=2 (chain raised)', trackId, nodeId);
  ok = addon.audio_eqSetBandParam(trackId, nodeId, 0, 'mode', 0);
  rows.M1 = await readHealed('M1 then eqSetBandParam mode=0', trackId, nodeId);
  expect(rows.M0.chainTelemetry === 4096 && ok === true && rows.M1.healed && rows.M1.chainTelemetry === 0,
    `M1 generic ON -> RPC OFF: chain 4096 -> 0 (healed in ${rows.M1.healMs} ms)`);

  addon.audio_setEffectParameter(trackId, nodeId, 'linphase', 1);
  rows.M2 = readAll('M2 generic linphase=1 (chain raised)', trackId, nodeId);
  ok = addon.audio_eqSetGlobalParam(trackId, nodeId, 'linphase', 0);
  rows.M3 = await readHealed('M3 then eqSetGlobalParam linphase=0', trackId, nodeId);
  expect(rows.M2.chainTelemetry > 0 && ok === true && rows.M3.healed && rows.M3.chainTelemetry === 0,
    `M3 generic linphase ON -> RPC OFF: chain ${rows.M2.chainTelemetry} -> 0 (healed in ${rows.M3.healMs} ms)`);

  // ── The UI global path: latency-affecting globals.
  ok = addon.audio_eqSetGlobalParam(trackId, nodeId, 'linphase', 1);
  log(`call  audio_eqSetGlobalParam(${trackId}, ${nodeId}, 'linphase', 1) -> ${ok}`);
  rows.G1 = await readHealed('G1 eqSetGlobalParam linphase=1', trackId, nodeId);
  expect(ok === true && rows.G1.effectLatency > 0, `G1 linphase moved the effect latency (${rows.G1.effectLatency})`);
  expect(rows.G1.healed, `G1 linphase ON: chain = effect latency ${rows.G1.effectLatency} (healed in ${rows.G1.healMs} ms)`);

  ok = addon.audio_eqSetGlobalParam(trackId, nodeId, 'linphase', 0);
  rows.G2 = await readHealed('G2 eqSetGlobalParam linphase=0', trackId, nodeId);
  expect(ok === true && rows.G2.healed && rows.G2.chainTelemetry === 0,
    `G2 linphase OFF: chain = 0 (healed in ${rows.G2.healMs} ms)`);

  ok = addon.audio_eqSetGlobalParam(trackId, nodeId, 'oversample', 1);
  log(`call  audio_eqSetGlobalParam(${trackId}, ${nodeId}, 'oversample', 1) -> ${ok}`);
  rows.G3 = await readHealed('G3 eqSetGlobalParam oversample=1', trackId, nodeId);
  expect(ok === true && rows.G3.effectLatency > 0, `G3 oversample moved the effect latency (${rows.G3.effectLatency})`);
  expect(rows.G3.healed, `G3 oversample ON: chain = effect latency ${rows.G3.effectLatency} (healed in ${rows.G3.healMs} ms)`);

  ok = addon.audio_eqSetGlobalParam(trackId, nodeId, 'oversample', 0);
  rows.G4 = await readHealed('G4 eqSetGlobalParam oversample=0', trackId, nodeId);
  expect(ok === true && rows.G4.healed && rows.G4.chainTelemetry === 0,
    `G4 oversample OFF: chain = 0 (healed in ${rows.G4.healMs} ms)`);

  // ── Verdict
  const failed = results.filter((r) => !r.ok);
  log(`summary chain(telemetry): C1=${rows.C1.chainTelemetry} R1=${rows.R1.chainTelemetry} `
    + `R2=${rows.R2.chainTelemetry} G1=${rows.G1.chainTelemetry} G2=${rows.G2.chainTelemetry} `
    + `G3=${rows.G3.chainTelemetry} G4=${rows.G4.chainTelemetry}`);
  log(`heal times (ms): R1=${rows.R1.healMs} R2=${rows.R2.healMs} M1=${rows.M1.healMs} `
    + `M3=${rows.M3.healMs} G1=${rows.G1.healMs} G2=${rows.G2.healMs} G3=${rows.G3.healMs} `
    + `G4=${rows.G4.healMs}`);
  log(`${results.length - failed.length}/${results.length} passed`);
  log(failed.length === 0
    ? 'VERDICT=PASS reason="every RPC latency change reached the chain PDC without an unrelated graph edit"'
    : `VERDICT=FAIL reason="${failed.map((f) => f.what).join('; ')}"`);

  try { addon.stop(); } catch (_) { /* not playing */ }
  fs.rmSync(projDir, { recursive: true, force: true });
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((err) => {
  log(`VERDICT=FAIL reason="probe threw: ${err && err.stack ? err.stack : err}"`);
  process.exit(1);
});
