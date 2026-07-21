// Loop Lab export — pure(ish) dataset-building logic, factored out of main.js so
// it can be unit-tested without Electron. The renderer authors gold loops in the
// ENGINE-BUFFER sample domain (what the sampler preview uses); this module reads
// each original WAV's true header and converts those loop points into the FILE
// sample domain so dataset.json is self-consistent with the untouched WAV that
// ships beside it. See docs/loop-lab-codepath-report.md §6.

const fs = require('fs');
const path = require('path');

// Parse a canonical RIFF/WAVE header. Returns { sampleRate, channels, numFrames,
// bitsPerSample, durationSec } or null if not a readable PCM/float WAV. Walks
// chunks (so JUNK/LIST before 'data' is fine). Reads the header only.
function parseWavHeader(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(12);
    if (fs.readSync(fd, head, 0, 12, 0) < 12) return null;
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return null;

    const { size } = fs.fstatSync(fd);
    let pos = 12;
    let fmt = null;
    let dataSize = null;
    const chunkHdr = Buffer.alloc(8);
    while (pos + 8 <= size) {
      if (fs.readSync(fd, chunkHdr, 0, 8, pos) < 8) break;
      const id = chunkHdr.toString('ascii', 0, 4);
      const csize = chunkHdr.readUInt32LE(4);
      if (id === 'fmt ') {
        const fmtBuf = Buffer.alloc(Math.min(16, csize));
        fs.readSync(fd, fmtBuf, 0, fmtBuf.length, pos + 8);
        fmt = {
          audioFormat: fmtBuf.readUInt16LE(0),
          channels: fmtBuf.readUInt16LE(2),
          sampleRate: fmtBuf.readUInt32LE(4),
          bitsPerSample: fmtBuf.length >= 16 ? fmtBuf.readUInt16LE(14) : 16,
        };
      } else if (id === 'data') {
        dataSize = csize;
        if (fmt) break;
      }
      pos += 8 + csize + (csize & 1);
    }
    if (!fmt || dataSize == null) return null;
    const blockAlign = Math.max(1, (fmt.bitsPerSample >> 3) * fmt.channels);
    const numFrames = Math.floor(dataSize / blockAlign);
    return {
      sampleRate: fmt.sampleRate,
      channels: fmt.channels,
      bitsPerSample: fmt.bitsPerSample,
      numFrames,
      durationSec: fmt.sampleRate > 0 ? numFrames / fmt.sampleRate : 0,
    };
  } catch {
    return null;
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch {} }
  }
}

// Filesystem-safe path segment (keeps spaces/hyphens for readable corpus paths).
function sanitizeSegment(name) {
  return String(name == null ? '' : name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '') || 'unnamed';
}

// Convert engine-buffer-domain gold loop points to the file's sample domain.
// ratio == 1 when file rate already matches the engine rate (the common case).
function convertGold(gold, engineSampleRate, hdr) {
  const engRate = Number(engineSampleRate) > 0 ? Number(engineSampleRate) : hdr.sampleRate;
  const ratio = hdr.sampleRate / engRate;
  const clampF = (v) => Math.max(0, Math.min(hdr.numFrames, Math.round((Number(v) || 0) * ratio)));
  return {
    start: clampF(gold && gold.start),
    end: clampF(gold && gold.end),
    xfade: Math.max(0, Math.round(((gold && Number(gold.xfade)) || 0) * ratio)),
  };
}

// Build the dataset array + the list of { src, name } zip entries. Throws on a
// missing or unreadable source WAV. Reads each WAV header for authoritative
// rate/channels/frame-count. Ensures unique sample_ids and zip paths.
function buildDataset(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    const e = new Error('No samples to export.'); e.code = 'EMPTY'; throw e;
  }
  const dataset = [];
  const zipEntries = [];
  const usedIds = new Set();
  const usedZipPaths = new Set();

  for (const s of samples) {
    if (!s || !s.filePath || !fs.existsSync(s.filePath)) {
      const e = new Error(`Missing source WAV: ${s && s.filePath}`); e.code = 'MISSING'; throw e;
    }
    const hdr = parseWavHeader(s.filePath);
    if (!hdr) { const e = new Error(`Not a readable WAV: ${s.filePath}`); e.code = 'BADWAV'; throw e; }

    const gold = convertGold(s.gold || {}, s.engineSampleRate, hdr);

    const classSeg = sanitizeSegment(s.className);
    const nameSeg = sanitizeSegment(s.name);
    const segs = ['corpus', classSeg];
    if (s.instrumentName) segs.push(sanitizeSegment(s.instrumentName));
    let zipPath = `${segs.join('/')}/${nameSeg}.wav`;
    let n = 1;
    while (usedZipPaths.has(zipPath.toLowerCase())) {
      zipPath = `${segs.join('/')}/${nameSeg}_${n++}.wav`;
    }
    usedZipPaths.add(zipPath.toLowerCase());
    zipEntries.push({ src: s.filePath, name: zipPath });

    let baseSid = nameSeg.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'sample';
    let sid = baseSid;
    let m = 1;
    while (usedIds.has(sid)) sid = `${baseSid}_${m++}`;
    usedIds.add(sid);

    dataset.push({
      sample_id: sid,
      file: zipPath,
      class: s.className == null ? null : s.className,
      instrument_name: s.instrumentName || null,
      behavior_family: s.behaviorFamily == null ? null : s.behaviorFamily,
      source: s.source == null ? '' : s.source,
      root_note: (s.rootNote === 0 || s.rootNote) ? Number(s.rootNote) : null,
      sample_rate: hdr.sampleRate,
      channels: hdr.channels,
      num_samples: hdr.numFrames,
      gold_loop: gold,
      measured_features: null,
    });
  }
  return { dataset, zipEntries };
}

module.exports = { parseWavHeader, sanitizeSegment, convertGold, buildDataset, path };
