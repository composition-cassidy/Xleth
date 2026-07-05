'use strict';

// ── Themes (persisted to userData/themes/<slug>.json) ─────────────────────────
// User-authored theme files. Shipped themes are bundled with the renderer and
// don't hit disk — they're imported directly from ui/src/theming/shipped/.
// Extracted verbatim from ui/main.js (S5 Stage 2 decomposition); handlers
// register at require time, same as at main.js module scope.

const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { userDataPath } = require('../runtimePaths');

const themesDir = userDataPath('themes')
function ensureThemesDir() {
  try { fs.mkdirSync(themesDir, { recursive: true }) } catch {}
}
function themeSlugSafe(slug) {
  // Defence-in-depth: slugs come from the renderer and become filesystem
  // paths. Permit letters, digits, dash, underscore only.
  return typeof slug === 'string' && /^[A-Za-z0-9_-]+$/.test(slug) && slug.length <= 64
}
function themePath(slug) { return path.join(themesDir, `${slug}.json`) }

ipcMain.handle('xleth:theme:loadUser', (_, slug) => {
  if (!themeSlugSafe(slug)) throw new Error('invalid theme slug')
  try { return JSON.parse(fs.readFileSync(themePath(slug), 'utf8')) }
  catch { return null }
})
ipcMain.handle('xleth:theme:saveUser', (_, slug, theme) => {
  if (!themeSlugSafe(slug)) throw new Error('invalid theme slug')
  if (!theme || typeof theme !== 'object') throw new Error('theme must be an object')
  ensureThemesDir()
  fs.writeFileSync(themePath(slug), JSON.stringify(theme, null, 2), 'utf8')
  return true
})
ipcMain.handle('xleth:theme:listUser', () => {
  ensureThemesDir()
  let entries = []
  try { entries = fs.readdirSync(themesDir) } catch { return [] }
  return entries
    .filter(f => f.endsWith('.json'))
    .map(f => f.slice(0, -5))
    .filter(themeSlugSafe)
})
ipcMain.handle('xleth:theme:deleteUser', (_, slug) => {
  if (!themeSlugSafe(slug)) throw new Error('invalid theme slug')
  try { fs.unlinkSync(themePath(slug)); return true } catch { return false }
})

// No injected dependencies yet — init() exists so main.js wires every Stage 2
// store the same way.
function init() {}

module.exports = { init };
