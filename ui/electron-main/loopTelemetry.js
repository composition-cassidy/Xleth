'use strict';

// AUTO-loop telemetry: a local JSON Lines log (no network). One line per event —
// an "apply" when the sampler AUTO button snaps a loop, and a "nudge" when the
// user adjusts loopStart/loopEnd/crossfade within 30 s of an apply. This is the
// only signal for how often the snap is kept vs. adjusted; there is no confidence
// model (measured features cannot predict acceptance — LOO AUC 0.53).
//
// Pure fs helpers, given the target directory, so the append/read round-trip is
// unit-testable without Electron. main.js passes app.getPath('userData').

const fs = require('fs');
const path = require('path');

function telemetryFile(dir) {
  return path.join(dir, 'loop-telemetry.jsonl');
}

// Append one event as a JSON line, stamping an ISO timestamp if the caller did
// not supply one. Returns the file path. Throws on a bad event or IO failure.
function appendEvent(dir, event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('telemetry event must be an object');
  }
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + '\n';
  const file = telemetryFile(dir);
  fs.appendFileSync(file, line, 'utf8');
  return file;
}

// Parse the whole log back to an array of events (empty when none written yet).
function readAll(dir) {
  const file = telemetryFile(dir);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

module.exports = { telemetryFile, appendEvent, readAll };
