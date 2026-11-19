'use strict';

// ── Local HTTP media server for <video> elements ─────────────────────────────
// Chromium blocks custom protocols for <video>/<audio> src. A local HTTP server
// with proper Range support lets the browser's hardware video decoder work.
//
// Extracted verbatim from ui/main.js (S5 Stage 1 decomposition). main.js wires
// it in via init({ log, getRoots }) so logging still lands in the shared
// startup.log; the bound port is exposed via getMediaPort() for the
// xleth:getMediaPort handler.
//
// Any web page open in a browser on this PC can reach 127.0.0.1, so every
// request must carry the per-session token (getMediaToken(), handed to the
// renderer by preload) and may only read files under getRoots(): the open
// project folder and the folders of the project's sources.

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { pipeline } = require('stream');

// Injected by main.js (init) — the shared startup.log logger.
let log = (msg) => { process.stdout.write(String(msg) + '\n'); };
// Injected by main.js (init) — async () => array of directories files may be served from.
let getRoots = async () => [];

function init(deps) {
  if (deps && typeof deps.log === 'function') log = deps.log;
  if (deps && typeof deps.getRoots === 'function') getRoots = deps.getRoots;
}

// <video>/<audio> can't send headers, so the token rides in the URL query.
const mediaToken = crypto.randomBytes(32).toString('hex');
const tokenBuf = Buffer.from(mediaToken);

function tokenOk(token) {
  const b = Buffer.from(String(token || ''));
  return b.length === tokenBuf.length && crypto.timingSafeEqual(b, tokenBuf);
}

function isUnder(root, file) {
  const rel = path.relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

let allowedRoots = [];

async function isAllowed(realFile) {
  if (allowedRoots.some(r => isUnder(r, realFile))) return true;
  // Miss: the project or its sources may have changed since the last lookup.
  const roots = (await getRoots()) || [];
  const real = await Promise.all(roots.filter(Boolean).map(r => fs.promises.realpath(r).catch(() => null)));
  allowedRoots = real.filter(Boolean);
  return allowedRoots.some(r => isUnder(r, realFile));
}

// Returns { start, end } (inclusive) or null when malformed / unsatisfiable.
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') {                         // suffix range: the last N bytes
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
    if (Number(m[2]) === 0) return null;
  } else {
    start = Number(m[1]);
    // Open-ended ranges are served in ~1 MB chunks (unchanged from before).
    end = Math.min(m[2] === '' ? start + 1024 * 1024 : Number(m[2]), size - 1);
  }
  return start <= end && start < size ? { start, end } : null;
}

const MIME_TYPES = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac',
  '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};

function send(res, status, body, headers) {
  res.writeHead(status, headers);
  res.end(body);
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (!tokenOk(url.searchParams.get('token'))) return send(res, 403, 'Forbidden');

  const requested = url.searchParams.get('path');
  let filePath, stat;
  try {
    filePath = await fs.promises.realpath(requested);   // resolves '..' and symlinks
    stat = await fs.promises.stat(filePath);
  } catch {
    return send(res, 404, 'Not found');
  }
  if (!stat.isFile()) return send(res, 404, 'Not found');
  if (!(await isAllowed(filePath))) return send(res, 403, 'Forbidden');

  const fileSize = stat.size;
  const headers = {
    'Accept-Ranges': 'bytes',
    'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    // The renderer runs with COEP require-corp; CORP lets it embed this, CORS (none) still blocks reads.
    'Cross-Origin-Resource-Policy': 'cross-origin',
  };

  let range;
  if (req.headers.range !== undefined) {
    range = parseRange(req.headers.range, fileSize);
    if (!range) return send(res, 416, 'Range not satisfiable', { 'Content-Range': `bytes */${fileSize}` });
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${fileSize}`, 'Content-Length': range.end - range.start + 1 });
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': fileSize });
  }

  pipeline(fs.createReadStream(filePath, range), res, (err) => {
    // Seeks abort in-flight requests all the time; only real read errors are worth a line.
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') log(`[MediaServer] Stream error: ${err.message}`);
  });
}

let mediaPort = 0;

function startMediaServer() {
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      log(`[MediaServer] Error: ${err.message}`);
      if (res.headersSent) res.destroy();
      else send(res, 500, 'Internal error');
    });
  });

  server.listen(0, '127.0.0.1', () => {
    mediaPort = server.address().port;
    log(`[MediaServer] Listening on port ${mediaPort}`);
  });

  return server;
}

function getMediaPort() { return mediaPort; }
function getMediaToken() { return mediaToken; }

module.exports = {
  init,
  startMediaServer,
  getMediaPort,
  getMediaToken,
};
