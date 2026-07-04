'use strict';

// ── Local HTTP media server for <video> elements ─────────────────────────────
// Chromium blocks custom protocols for <video>/<audio> src. A local HTTP server
// with proper Range support lets the browser's hardware video decoder work.
//
// Extracted verbatim from ui/main.js (S5 Stage 1 decomposition). main.js wires
// it in via init({ log }) so logging still lands in the shared startup.log; the
// bound port is exposed via getMediaPort() for the xleth:getMediaPort handler.

const path = require('path');
const fs = require('fs');
const http = require('http');

// Injected by main.js (init) — the shared startup.log logger.
let log = (msg) => { process.stdout.write(String(msg) + '\n'); };

function init(deps) {
  if (deps && typeof deps.log === 'function') log = deps.log;
}

let mediaPort = 0;

function startMediaServer() {
  const MIME_TYPES = {
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska', '.webm': 'video/webm',
    '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac',
    '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  };

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const filePath = decodeURIComponent(url.searchParams.get('path') || '');

      if (!filePath || !fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const range = req.headers.range;

      if (range) {
        const match = range.match(/bytes=(\d+)-(\d*)/);
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : Math.min(start + 1024 * 1024, fileSize - 1);
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
          'Cross-Origin-Resource-Policy': 'cross-origin',
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          'Accept-Ranges': 'bytes',
          'Content-Length': fileSize,
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
          'Cross-Origin-Resource-Policy': 'cross-origin',
        });
        fs.createReadStream(filePath).pipe(res);
      }
    } catch (err) {
      log(`[MediaServer] Error: ${err.message}`);
      res.writeHead(500);
      res.end('Internal error');
    }
  });

  server.listen(0, '127.0.0.1', () => {
    mediaPort = server.address().port;
    log(`[MediaServer] Listening on port ${mediaPort}`);
  });

  return server;
}

function getMediaPort() { return mediaPort; }

module.exports = {
  init,
  startMediaServer,
  getMediaPort,
};
