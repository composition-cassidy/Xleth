'use strict';

// ── Still images and generated media ─────────────────────────────────────────
// The engine imports stills through FFmpeg, whose build here has no zlib and so
// no PNG decoder. PNGs are decoded by Electron and rewritten as BMP, which
// FFmpeg reads natively, alpha included. Solid colours and gradients are drawn
// straight into a BMP the same way. JPEG / BMP / WebP / GIF go to the engine
// untouched.
//
// Files land in <project>/media when the project has a folder, else in
// <userData>/generated-media.

const { ipcMain, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { callWorker } = require('./worker');
const { userDataPath } = require('../runtimePaths');

const CONVERT_EXT = new Set(['.png']);
const GRADIENT_DIRECTIONS = new Set(['horizontal', 'vertical', 'diagonal', 'radial']);

// 32-bit top-down BMP from straight-alpha BGRA rows (FFmpeg decodes it as bgra).
function encodeBmp(width, height, bgra) {
  const header = Buffer.alloc(54);
  header.write('BM', 0, 'ascii');
  header.writeUInt32LE(54 + bgra.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(-height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(32, 28);
  header.writeUInt32LE(bgra.length, 34);
  return Buffer.concat([header, bgra]);
}

// #rrggbb or #rrggbbaa -> [r, g, b, a].
function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(hex || ''));
  if (!m) throw new Error(`Invalid colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, m[2] ? parseInt(m[2], 16) : 255];
}

// Already validated by parseHex; '#' is left out of file names (it breaks URLs),
// and a fully opaque alpha is left off so old names stay the same.
const hexName = (hex) => String(hex).replace('#', '').toUpperCase().replace(/^(.{6})FF$/, '$1');

// Electron's bitmaps are premultiplied; the compositor blends straight alpha.
function unpremultiply(bgra) {
  for (let i = 0; i < bgra.length; i += 4) {
    const a = bgra[i + 3];
    if (a === 0 || a === 255) continue;
    for (let k = 0; k < 3; k++) bgra[i + k] = Math.min(255, Math.round(bgra[i + k] * 255 / a));
  }
  return bgra;
}

// Small sizes are enough: the compositor scales the still with bilinear
// filtering, so a flat fill or a smooth ramp upscales without visible steps.
function renderGenerated({ kind, color, from, to, direction }) {
  if (kind === 'solid') {
    const [r, g, b, a] = parseHex(color);
    const w = 64, h = 36, px = Buffer.alloc(w * h * 4);
    for (let i = 0; i < px.length; i += 4) { px[i] = b; px[i + 1] = g; px[i + 2] = r; px[i + 3] = a; }
    return { w, h, px, name: `Solid ${hexName(color)}` };
  }
  if (kind === 'gradient') {
    if (!GRADIENT_DIRECTIONS.has(direction)) throw new Error(`Invalid gradient direction: ${direction}`);
    const a = parseHex(from), c = parseHex(to);
    const w = 640, h = 360, px = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = x / (w - 1), v = y / (h - 1);
        let t;
        if (direction === 'horizontal') t = u;
        else if (direction === 'vertical') t = v;
        else if (direction === 'diagonal') t = (u + v) / 2;
        else t = Math.min(1, Math.hypot(u - 0.5, (v - 0.5) * h / w) / 0.5);
        // Blend premultiplied so a fade to transparent keeps its colour
        // instead of dipping through the transparent end's RGB.
        const al = a[3] + (c[3] - a[3]) * t;
        const o = (y * w + x) * 4;
        for (let k = 0; k < 3; k++) {
          const pm = a[k] * a[3] + (c[k] * c[3] - a[k] * a[3]) * t;
          px[o + 2 - k] = al > 0 ? Math.round(pm / al) : 0;
        }
        px[o + 3] = Math.round(al);
      }
    }
    return { w, h, px, name: `Gradient ${direction} ${hexName(from)} to ${hexName(to)}` };
  }
  throw new Error(`Unknown generated media kind: ${kind}`);
}

async function mediaDir() {
  let projectDir = '';
  try { projectDir = (await callWorker('project_getInfo', []))?.projectDir || ''; } catch {}
  const dir = projectDir ? path.join(projectDir, 'media') : userDataPath('generated-media');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// The path the engine should import for `filePath`: itself, or a BMP copy of a PNG.
async function prepareImport(filePath) {
  if (typeof filePath !== 'string' || !filePath) throw new Error('prepareImport(filePath: string)');
  const ext = path.extname(filePath).toLowerCase();
  if (!CONVERT_EXT.has(ext)) return filePath;

  const img = nativeImage.createFromPath(filePath);
  if (img.isEmpty()) throw new Error('Could not read the image.');
  const { width, height } = img.getSize();
  const stat = fs.statSync(filePath);
  // A per-file subfolder keeps the source's own name while two red.png files from
  // different folders (or an edited one) still get separate copies.
  const tag = crypto.createHash('sha1').update(`${filePath}|${stat.size}|${stat.mtimeMs}`).digest('hex').slice(0, 8);
  const dir = path.join(await mediaDir(), tag);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${path.basename(filePath, ext)}.bmp`);
  if (!fs.existsSync(out)) fs.writeFileSync(out, encodeBmp(width, height, unpremultiply(img.toBitmap())));
  return out;
}

async function createGenerated(spec) {
  const { w, h, px, name } = renderGenerated(spec || {});
  const out = path.join(await mediaDir(), `${name}.bmp`);
  if (!fs.existsSync(out)) fs.writeFileSync(out, encodeBmp(w, h, px));
  return out;
}

function init({ safeHandler }) {
  ipcMain.handle('xleth:project:prepareImport', safeHandler((_, filePath) => prepareImport(filePath)));
  ipcMain.handle('xleth:project:createGeneratedMedia', safeHandler((_, spec) => createGenerated(spec)));
}

module.exports = { init, encodeBmp, renderGenerated, unpremultiply };
