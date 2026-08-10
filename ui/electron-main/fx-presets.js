'use strict';

// ── Stock-effect presets (named save/load of an effect's full state) ──────────
// Generic across every stock effect. Two roots, mirroring the theme /
// plugin-ui-layout stores:
//   • Factory presets — bundled read-only with the app, resolved via
//     runtimeResource('app', 'src', 'fx-presets', 'factory', <effectType>/*.json)
//     exactly like plugin-ui-layouts resolves its shipped layout JSON.
//   • User presets   — writable, under userDataPath('fx-presets', <effectType>),
//     following the same convention as themes / knob-presets.
//
// A preset file is one JSON document:
//   { xlethFxPreset: 1, effectType, name, author?, created, state }
// where `state` is the exact engine-state blob the renderer captured through the
// bridge (scalar params for every effect; params + curves for APEX). This module
// never interprets `state` — it only validates the envelope and owns filesystem
// safety (the slug is authoritative here, never trusted from the renderer).
//
// Handlers register at require time, same timing as themes.js / knob-presets.js.
// init() is a no-op so main.js can wire every Stage-2-style store identically.

const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { runtimeResource, userDataPath } = require('../runtimePaths');

const PRESET_MAGIC = 'xlethFxPreset';
const PRESET_VERSION = 1;
const MAX_PRESET_BYTES = 512 * 1024;     // 512 KB — APEX curves are the largest payload
const MAX_PRESETS_PER_EFFECT = 500;
const MAX_NAME_LEN = 80;
const MAX_AUTHOR_LEN = 80;

// Windows reserved device names — a bare "con.json" is not a real file on NTFS.
const RESERVED_WIN_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

// effectType is a stock-effect id (apex, compressor, xletheq, …). It becomes a
// directory name on disk, so hold it to the same shape pluginIdSafe enforces.
function effectTypeSafe(effectType) {
  return typeof effectType === 'string'
    && /^[a-z][a-z0-9_-]*$/.test(effectType)
    && effectType.length <= 64;
}

// Filesystem-safe slug of a display name. Every run of non-alphanumeric becomes
// a single dash and both ends are trimmed, so the result can never carry a
// reserved character, a path separator, a traversal token, or a leading/trailing
// dot or space. Reserved Windows device names are prefixed to keep them real.
// Kept byte-for-byte in step with ui/src/fx-presets/slugify.js (the renderer's
// optimistic copy) — this one is authoritative because it names the file.
function slugifyPresetName(name) {
  const base = String(name == null ? '' : name)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  let slug = base || 'preset';
  if (RESERVED_WIN_NAMES.has(slug)) slug = '_' + slug;
  return slug;
}

// Defence-in-depth for slugs that arrive from the renderer (load / delete). Our
// slugify only ever emits [a-z0-9-] plus an optional leading underscore, so this
// is the exact acceptance set — nothing with a dot, slash, or ".." survives.
function slugSafe(slug) {
  return typeof slug === 'string'
    && /^[a-z0-9_][a-z0-9_-]*$/.test(slug)
    && slug.length <= 80;
}

function userEffectDir(effectType) {
  return userDataPath('fx-presets', effectType);
}

// Resolve a user preset file path with hard containment: the resolved path must
// be exactly <userEffectDir>/<slug>.json and live inside the effect's dir.
function userPresetPath(effectType, slug) {
  if (!effectTypeSafe(effectType)) throw new Error('invalid effectType');
  if (!slugSafe(slug)) throw new Error('invalid preset slug');
  const base = path.resolve(userEffectDir(effectType));
  const target = path.resolve(base, `${slug}.json`);
  if (target !== path.join(base, `${slug}.json`)) throw new Error('invalid preset slug');
  if (!target.startsWith(base + path.sep)) throw new Error('invalid preset slug');
  return target;
}

function factoryEffectDir(effectType) {
  return runtimeResource('app', 'src', 'fx-presets', 'factory', effectType);
}

function factoryPresetPath(effectType, slug) {
  if (!effectTypeSafe(effectType)) throw new Error('invalid effectType');
  if (!slugSafe(slug)) throw new Error('invalid preset slug');
  const base = path.resolve(factoryEffectDir(effectType));
  const target = path.resolve(base, `${slug}.json`);
  if (target !== path.join(base, `${slug}.json`)) throw new Error('invalid preset slug');
  if (!target.startsWith(base + path.sep)) throw new Error('invalid preset slug');
  return target;
}

function ensureUserEffectDir(effectType) {
  try { fs.mkdirSync(userEffectDir(effectType), { recursive: true }); } catch {}
}

// Validate the preset envelope (never the opaque `state` blob). Returns a
// normalized copy on success or throws with a human-readable reason so the
// renderer can surface it — an effectType mismatch is a hard, visible error.
function validatePresetEnvelope(preset, expectedEffectType) {
  if (!preset || typeof preset !== 'object' || Array.isArray(preset)) {
    throw new Error('preset must be a JSON object');
  }
  if (preset[PRESET_MAGIC] !== PRESET_VERSION) {
    throw new Error(`not an XLETH FX preset (expected ${PRESET_MAGIC}: ${PRESET_VERSION})`);
  }
  if (!effectTypeSafe(preset.effectType)) {
    throw new Error('preset has an invalid effectType');
  }
  if (expectedEffectType != null && preset.effectType !== expectedEffectType) {
    throw new Error(
      `preset is for "${preset.effectType}", not "${expectedEffectType}"`
    );
  }
  if (typeof preset.name !== 'string' || preset.name.trim().length === 0) {
    throw new Error('preset requires a non-empty name');
  }
  if (preset.name.length > MAX_NAME_LEN) {
    throw new Error(`preset name exceeds ${MAX_NAME_LEN} characters`);
  }
  if (preset.author !== undefined
    && (typeof preset.author !== 'string' || preset.author.length > MAX_AUTHOR_LEN)) {
    throw new Error('preset author must be a short string');
  }
  if (!preset.state || typeof preset.state !== 'object' || Array.isArray(preset.state)) {
    throw new Error('preset requires a state object');
  }
  return {
    [PRESET_MAGIC]: PRESET_VERSION,
    effectType: preset.effectType,
    name: preset.name,
    ...(preset.author ? { author: preset.author } : {}),
    created: typeof preset.created === 'string' ? preset.created : new Date().toISOString(),
    state: preset.state,
  };
}

// Read + parse one preset file, returning only the light metadata the dropdown
// needs. Corrupt / mistyped files are skipped, not fatal.
function readPresetMeta(filePath, effectType, source) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (raw.length > MAX_PRESET_BYTES) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.[PRESET_MAGIC] !== PRESET_VERSION) return null;
    if (parsed.effectType !== effectType) return null;
    if (typeof parsed.name !== 'string' || !parsed.name.trim()) return null;
    const slug = path.basename(filePath, '.json');
    if (!slugSafe(slug)) return null;
    return {
      slug,
      name: parsed.name,
      author: typeof parsed.author === 'string' ? parsed.author : null,
      created: typeof parsed.created === 'string' ? parsed.created : null,
      effectType,
      source,
    };
  } catch {
    return null;
  }
}

function listDir(dir, effectType, source) {
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    const meta = readPresetMeta(path.join(dir, f), effectType, source);
    if (meta) out.push(meta);
    if (out.length >= MAX_PRESETS_PER_EFFECT) break;
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ── IPC surface ───────────────────────────────────────────────────────────────

// List both roots for an effect type. Returns { factory:[meta], user:[meta] };
// metadata only (no state) so the dropdown stays cheap.
ipcMain.handle('xleth:fxPreset:list', (_, effectType) => {
  if (!effectTypeSafe(effectType)) throw new Error('invalid effectType');
  return {
    factory: listDir(factoryEffectDir(effectType), effectType, 'factory'),
    user: listDir(userEffectDir(effectType), effectType, 'user'),
  };
});

// Load one full preset (with its state blob) for applying. `source` selects the
// root; effectType is re-validated against the file so a mismatch never applies.
ipcMain.handle('xleth:fxPreset:load', (_, effectType, source, slug) => {
  if (!effectTypeSafe(effectType)) throw new Error('invalid effectType');
  if (source !== 'factory' && source !== 'user') throw new Error('invalid preset source');
  const filePath = source === 'factory'
    ? factoryPresetPath(effectType, slug)
    : userPresetPath(effectType, slug);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    throw new Error('preset not found');
  }
  if (raw.length > MAX_PRESET_BYTES) throw new Error('preset file too large');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('preset file is not valid JSON'); }
  return validatePresetEnvelope(parsed, effectType);
});

// Save a preset to the USER root. The store owns the slug (authoritative) and
// returns it so the renderer can select the freshly written entry. Overwrite is
// intentional — the renderer confirms with the user before calling.
ipcMain.handle('xleth:fxPreset:save', (_, preset) => {
  const normalized = validatePresetEnvelope(preset, null);
  const effectType = normalized.effectType;
  const slug = slugifyPresetName(normalized.name);
  const target = userPresetPath(effectType, slug);
  const serialized = JSON.stringify(normalized, null, 2);
  if (serialized.length > MAX_PRESET_BYTES) throw new Error('preset state is too large to save');
  ensureUserEffectDir(effectType);
  const existed = fs.existsSync(target);
  if (!existed) {
    const current = listDir(userEffectDir(effectType), effectType, 'user');
    if (current.length >= MAX_PRESETS_PER_EFFECT) throw new Error('too many user presets for this effect');
  }
  fs.writeFileSync(target, serialized, 'utf8');
  return { slug, overwritten: existed };
});

// Delete a USER preset. Factory presets are read-only and have no delete path.
ipcMain.handle('xleth:fxPreset:delete', (_, effectType, slug) => {
  const target = userPresetPath(effectType, slug);
  try { fs.unlinkSync(target); return true; } catch { return false; }
});

// No injected dependencies — init() exists for main.js wiring parity.
function init() {}

module.exports = {
  init,
  // Exported for unit tests / the node smoke harness.
  effectTypeSafe,
  slugifyPresetName,
  slugSafe,
  validatePresetEnvelope,
};
