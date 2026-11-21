'use strict';

// Console smoke test driving the REAL compiled engine addon (xleth_native.node
// via addon-worker.js, forked under system node — same mechanism as
// ui/electron-main/worker.js, replicated standalone here since worker.js
// requires('electron') and can't run outside an Electron process).
//
// Verifies the engine-side half of Welcome screen criterion (b): project_create
// writes project.json to disk immediately, with the video settings (width/
// height/fps/aspectRatio) chosen in the New Project form actually persisted —
// the new ProjectManager fields added for this feature.
//
//   node ui/tests/smoke/projectCreateVideoSettings.smoke.js

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { fork } = require('child_process');

const UI_DIR = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(UI_DIR, '..');
const bridgeDir = path.join(REPO_ROOT, 'bridge', 'build', 'Release');
const ffmpegDir = path.join(REPO_ROOT, 'vendor', 'ffmpeg', 'bin');
const workerPath = path.join(UI_DIR, 'addon-worker.js');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}

function callWorker(worker, nextId, method, args) {
  return new Promise((resolve, reject) => {
    const id = nextId.value++;
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 20_000);
    const onMessage = (msg) => {
      if (!msg || msg.id !== id) return;
      worker.off('message', onMessage);
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.result);
    };
    worker.on('message', onMessage);
    worker.send({ id, method, args });
  });
}

async function main() {
  console.log('project_create video-settings smoke test\n');
  console.log(`  bridge: ${bridgeDir}`);

  if (!fs.existsSync(path.join(bridgeDir, 'xleth_native.node'))) {
    console.log('  SKIP  xleth_native.node not built — run build.bat bridge-clean first');
    process.exit(1);
  }

  const worker = fork(workerPath, [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    cwd: bridgeDir,
    env: {
      ...process.env,
      XLETH_BRIDGE_DIR: bridgeDir,
      XLETH_FFMPEG_DIR: ffmpegDir,
    },
    serialization: 'advanced',
  });
  worker.stderr.on('data', (d) => process.stderr.write(`[engine:err] ${d}`));

  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('worker did not report ready within 60s')), 60_000);
    worker.on('message', (msg) => { if (msg && msg.ready) { clearTimeout(t); resolve(); } });
    worker.on('exit', (code) => { clearTimeout(t); reject(new Error(`worker exited early (code ${code})`)); });
  });

  try {
    await ready;
    console.log('  worker ready\n');

    const nextId = { value: 1 };
    await callWorker(worker, nextId, 'initialize', []);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xleth-project-create-smoke-'));
    const dir = path.join(root, 'My Smoke Test Project');
    const videoSettings = { width: 2560, height: 1440, fps: 59.94, aspectRatio: '4:3' };

    const ok = await callWorker(worker, nextId, 'project_create', [dir, 'My Smoke Test Project', videoSettings]);
    check('project_create resolves true', () => assert.strictEqual(ok, true));

    const projectJsonPath = path.join(dir, 'project.json');
    check('project.json exists on disk immediately after create (criterion b)', () => {
      assert.ok(fs.existsSync(projectJsonPath), `expected ${projectJsonPath} to exist`);
    });

    const written = JSON.parse(fs.readFileSync(projectJsonPath, 'utf8'));
    check('project.json has the correct project_name', () => {
      assert.strictEqual(written.project_name, 'My Smoke Test Project');
    });
    check('project.json persists the chosen video_width/video_height', () => {
      assert.strictEqual(written.video_width, 2560);
      assert.strictEqual(written.video_height, 1440);
    });
    check('project.json persists the chosen video_fps', () => {
      assert.strictEqual(written.video_fps, 59.94);
    });
    check('project.json persists the chosen aspect_ratio', () => {
      assert.strictEqual(written.aspect_ratio, '4:3');
    });

    const info = await callWorker(worker, nextId, 'project_getInfo', []);
    check('project_getInfo reflects the same video settings read back', () => {
      assert.strictEqual(info.videoWidth, 2560);
      assert.strictEqual(info.videoHeight, 1440);
      assert.strictEqual(info.videoFps, 59.94);
      assert.strictEqual(info.aspectRatio, '4:3');
    });

    // Round-trip: reload the project fresh and confirm the settings survive
    // (not just an in-memory echo of what was just set).
    const loaded = await callWorker(worker, nextId, 'project_load', [dir]);
    check('project_load succeeds on the freshly created project', () => assert.strictEqual(loaded, true));
    const infoAfterLoad = await callWorker(worker, nextId, 'project_getInfo', []);
    check('video settings survive a fresh project_load (not just createProject state)', () => {
      assert.strictEqual(infoAfterLoad.videoWidth, 2560);
      assert.strictEqual(infoAfterLoad.videoHeight, 1440);
      assert.strictEqual(infoAfterLoad.videoFps, 59.94);
      assert.strictEqual(infoAfterLoad.aspectRatio, '4:3');
    });

    // Backward compatibility: a 2-arg createProject call (no video settings —
    // matches every pre-existing C++ call site) must still default cleanly.
    const dir2 = path.join(root, 'Legacy Two Arg Project');
    const ok2 = await callWorker(worker, nextId, 'project_create', [dir2, 'Legacy Two Arg Project']);
    check('project_create still works with no videoSettings arg (backward compat)', () => assert.strictEqual(ok2, true));
    const written2 = JSON.parse(fs.readFileSync(path.join(dir2, 'project.json'), 'utf8'));
    check('omitted videoSettings falls back to XLETH defaults (1920x1080/30/16:9)', () => {
      assert.strictEqual(written2.video_width, 1920);
      assert.strictEqual(written2.video_height, 1080);
      assert.strictEqual(written2.video_fps, 30);
      assert.strictEqual(written2.aspect_ratio, '16:9');
    });

    fs.rmSync(root, { recursive: true, force: true });
  } finally {
    worker.kill();
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
