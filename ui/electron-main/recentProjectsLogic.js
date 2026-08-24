'use strict';

// Pure list-transform + status logic for the Welcome screen's recent-projects
// store. No Electron dependency (fs/path only) — importable and testable
// from plain node, unlike recent-projects.js which needs a running app for
// userDataPath(). See ui/tests/smoke/recentProjectsLogic.smoke.js.

const fs = require('fs');
const path = require('path');

const MAX_RECENTS = 10;

// Windows paths are case-insensitive; normalize for dedup comparison only —
// the original casing is preserved in stored entries.
function normalizeDir(dir) {
  return path.resolve(String(dir || '')).toLowerCase().replace(/[\\/]+$/, '');
}

// Returns a NEW list with `entry` moved to the front, deduped by normalized
// dir, capped at MAX_RECENTS. Pure — the caller persists the result.
function withTouched(list, entry) {
  const key = normalizeDir(entry.dir);
  const rest = (list || []).filter((r) => normalizeDir(r.dir) !== key);
  return [{ name: entry.name, dir: entry.dir, lastOpened: entry.lastOpened ?? Date.now() }, ...rest]
    .slice(0, MAX_RECENTS);
}

function withRemoved(list, dir) {
  const key = normalizeDir(dir);
  return (list || []).filter((r) => normalizeDir(r.dir) !== key);
}

// The real project file lives at <dir>/project.json (ProjectManager's
// projectFilePath()) — check that, not just the folder, so a folder that
// survived while project.json was deleted/moved still reads as MISSING.
function projectFileExists(dir) {
  try { return fs.statSync(path.join(dir, 'project.json')).isFile(); } catch { return false; }
}

// `exists` is never stored — always computed live so a project moved/deleted
// between sessions surfaces as MISSING immediately instead of lying from a
// stale flag.
function withStatus(list) {
  return (list || []).map((r) => ({ ...r, exists: projectFileExists(r.dir) }));
}

function firstValid(list) {
  return withStatus(list).find((r) => r.exists) || null;
}

module.exports = {
  MAX_RECENTS,
  normalizeDir,
  withTouched,
  withRemoved,
  projectFileExists,
  withStatus,
  firstValid,
};
