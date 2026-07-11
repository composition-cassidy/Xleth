'use strict';
//
// bridge/run_contract_tests.js — runs every test_*.js contract script in this
// directory sequentially (each in its own node process, since each script
// loads its own instance of xleth_native.node), then the compiled
// test_export_naming.exe (built by bridge/CMakeLists.txt alongside the addon).
//
// Invoked by `npm test`. Exits non-zero if any script fails.
//

const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const scripts = fs.readdirSync(__dirname)
  .filter((f) => /^test_.*\.js$/.test(f))
  .sort();

const results = [];

function run(label, command, args) {
  console.log(`\n=== ${label} ===`);
  const r = spawnSync(command, args, { cwd: __dirname, stdio: 'inherit' });
  const code = r.status === null ? 1 : r.status; // null = crashed/killed
  results.push({ label, code });
}

for (const script of scripts) {
  run(script, process.execPath, [path.join(__dirname, script)]);
}

// C++ export-naming unit test — built by the bridge cmake-js build, not part
// of the 46 engine CTest targets.
const exportNamingExe = path.join(__dirname, 'build', 'Release',
  process.platform === 'win32' ? 'test_export_naming.exe' : 'test_export_naming');
if (fs.existsSync(exportNamingExe)) {
  run('test_export_naming (C++)', exportNamingExe, []);
} else {
  console.log('\n=== test_export_naming (C++) ===');
  console.log(`SKIPPED — not built (${exportNamingExe} missing; run npm run build first)`);
}

console.log('\n──────────────────────────────────────────');
const failed = results.filter((r) => r.code !== 0);
for (const r of results) {
  console.log(`${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.label}`);
}
console.log(`${results.length - failed.length}/${results.length} contract test scripts passed`);
process.exit(failed.length === 0 ? 0 : 1);
