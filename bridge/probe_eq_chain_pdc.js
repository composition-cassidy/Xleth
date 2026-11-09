'use strict';
//
// bridge/probe_eq_chain_pdc.js - [RSBaseline] EQ chain-PDC runtime probe
//
// Resonance-suppressor rewrite, phase P0, Step 3
// (docs/RESONANCE_SUPPRESSOR_AUDIT.md section 3.1, "EQ - LIKELY broken PDC
// propagation").
//
// Question: does switching an EQ band to Spectral through the SAME path the UI
// uses - eqStore.setBandParam -> window.xleth.audio.eqSetBandParam ->
// addon.audio_eqSetBandParam -> Audio_EQ_SetBandParam -> XlethParametricEQ::
// setBandParam -> refreshLatencySamples() -> setLatencySamples() - update the
// latency the MIXER uses for inter-track PDC?
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
// Sequence (all on one track, one EQ insert, one band):
//   C  control, generic owner path (audio_setEffectParameter "b0_mode"):
//      proves the chain read DOES move when PDC is recomputed.
//   R  the UI path (audio_eqSetBandParam ... 'mode' 2): read immediately, read
//      again after 700 ms (does any debounce/timer heal it?), then an unrelated
//      graph edit (add a second effect -> rebuildImmediate -> computePDC) to
//      show what finally refreshes it.
//
// REPORT-ONLY: prints a verdict, always exits 0 (or 0 + BLOCKED when there is no
// audio device). Deliberately not named test_*.js, so bridge/run_contract_tests.js
// (which globs test_*.js) does not adopt it into the contract suite.
//
//   node bridge/probe_eq_chain_pdc.js
//

const fs = require('fs');
const os = require('os');
const path = require('path');

const P = '[RSBaseline]';
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

function readAll(label, trackId, nodeId) {
  const eff = asObj(addon.audio_getEffectLatency(trackId, nodeId));
  const tel = addon.audio_getAudioPerformanceTelemetry();
  const tr = addon.transport_getState();
  const row = {
    label,
    effectLatency: eff.latencySamples,
    chainTelemetry: tel.maxAudibleTrackLatencySamples,
    chainTransport: tr.livePresentationMaxTrackLatencySamples,
  };
  log(`read  ${label.padEnd(34)} effect=${String(row.effectLatency).padStart(5)}  `
    + `chain(telemetry.maxAudibleTrackLatencySamples)=${String(row.chainTelemetry).padStart(5)}  `
    + `chain(transport.livePresentationMaxTrackLatencySamples)=${String(row.chainTransport).padStart(5)}`);
  return row;
}

(async () => {
  log('=== EQ chain-PDC probe (RPC path vs generic owner path) ===');

  for (const fn of ['initialize', 'project_create', 'timeline_addTrack', 'audio_addEffect', 'audio_eqAddBand',
                    'audio_eqSetBandParam', 'audio_setEffectParameter', 'audio_getEffectLatency',
                    'audio_getAudioPerformanceTelemetry', 'transport_getState']) {
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

  const projDir = path.join(os.tmpdir(), '_xleth_rsbaseline_eq_pdc');
  fs.rmSync(projDir, { recursive: true, force: true });
  addon.project_create(projDir, 'RsBaselineEqPdc');
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

  // ── Control: generic owner path. AudioGraph::setEffectParameter compares the
  // effect latency before/after and calls rebuildImmediate() -> computePDC().
  addon.audio_setEffectParameter(trackId, nodeId, 'b0_mode', 2);
  rows.C1 = readAll('C1 generic path b0_mode=2', trackId, nodeId);
  addon.audio_setEffectParameter(trackId, nodeId, 'b0_mode', 0);
  rows.C2 = readAll('C2 generic path b0_mode=0', trackId, nodeId);

  // ── The UI path. Exactly eqStore.setBandParam(bandIndex, 'mode', 2).
  rows.R0 = readAll('R0 before RPC (mode 0)', trackId, nodeId);
  const rpcOk = addon.audio_eqSetBandParam(trackId, nodeId, 0, 'mode', 2);
  log(`call  audio_eqSetBandParam(${trackId}, ${nodeId}, 0, 'mode', 2) -> ${rpcOk}`);
  rows.R1 = readAll('R1 after RPC, immediately', trackId, nodeId);
  await sleep(700);
  rows.R2 = readAll('R2 after RPC, +700 ms', trackId, nodeId);

  // What finally refreshes it: any unrelated graph edit (rebuildImmediate).
  const filterNode = nodeIdOf(addon.audio_addEffect(trackId, 'xlethfilter', 1));
  log(`call  audio_addEffect(track, 'xlethfilter', 1) -> nodeId=${filterNode} (unrelated graph edit)`);
  rows.R3 = readAll('R3 after unrelated graph edit', trackId, nodeId);

  // Symmetry: switch Spectral back off through the RPC.
  addon.audio_eqSetBandParam(trackId, nodeId, 0, 'mode', 0);
  rows.R4 = readAll('R4 RPC mode=0 (spectral off)', trackId, nodeId);

  // ── Verdict
  const controlWorks = rows.C1.effectLatency > 0
    && rows.C1.chainTelemetry === rows.C1.effectLatency
    && rows.C2.chainTelemetry === 0;
  const spectralLatency = rows.R1.effectLatency;
  const effectMoved = spectralLatency > 0 && rows.R0.effectLatency === 0;
  const chainFollowedImmediately = rows.R1.chainTelemetry === spectralLatency
    && rows.R1.chainTransport === spectralLatency;
  const chainStale = effectMoved && rows.R1.chainTelemetry === rows.R0.chainTelemetry
    && rows.R1.chainTransport === rows.R0.chainTransport;
  const selfHealed = rows.R2.chainTelemetry === spectralLatency;
  const healedByGraphEdit = rows.R3.chainTelemetry === spectralLatency;

  let verdict;
  let why;
  if (!rpcOk || !effectMoved) {
    verdict = 'BLOCKED';
    why = `RPC did not move the effect latency (rpcOk=${rpcOk}, effect before/after `
        + `${rows.R0.effectLatency}/${spectralLatency}); cannot judge chain propagation`;
  } else if (!controlWorks) {
    verdict = 'BLOCKED';
    why = 'control failed: the generic owner path did not move the observable chain latency, '
        + 'so this harness cannot distinguish stale from fresh';
  } else if (chainFollowedImmediately) {
    verdict = 'REFUTED';
    why = `chain latency followed the RPC immediately (${rows.R0.chainTelemetry} -> ${rows.R1.chainTelemetry})`;
  } else if (chainStale) {
    verdict = 'CONFIRMED';
    why = `effect latency ${rows.R0.effectLatency} -> ${spectralLatency} but chain latency stayed `
        + `${rows.R1.chainTelemetry} (telemetry) / ${rows.R1.chainTransport} (transport) after the RPC`
        + `; self-healed after 700 ms: ${selfHealed}; refreshed by an unrelated graph edit: ${healedByGraphEdit}`;
  } else {
    verdict = 'BLOCKED';
    why = 'chain latency moved to an unexpected value; see read lines above';
  }

  log(`summary effect: ${rows.R0.effectLatency} -> ${rows.R1.effectLatency} | chain(telemetry): `
    + `${rows.R0.chainTelemetry} -> ${rows.R1.chainTelemetry} -> (+700ms) ${rows.R2.chainTelemetry} `
    + `-> (graph edit) ${rows.R3.chainTelemetry} -> (RPC spectral off) ${rows.R4.chainTelemetry}`);
  log(`VERDICT=${verdict} reason="${why}"`);

  try { addon.stop(); } catch (_) { /* not playing */ }
  fs.rmSync(projDir, { recursive: true, force: true });
  process.exit(0);
})().catch((err) => {
  log(`VERDICT=BLOCKED reason="probe threw: ${err && err.stack ? err.stack : err}"`);
  process.exit(0);
});
