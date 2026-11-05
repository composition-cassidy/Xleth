import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Regression guard for "Missing Python package(s): onnxruntime, torch" ─────
//
// That message was what every separation tier showed on a packaged build. The
// sidecar is Python, the installer shipped no Python, so separation.js fell
// through to whatever interpreter was on the user's PATH — which of course had
// none of the sidecar's dependencies. The strip then told the user to install
// them from `tools/separation_sidecar/requirements.txt`, a path that exists
// only in a source checkout. The feature was developer-only by accident.
//
// The fix has three moving parts in electron-builder.json, and dropping any one
// of them reproduces a variant of the same failure:
//
//   1. the bundled Python runtime            -> no interpreter, nothing runs
//   2. the sidecar package itself            -> "separation sidecar not found"
//   3. the weightless ONNX graphs            -> BALANCED and BEST cannot load
//
// The runtime is a build artifact (gitignored, ~143 MB), so its absence on a
// dev machine is normal and is reported rather than failed. Its CONFIG entry
// is not optional and is asserted unconditionally.

const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(uiDir, '..');

function config() {
  return JSON.parse(fs.readFileSync(path.join(uiDir, 'electron-builder.json'), 'utf8'));
}

function sidecarEntries() {
  return (config().extraResources || []).filter(
    (e) => e && typeof e.to === 'string' && e.to.split('/')[0] === 'separation_sidecar',
  );
}

describe('packaged separation sidecar resources', () => {
  const entries = sidecarEntries();

  it('ships the sidecar package', () => {
    const base = entries.find((e) => e.to === 'separation_sidecar');
    expect(base, 'no extraResources entry copying the sidecar').toBeTruthy();
    expect(fs.existsSync(path.resolve(uiDir, base.from))).toBe(true);
  });

  it('ships the bundled Python runtime', () => {
    const runtime = entries.find((e) => e.to === 'separation_sidecar/runtime');
    expect(
      runtime,
      'electron-builder.json has no entry for separation_sidecar/runtime. Without ' +
        'it the installer ships no Python and every tier reports missing packages.',
    ).toBeTruthy();

    const source = path.resolve(uiDir, runtime.from);
    if (!fs.existsSync(source)) {
      // Not a failure: it is produced by
      // tools/separation_sidecar/tools/build_sidecar_runtime.py and is not in git.
      console.warn(
        `[packagedSeparationResources] runtime not built at ${source} — ` +
          'run tools/separation_sidecar/tools/build_sidecar_runtime.py before packaging.',
      );
      return;
    }
    const exe = path.join(source, process.platform === 'win32' ? 'python.exe' : 'bin/python3');
    expect(fs.existsSync(exe), `${exe} missing from the built runtime`).toBe(true);
  });

  it('ships the weightless ONNX graphs the Roformer tiers need', () => {
    const base = entries.find((e) => e.to === 'separation_sidecar');
    const filters = base.filter || [];
    const includesGraphs = filters.some((f) => f.includes('xleth_separation/graphs/'));
    expect(
      includesGraphs,
      'the sidecar filter list does not include xleth_separation/graphs/. The ' +
        'BALANCED and BEST tiers load their graph from there and cannot run without it.',
    ).toBe(true);

    const graphDir = path.join(repoDir, 'tools', 'separation_sidecar',
      'xleth_separation', 'graphs');
    expect(fs.existsSync(graphDir), `${graphDir} missing`).toBe(true);

    for (const modelId of ['mel_roformer_becruily_deux', 'bs_roformer_ft1_anvuew']) {
      const graph = path.join(graphDir, `${modelId}.onnx`);
      const manifest = path.join(graphDir, `${modelId}.onnx.json`);
      expect(fs.existsSync(graph), `${graph} missing`).toBe(true);
      expect(fs.existsSync(manifest), `${manifest} missing`).toBe(true);

      // A graph that grew past a few MB is carrying weights it should not be —
      // which is a licensing problem, not just a size one. See
      // NOTICE-separation-models.md.
      const mb = fs.statSync(graph).size / 1e6;
      expect(mb, `${modelId}.onnx is ${mb.toFixed(1)} MB; a weightless graph is ~2 MB`)
        .toBeLessThan(10);
    }
  });

  it('excludes the dev venv and the runtime build cache', () => {
    const base = entries.find((e) => e.to === 'separation_sidecar');
    const filters = base.filter || [];
    for (const unwanted of ['!.venv/**/*', '!runtime/**/*']) {
      expect(
        filters,
        `${unwanted} must stay in the filter list, or the sidecar entry copies ` +
          'the runtime a second time (and a developer venv with it).',
      ).toContain(unwanted);
    }
  });

  it('does not tell packaged users to open a file from the source tree', () => {
    // The old copy pointed at tools/separation_sidecar/requirements.txt, which
    // does not exist in an installed app.
    for (const rel of [
      'electron-main/separation.js',
      'src/components/sandbox/SandboxSeparationStrip.jsx',
      'src/components/sandbox/SandboxMenuBar.jsx',
    ]) {
      const source = fs.readFileSync(path.join(uiDir, rel), 'utf8');
      const userFacing = source
        .split('\n')
        .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
        .join('\n');
      expect(
        userFacing.includes('separation_sidecar/requirements.txt'),
        `${rel} still points users at tools/separation_sidecar/requirements.txt`,
      ).toBe(false);
    }
  });
});
