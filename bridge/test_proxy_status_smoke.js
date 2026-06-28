'use strict';
//
// bridge/test_proxy_status_smoke.js — smoke test for proxy_getStatus plumbing
//
// Verifies the full bridge → engine dispatch → ProxyManager::getStatus() chain:
//   - proxy_getStatus is exported by the rebuilt addon (not "notImplemented")
//   - it returns { pending, inFlight, completed, total } as integers
//   - with no project loaded, every counter is 0 (nothing enqueued this session)
//
// Run after `build.bat bridge`:
//   node bridge/test_proxy_status_smoke.js
//
const fs = require('fs');
const path = require('path');

function pickNativeConfig() {
  const requested = process.env.XLETH_NATIVE_CONFIG;
  const configs = requested ? [requested] : ['Release', 'Debug'];
  for (const config of configs) {
    const addonPath = path.resolve(__dirname, 'build', config, 'xleth_native.node');
    if (fs.existsSync(addonPath)) return { config, addonPath };
  }
  throw new Error('xleth_native.node not found in bridge/build/{Debug,Release}');
}

const native = pickNativeConfig();
const repoRoot = path.resolve(__dirname, '..');
const dllDirs = [
  path.dirname(native.addonPath),
  path.resolve(repoRoot, 'vendor/ffmpeg/bin'),
  path.resolve(repoRoot, 'build/vcpkg_installed/x64-windows/bin'),
  path.resolve(__dirname, 'build/vcpkg_installed/x64-windows/bin'),
].filter((dir) => fs.existsSync(dir));
process.env.PATH = `${dllDirs.join(';')};${process.env.PATH}`;
process.env.XLETH_BRIDGE_DISABLE_PREVIEW_GPU = '1';

const addon = require(native.addonPath);

let failed = 0;
function ok(cond, label) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed += 1;
}

ok(typeof addon.proxy_getStatus === 'function', 'proxy_getStatus is exported');
ok(addon.initialize({ disablePreviewGpu: true }) === true, 'initialize() returns true');

const st = addon.proxy_getStatus();
console.log('  proxy_getStatus() =>', JSON.stringify(st));

ok(st && typeof st === 'object', 'returns an object');
for (const k of ['pending', 'inFlight', 'completed', 'total']) {
  ok(typeof st[k] === 'number', `has numeric field "${k}"`);
}
ok(st.pending === 0 && st.inFlight === 0 && st.completed === 0 && st.total === 0,
   'all counters are 0 with no project loaded');
ok(st.pending === st.total - st.completed, 'pending == total - completed invariant');

if (typeof addon.shutdown === 'function') {
  try { addon.shutdown(); } catch (_) {}
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
