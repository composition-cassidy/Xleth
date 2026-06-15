'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function pickNativeConfig() {
  const requested = process.env.XLETH_NATIVE_CONFIG;
  const configs = requested ? [requested] : ['Release', 'Debug'];
  for (const config of configs) {
    const addonPath = path.resolve(__dirname, 'build', config, 'xleth_native.node');
    if (fs.existsSync(addonPath)) return { config, addonPath };
  }
  throw new Error('xleth_native.node not found in bridge/build/Debug or bridge/build/Release');
}

function writeTestWav(filePath) {
  const sampleRate = 48000;
  const seconds = 0.25;
  const frames = Math.floor(sampleRate * seconds);
  const dataSize = frames * 2 * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  let off = 0;
  buffer.write('RIFF', off); off += 4;
  buffer.writeUInt32LE(36 + dataSize, off); off += 4;
  buffer.write('WAVE', off); off += 4;
  buffer.write('fmt ', off); off += 4;
  buffer.writeUInt32LE(16, off); off += 4;
  buffer.writeUInt16LE(1, off); off += 2;
  buffer.writeUInt16LE(2, off); off += 2;
  buffer.writeUInt32LE(sampleRate, off); off += 4;
  buffer.writeUInt32LE(sampleRate * 2 * 2, off); off += 4;
  buffer.writeUInt16LE(2 * 2, off); off += 2;
  buffer.writeUInt16LE(16, off); off += 2;
  buffer.write('data', off); off += 4;
  buffer.writeUInt32LE(dataSize, off); off += 4;

  for (let i = 0; i < frames; i++) {
    const sample = Math.round(Math.sin((i / sampleRate) * Math.PI * 2 * 440) * 12000);
    buffer.writeInt16LE(sample, off); off += 2;
    buffer.writeInt16LE(sample, off); off += 2;
  }
  fs.writeFileSync(filePath, buffer);
}

const native = pickNativeConfig();
const dllDirs = [
  path.dirname(native.addonPath),
  path.resolve(__dirname, 'build/vcpkg_installed/x64-windows/debug/bin'),
  path.resolve(__dirname, 'build/vcpkg_installed/x64-windows/bin'),
].filter((dir) => fs.existsSync(dir));
process.env.PATH = `${dllDirs.join(';')};${process.env.PATH}`;
process.env.XLETH_BRIDGE_DISABLE_PREVIEW_GPU = '1';

const addon = require(native.addonPath);

let passed = 0;
let failed = 0;
let total = 0;

function ok(condition, label) {
  total += 1;
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed += 1;
  } else {
    console.error(`  FAIL  ${label}`);
    failed += 1;
  }
}

function near(actual, expected, tolerance, label) {
  ok(Math.abs(actual - expected) <= tolerance,
     `${label} (expected ${expected}, got ${actual}, tolerance ${tolerance})`);
}

async function main() {
  console.log(`=== xleth source preview contract test (${native.config}) ===\n`);

  const wavPath = path.join(os.tmpdir(), `xleth-source-preview-${process.pid}.wav`);
  writeTestWav(wavPath);

  try {
    ok(addon.initialize({ disablePreviewGpu: true }) === true, 'initialize() returns true');
    ok(typeof addon.source_loadSource === 'function', 'source_loadSource is exported');
    ok(typeof addon.source_playRegionPreview === 'function', 'source_playRegionPreview is exported');

    const firstLoad = addon.source_loadSource(wavPath);
    ok(firstLoad && firstLoad.success === true, 'first source load succeeds');
    ok(firstLoad.skipped === false, 'first source load is not skipped');

    const secondLoad = addon.source_loadSource(wavPath);
    ok(secondLoad && secondLoad.success === true, 'second same-path source load succeeds');
    ok(secondLoad.skipped === true, 'second same-path source load is skipped');

    const preview1 = addon.source_playRegionPreview(0.02, 0.08);
    const preview2 = addon.source_playRegionPreview(0.10, 0.16);
    ok(preview1.started === true, 'first bounded preview starts');
    ok(preview2.started === true, 'second bounded preview starts');
    ok(preview2.seq === preview1.seq + 1, 'bounded preview sequence increases');
    near(addon.source_getPosition(), 0.10, 0.002, 'latest preview wins and seeks to second start');

    addon.source_pauseSource();
    addon.source_unloadSource();
    addon.shutdown();
    ok(true, 'shutdown() completed');
  } finally {
    try { if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath); } catch (_) {}
  }

  console.log('\n' + '-'.repeat(50));
  console.log(`PASSED: ${passed}/${total} tests`);
  if (failed > 0) {
    console.error(`FAILED: ${failed}/${total} tests`);
    process.exit(1);
  }
}

main().catch((err) => {
  try { addon.shutdown(); } catch (_) {}
  console.error('\nUnhandled error:', err);
  process.exit(1);
});
