'use strict';

// ── FL Studio project (.flp) import ─────────────────────────────────────────
// Reads the notes of an FL Studio project straight from the .flp and writes
// them out as a Standard MIDI File, so the existing MIDI import pipeline
// (dialog, sample auto-match, re-import, per-row note-length clamps, the
// engine's MidiImporter) handles an FLP exactly like a .mid — no FL-side MIDI
// export needed.
//
// Port of the FLP reader in the "FLP to Video" VEGAS script (source/flp2json.py,
// which uses PyFLP with FL 25/26 fixes). Same rules:
//
// Ported from FLP-to-Video by Krasen (composition-cassidy), contributed under AGPL-3.0-or-later.
// Parsing approach based on PyFLP (GPL-3.0, github.com/demberto/PyFLP).
//   - FLP-to-Video (source/flp2json.py): https://github.com/composition-cassidy/FLP-to-Video
//   - PyFLP: https://github.com/demberto/PyFLP, Copyright (c) demberto and PyFLP contributors
//     (GPL-3.0, compatible with AGPL-3.0 under GPLv3 section 13).
//
// Reading rules:
//   • the playlist is the source of truth: each pattern clip places its notes,
//     honouring the clip's start/end trim; muted clips and disabled playlist
//     tracks are skipped (unless includeMuted);
//   • step-sequencer hits (length 0) last until the channel's next hit, the
//     last one a quarter note;
//   • slide notes don't start a new note — they extend the note they glide from;
//   • playlist audio clips become one note (key 60) per clip on their channel;
//   • tempo automation clips become MIDI tempo events;
//   • a project with nothing in the playlist (pattern mode) imports one
//     pattern at the start: the selected one unless another is asked for.
//
// One MIDI track per FL channel, named after the channel, so a row's name
// matches sample regions named after FL channels or sample files.
//
// Pure Node (no electron import): unit-tested by flp-import.test.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PATTERN_BASE = 20480;
const TEMPO_TARGET = 0x40000005;        // automation link target: the project tempo
const TEMPO_MIN = 60.0, TEMPO_MAX = 180.0; // FL's tempo automation range
const CLIP_MUTED = 0x2000;
const NOTE_SLIDE_FLAG = 0x08;
const SIZE_OVERRIDES = { 172: 1 };      // FL 26: id 172 carries 1 byte, not 4
const CLIP_KEY = 60;                    // key for audio-clip hits (C5 in FL)

const EV = {
  CHANNEL_TYPE: 21,
  CHANNEL_NEW: 64,
  PATTERN_NEW: 65,
  PATTERN_SELECTED: 67,
  ARR_NEW: 99,
  ARR_CURRENT: 100,
  TEMPO: 156,
  CHANNEL_NAME_OLD: 192,
  PATTERN_NAME: 193,
  SAMPLE_PATH: 196,
  FL_VERSION: 199,
  PLUGIN_INTERNAL_NAME: 201,
  PLUGIN_NAME: 203,
  NOTES: 224,
  LINK: 227,
  PLAYLIST: 233,
  AUTOMATION: 234,
  TRACK_DATA: 238,
  TRACK_NAME: 239,
  ARR_NAME: 241,
};

const CHANNEL_KIND = { 0: 'sampler', 2: 'native', 3: 'layer', 4: 'instrument', 5: 'automation' };

class FlpError extends Error {}

// ── Raw event stream ────────────────────────────────────────────────────────

function readEvents(buf) {
  if (buf.length < 22 || buf.toString('latin1', 0, 4) !== 'FLhd' || buf.toString('latin1', 14, 18) !== 'FLdt') {
    throw new FlpError("This isn't an FL Studio project file.");
  }
  const events = [];
  let p = 22;
  const end = buf.length;
  while (p < end) {
    const id = buf[p++];
    let v;
    if (SIZE_OVERRIDES[id] != null) {
      const n = SIZE_OVERRIDES[id];
      v = n === 1 ? buf[p] : buf.readUIntLE(p, n);
      p += n;
    } else if (id < 64) {
      v = buf[p]; p += 1;
    } else if (id < 128) {
      v = buf.readUInt16LE(p); p += 2;
    } else if (id < 192) {
      v = buf.readUInt32LE(p); p += 4;
    } else {
      let n = 0, sh = 0;
      for (;;) {
        const b = buf[p++];
        n += (b & 0x7f) * 2 ** sh; sh += 7;
        if (!(b & 0x80)) break;
      }
      v = buf.subarray(p, p + n); p += n;
    }
    if (p > end) break;  // truncated tail: keep what parsed cleanly
    events.push([id, v]);
  }
  return events;
}

function text(v, unicode) {
  if (!Buffer.isBuffer(v)) return '';
  const s = unicode ? v.toString('utf16le') : v.toString('latin1');
  return s.replace(/\0+$/, '').replace(/\0.*$/s, '');
}

// ── Project pieces ──────────────────────────────────────────────────────────

function readHeader(buf) {
  return {
    format: buf.readInt16LE(8),
    channelCount: buf.readUInt16LE(10),
    ppq: buf.readUInt16LE(12) || 96,
  };
}

// Channels: name, kind, sample path; automation points for tempo-linked ones.
// The channel section runs from the first CHANNEL_NEW to the first arrangement;
// plugin names after that belong to mixer slots, not channels.
function readChannels(events, unicode) {
  const channels = new Map();
  let cur = null;
  for (const [id, v] of events) {
    if (id === EV.ARR_NEW) break;
    if (id === EV.CHANNEL_NEW) {
      cur = { iid: v, name: '', defaultName: '', kind: 'unknown', sample: null, automation: null };
      channels.set(v, cur);
      continue;
    }
    if (!cur) continue;
    switch (id) {
      case EV.CHANNEL_TYPE: cur.kind = CHANNEL_KIND[v] || 'unknown'; break;
      case EV.PLUGIN_NAME:
      case EV.CHANNEL_NAME_OLD: { const t = text(v, unicode); if (t && !cur.name) cur.name = t; break; }
      case EV.PLUGIN_INTERNAL_NAME: if (!cur.defaultName) cur.defaultName = text(v, unicode); break;
      case EV.SAMPLE_PATH: cur.sample = text(v, unicode) || null; break;
      case EV.AUTOMATION: cur.automation = readAutomationPoints(v); break;
      default: break;
    }
  }
  for (const ch of channels.values()) {
    if (!ch.name) {
      const base = ch.sample ? path.win32.basename(ch.sample).replace(/\.[^.]+$/, '') : '';
      ch.name = base || ch.defaultName || `Channel ${ch.iid + 1}`;
    }
  }
  return channels;
}

// [{ beat, value (0..1), tension }] — positions are cumulative offsets in beats.
function readAutomationPoints(v) {
  if (!Buffer.isBuffer(v) || v.length < 21) return null;
  const count = v.readUInt32LE(17);
  const pts = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    const o = 21 + i * 24;
    if (o + 24 > v.length) break;
    pos += v.readDoubleLE(o);
    pts.push({ beat: pos, value: v.readDoubleLE(o + 8), tension: v.readFloatLE(o + 16) });
  }
  pts.sort((a, b) => a.beat - b.beat);
  return pts.length ? pts : null;
}

// { patternIid: [{ pos, len, key, vel, flags, chan }] } — the last notes event
// of a pattern wins.
function readPatterns(events, unicode) {
  const notes = new Map();
  const names = new Map();
  let cur = null;
  for (const [id, v] of events) {
    if (id === EV.PATTERN_NEW) {
      cur = v;
      if (!notes.has(cur)) notes.set(cur, []);
    } else if (cur == null) {
      continue;
    } else if (id === EV.PATTERN_NAME) {
      const t = text(v, unicode);
      if (t) names.set(cur, t);
    } else if (id === EV.NOTES && Buffer.isBuffer(v)) {
      const list = [];
      for (let i = 0; i + 24 <= v.length; i += 24) {
        list.push({
          pos: v.readUInt32LE(i),
          flags: v.readUInt16LE(i + 4),
          chan: v.readUInt16LE(i + 6),
          len: v.readUInt32LE(i + 8),
          key: v.readUInt16LE(i + 12),
          vel: v[i + 21],
        });
      }
      notes.set(cur, list);
    }
  }
  return { notes, names };
}

// Playlist records grew with FL: 32 bytes up to FL 20, 60 in FL 21-24, 80 in
// FL 25 and 88 in FL 26. A payload's length can divide by more than one size
// (8640 bytes of FL 20.7 records divides by 60 and 32), so the size is the
// candidate whose records decode sanely (position and length below 2^28
// ticks, length > 0, a track index in 0..499), preferring the larger on a tie.
const PLAYLIST_ITEM_SIZES = [88, 80, 60, 32];
const TICK_LIMIT = 2 ** 28;
function playlistItemSize(v) {
  let best = 32, bestScore = -1;
  for (const size of PLAYLIST_ITEM_SIZES) {
    if (v.length % size !== 0) continue;
    let sane = 0, count = 0;
    for (let i = 0; i + size <= v.length; i += size) {
      count++;
      const pos = v.readUInt32LE(i);
      const len = v.readUInt32LE(i + 8);
      const track = 499 - v.readUInt16LE(i + 12);
      if (pos < TICK_LIMIT && len > 0 && len < TICK_LIMIT && track >= 0 && track <= 499) sane++;
    }
    const score = count ? sane / count : 0;
    if (score > bestScore + 1e-9) { best = size; bestScore = score; }
  }
  return best;
}

function readArrangements(events, unicode) {
  const arrs = [];
  let cur = null, current = null, lastTrack = null;
  for (const [id, v] of events) {
    if (id === EV.ARR_CURRENT) { current = v; continue; }
    if (id === EV.ARR_NEW) {
      cur = { iid: v, name: '', items: [], tracks: new Map() };
      arrs.push(cur);
      lastTrack = null;
      continue;
    }
    if (!cur) continue;
    if (id === EV.ARR_NAME) {
      cur.name = text(v, unicode) || cur.name;
    } else if (id === EV.PLAYLIST && Buffer.isBuffer(v)) {
      const size = playlistItemSize(v);
      for (let i = 0; i + size <= v.length; i += size) {
        cur.items.push({
          pos: v.readUInt32LE(i),
          idx: v.readUInt16LE(i + 6),
          len: v.readUInt32LE(i + 8),
          track: 499 - v.readUInt16LE(i + 12),
          muted: !!(v.readUInt16LE(i + 18) & CLIP_MUTED),
          offI: [v.readInt32LE(i + 24), v.readInt32LE(i + 28)],
          offF: [v.readFloatLE(i + 24), v.readFloatLE(i + 28)],
        });
      }
    } else if (id === EV.TRACK_DATA && Buffer.isBuffer(v) && v.length >= 13) {
      lastTrack = { enabled: !!v[12], name: '' };
      cur.tracks.set(v.readUInt32LE(0) - 1, lastTrack);
    } else if (id === EV.TRACK_NAME && lastTrack) {
      lastTrack.name = text(v, unicode);
    }
  }
  arrs.forEach((a, i) => {
    a.current = a.iid === current;
    if (!a.name) a.name = arrs.length > 1 ? `Arrangement ${i + 1}` : 'Arrangement';
  });
  if (arrs.length && !arrs.some(a => a.current)) arrs[0].current = true;
  return arrs;
}

function tempoChannels(events) {
  const chans = new Set();
  for (const [id, v] of events) {
    if (id === EV.LINK && Buffer.isBuffer(v) && v.length >= 12 && v.readUInt32LE(8) === TEMPO_TARGET) {
      chans.add(v.readUInt16LE(2));
    }
  }
  return chans;
}

// Approximation of FL's "single curve" automation segment (x in 0..1).
function curve(y0, y1, x, tension) {
  if (Math.abs(tension) > 1e-6) {
    x = tension < 0 ? x ** (2 ** (-3 * tension)) : 1 - (1 - x) ** (2 ** (3 * tension));
  }
  return y0 + (y1 - y0) * x;
}

function automationValue(points, beat) {
  if (beat <= points[0].beat) return points[0].value;
  for (let i = 1; i < points.length; i++) {
    const p1 = points[i];
    if (beat < p1.beat) {
      const p0 = points[i - 1];
      if (p1.beat - p0.beat <= 1e-9) return p1.value;
      return curve(p0.value, p1.value, (beat - p0.beat) / (p1.beat - p0.beat), p1.tension);
    }
  }
  return points[points.length - 1].value;
}

const trackOn = (arr, track) => arr.tracks.get(track)?.enabled !== false;

// Piecewise-constant [[tick, bpm]] from the arrangement's tempo automation.
function tempoMap(arr, baseBpm, tempoPoints, ppq, songEnd) {
  const clips = [];
  for (const it of arr.items) {
    if (!tempoPoints.has(it.idx) || it.muted || !trackOn(arr, it.track)) continue;
    const so = it.offF[0];
    clips.push({ start: it.pos, end: it.pos + it.len, startBeat: Number.isFinite(so) && so >= 0 ? so : 0, pts: tempoPoints.get(it.idx) });
  }
  if (!clips.length) return [[0, baseBpm]];
  clips.sort((a, b) => a.start - b.start);

  const bpmAt = (tick) => {
    let active = null;
    for (const c of clips) { if (c.start <= tick) active = c; else break; }
    const v = active
      ? automationValue(active.pts, active.startBeat + (Math.min(tick, active.end) - active.start) / ppq)
      : automationValue(clips[0].pts, clips[0].startBeat);
    return TEMPO_MIN + v * (TEMPO_MAX - TEMPO_MIN);
  };

  const step = Math.max(1, Math.floor(ppq / 16));
  const last = Math.max(songEnd, clips[clips.length - 1].end);
  const out = [];
  let prev = null;
  for (let tick = 0; tick <= last + step; tick += step) {
    const bpm = Math.round(bpmAt(tick) * 10000) / 10000;
    if (prev == null || Math.abs(bpm - prev) > 1e-3) { out.push([tick, bpm]); prev = bpm; }
  }
  return out;
}

// ── Parse ───────────────────────────────────────────────────────────────────

// Returns everything the converter needs, per arrangement:
//   { version, ppq, bpm, arrangements: [{ name, current, tempo, mutedTracks,
//     mutedClips, parts: [{ id, channel, name, kind: 'notes'|'clips', sample,
//     items: [{ start, end, key, vel, step, slide, muted }] }] }] }
function parseFlp(buf) {
  const events = readEvents(buf);
  const { ppq } = readHeader(buf);

  let version = '';
  for (const [id, v] of events) {
    if (id === EV.FL_VERSION) { version = text(v, false); break; }
  }
  const vparts = version.split('.').map(n => parseInt(n, 10) || 0);
  const unicode = vparts[0] > 11 || (vparts[0] === 11 && vparts[1] >= 5);

  let bpm = 120;
  for (const [id, v] of events) {
    if (id === EV.TEMPO) { bpm = v / 1000; break; }
  }

  const channels = readChannels(events, unicode);
  const linked = tempoChannels(events);
  const tempoPoints = new Map();
  for (const ch of channels.values()) {
    if (ch.kind === 'automation' && linked.has(ch.iid) && ch.automation) tempoPoints.set(ch.iid, ch.automation);
  }
  const { notes: patterns, names: patternNames } = readPatterns(events, unicode);
  const arrangements = readArrangements(events, unicode);
  const hasPatternNotes = [...patterns.values()].some(list => list.length > 0);
  if (!arrangements.length) {
    if (!hasPatternNotes) throw new FlpError('The project has no playlist arrangement.');
    arrangements.push({ iid: 0, name: 'Arrangement', items: [], tracks: new Map(), current: true });
  }
  let selectedPattern = null;
  for (const [id, v] of events) {
    if (id === EV.PATTERN_SELECTED) { selectedPattern = v; break; }
  }

  const channelInfo = (iid) => channels.get(iid)
    || { iid, name: `Channel ${iid + 1}`, kind: 'unknown', sample: null };

  const out = arrangements.map(arr => {
    const parts = new Map();
    const part = (iid, kind) => {
      const key = `${iid}:${kind}`;
      if (!parts.has(key)) {
        const ch = channelInfo(iid);
        parts.set(key, { id: key, channel: iid, name: ch.name, kind, sample: ch.sample, items: [] });
      }
      return parts.get(key);
    };

    let songEnd = 0;
    const mutedTracks = new Set();
    let mutedClips = 0;
    for (const it of arr.items) {
      const on = trackOn(arr, it.track);
      const muted = it.muted || !on;
      if (!on) mutedTracks.add(it.track);
      else if (it.muted) mutedClips++;
      songEnd = Math.max(songEnd, it.pos + it.len);

      if (it.idx > PATTERN_BASE) {                         // pattern clip
        const list = patterns.get(it.idx - PATTERN_BASE) || [];
        let [so, eo] = it.offI;
        if (so < 0 || eo < 0) { so = 0; eo = it.len; }
        for (const n of list) {
          if (n.pos < so || n.pos >= eo) continue;
          const start = it.pos + n.pos - so;
          const end = Math.min(start + n.len, it.pos + it.len);
          part(n.chan, 'notes').items.push({
            start, end, key: n.key, vel: n.vel,
            step: n.len === 0, slide: !!(n.flags & NOTE_SLIDE_FLAG), muted,
          });
        }
      } else {                                             // audio / automation clip
        const ch = channels.get(it.idx);
        if (!ch || ch.kind === 'automation') continue;
        part(it.idx, 'clips').items.push({
          start: it.pos, end: it.pos + it.len, key: CLIP_KEY, vel: 100,
          step: false, slide: false, muted,
        });
      }
    }

    const outParts = [...parts.values()]
      .filter(p => p.items.length)
      .sort((a, b) => a.channel - b.channel || (a.kind < b.kind ? 1 : -1));
    for (const p of outParts) p.items.sort((a, b) => a.start - b.start || a.end - b.end);

    const trackName = (t) => arr.tracks.get(t)?.name || `Track ${t + 1}`;
    return {
      name: arr.name,
      current: arr.current,
      tempo: tempoMap(arr, bpm, tempoPoints, ppq, songEnd),
      mutedTracks: [...mutedTracks].sort((a, b) => a - b).map(trackName),
      mutedClips,
      parts: outParts,
    };
  });

  // Pattern mode: the non-empty patterns, in FL order, for the fallback.
  const patternList = [...patterns.entries()]
    .filter(([, list]) => list.length > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([iid, list]) => ({ iid, name: patternNames.get(iid) || `Pattern ${iid}`, noteCount: list.length }));

  return { version, ppq, bpm, arrangements: out, patterns, patternNames, patternList, selectedPattern, channelInfo };
}

// One pattern laid out from tick 0, as playlist parts (pattern mode).
function patternParts(proj, iid) {
  const parts = new Map();
  for (const n of proj.patterns.get(iid) || []) {
    const key = `${n.chan}:notes`;
    if (!parts.has(key)) {
      const ch = proj.channelInfo(n.chan);
      parts.set(key, { id: key, channel: n.chan, name: ch.name, kind: 'notes', sample: ch.sample, items: [] });
    }
    parts.get(key).items.push({
      start: n.pos, end: n.pos + n.len, key: n.key, vel: n.vel,
      step: n.len === 0, slide: !!(n.flags & NOTE_SLIDE_FLAG), muted: false,
    });
  }
  const out = [...parts.values()].sort((a, b) => a.channel - b.channel);
  for (const p of out) p.items.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}

// ── Notes → MIDI tracks ─────────────────────────────────────────────────────

// Applies the FLP note rules to one part and returns plain MIDI notes
// [{ start, end, key, vel }] (FL velocity 0..128 → MIDI 1..127).
function partToMidiNotes(part, { includeMuted = false, ppq = 96 } = {}) {
  const items = part.items.filter(n => includeMuted || !n.muted);
  const notes = [];
  const slides = [];
  for (const n of items) {
    if (part.kind === 'notes' && n.slide) { slides.push(n); continue; }
    notes.push({ start: n.start, end: n.end, key: n.key, vel: n.vel, step: n.step });
  }
  // A slide extends the note sounding when it starts (one starting on the same
  // tick counts) instead of starting a new note.
  for (const s of slides) {
    let owner = null;
    for (const n of notes) { if (n.start > s.start) break; owner = n; }
    if (owner && s.end > owner.end) owner.end = s.end;
  }
  // Step hits last until the channel's next hit; the last one a quarter note.
  const starts = [...new Set(notes.map(n => n.start))].sort((a, b) => a - b);
  const nextStart = (t) => {
    let lo = 0, hi = starts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= t) lo = mid + 1; else hi = mid; }
    return lo < starts.length ? starts[lo] : null;
  };
  for (const n of notes) {
    if (n.step) {
      const next = nextStart(n.start);
      n.end = next != null ? next : n.start + ppq;
    }
    if (n.end <= n.start) n.end = n.start + 1;
  }
  // MIDI can't overlap two notes of the same key on one channel: dedupe exact
  // repeats and cut an earlier note where the next one of its key starts.
  const out = [];
  const byKey = new Map();
  for (const n of notes) {
    if (n.key > 127) continue;
    const prev = byKey.get(n.key);
    if (prev && prev.start === n.start) {
      prev.end = Math.max(prev.end, n.end);
      prev.vel = Math.max(prev.vel, n.vel);
      continue;
    }
    if (prev && prev.end > n.start) prev.end = n.start;
    const m = { start: n.start, end: n.end, key: n.key, vel: n.vel };
    byKey.set(n.key, m);
    out.push(m);
  }
  for (const m of out) m.vel = Math.max(1, Math.min(127, Math.round(m.vel * 127 / 128)));
  return out;
}

// ── Standard MIDI File writer ───────────────────────────────────────────────

function vlq(n) {
  const bytes = [n & 0x7f];
  n = Math.floor(n / 128);
  while (n > 0) { bytes.unshift((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  return bytes;
}

function trackChunk(events) {
  // events: [{ tick, order, bytes }] — order breaks same-tick ties (off before on).
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const data = [];
  let last = 0;
  for (const e of events) {
    data.push(...vlq(Math.max(0, e.tick - last)), ...e.bytes);
    last = Math.max(last, e.tick);
  }
  data.push(0x00, 0xff, 0x2f, 0x00);
  const header = Buffer.alloc(8);
  header.write('MTrk', 0, 'latin1');
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, Buffer.from(data)]);
}

function metaText(type, str) {
  const b = Buffer.from(str, 'utf8');
  return [0xff, type, ...vlq(b.length), ...b];
}

// tracks: [{ name, notes: [{ start, end, key, vel }] }]; tempo: [[tick, bpm]]
function writeMidi({ ppq, tempo, tracks }) {
  const conductor = [];
  conductor.push({ tick: 0, order: 0, bytes: [0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08] });
  for (const [tick, bpm] of tempo) {
    const us = Math.max(1, Math.min(0xffffff, Math.round(60000000 / bpm)));
    conductor.push({ tick, order: 1, bytes: [0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff] });
  }
  const chunks = [trackChunk(conductor)];
  for (const t of tracks) {
    const ev = [{ tick: 0, order: -1, bytes: metaText(0x03, t.name) }];
    for (const n of t.notes) {
      ev.push({ tick: n.start, order: 1, bytes: [0x90, n.key, n.vel] });
      ev.push({ tick: n.end, order: 0, bytes: [0x80, n.key, 0x40] });
    }
    chunks.push(trackChunk(ev));
  }
  const head = Buffer.alloc(14);
  head.write('MThd', 0, 'latin1');
  head.writeUInt32BE(6, 4);
  head.writeUInt16BE(1, 8);
  head.writeUInt16BE(chunks.length, 10);
  head.writeUInt16BE(Math.max(1, Math.min(0x7fff, ppq)), 12);
  return Buffer.concat([head, ...chunks]);
}

// ── Conversion entry point ──────────────────────────────────────────────────

// Builds the MIDI for one arrangement. Returns { midi: Buffer, info } where info
// is what the dialog shows: arrangements, muted counts, track list.
function convertFlp(buf, { arrangementIndex = null, includeMuted = false, patternIid = null } = {}) {
  const proj = parseFlp(buf);
  let ai = Number.isInteger(arrangementIndex) && arrangementIndex >= 0 && arrangementIndex < proj.arrangements.length
    ? arrangementIndex
    : proj.arrangements.findIndex(a => a.current);
  if (ai < 0) ai = 0;
  const arr = proj.arrangements[ai];

  // Nothing placed in this arrangement's playlist (not even muted clips):
  // import one pattern from tick 0 instead.
  let pattern = null;
  let parts = arr.parts;
  if (!parts.length && proj.patternList.length) {
    pattern = proj.patternList.find(x => x.iid === patternIid)
      || proj.patternList.find(x => x.iid === proj.selectedPattern)
      || proj.patternList[0];
    parts = patternParts(proj, pattern.iid);
  }

  // Two parts of one channel (notes + audio clips) need distinct row names.
  const notesChannels = new Set(parts.filter(p => p.kind === 'notes').map(p => p.channel));
  const used = new Map();
  const tracks = [];
  let mutedNotes = 0;
  for (const p of parts) {
    mutedNotes += p.items.filter(n => n.muted).length;
    const notes = partToMidiNotes(p, { includeMuted, ppq: proj.ppq });
    if (!notes.length) continue;
    let name = p.kind === 'clips' && notesChannels.has(p.channel) ? `${p.name} (audio clips)` : p.name;
    const n = (used.get(name) || 0) + 1;
    used.set(name, n);
    if (n > 1) name = `${name} ${n}`;
    tracks.push({ name, channel: p.channel, kind: p.kind, notes });
  }

  // The engine reads one tempo; the dialog says so when the map has more.
  const tempo = pattern ? [[0, proj.bpm]] : arr.tempo;
  const midi = writeMidi({ ppq: proj.ppq, tempo, tracks });
  return {
    midi,
    info: {
      version: proj.version,
      ppq: proj.ppq,
      bpm: proj.bpm,
      startBpm: tempo[0]?.[1] ?? proj.bpm,
      hasTempoAutomation: tempo.length > 1,
      arrangementIndex: ai,
      // Pattern mode: which pattern was imported, and the ones to pick from.
      pattern: pattern ? { iid: pattern.iid, name: pattern.name } : null,
      patterns: pattern ? proj.patternList.map(x => ({ iid: x.iid, name: x.name })) : [],
      arrangements: proj.arrangements.map((a, i) => ({ index: i, name: a.name, current: a.current })),
      includeMuted: !!includeMuted,
      mutedTracks: arr.mutedTracks,
      mutedClips: arr.mutedClips,
      mutedNotes,
      audioClipTracks: tracks.filter(t => t.kind === 'clips').length,
      tracks: tracks.map(t => ({ name: t.name, kind: t.kind, noteCount: t.notes.length })),
    },
  };
}

// Reads the .flp, writes the MIDI into a temp folder and returns its path plus
// the info block. Result shape mirrors midi.parseSummary: { ok, reason? }.
function convertFlpFile(flpPath, options = {}, { tempDir = path.join(os.tmpdir(), 'xleth-flp-import') } = {}) {
  try {
    const buf = fs.readFileSync(flpPath);
    const { midi, info } = convertFlp(buf, options);
    if (!info.tracks.length) {
      const why = info.mutedNotes > 0 && !info.includeMuted
        ? 'Every note in this arrangement is muted. Tick "Include muted tracks and clips" to import them.'
        : 'This project has no notes: the playlist is empty and so are its patterns.';
      return { ok: false, reason: why, info };
    }
    fs.mkdirSync(tempDir, { recursive: true });
    const hash = crypto.createHash('sha1').update(path.resolve(flpPath)).digest('hex').slice(0, 10);
    const base = path.basename(flpPath).replace(/\.flp$/i, '').replace(/[^\w .()&-]+/g, '_');
    const variant = `a${info.arrangementIndex}${info.pattern ? `-p${info.pattern.iid}` : ''}${info.includeMuted ? '-m' : ''}`;
    const midiPath = path.join(tempDir, `${base}-${hash}-${variant}.mid`);
    fs.writeFileSync(midiPath, midi);
    return { ok: true, midiPath, info };
  } catch (e) {
    const reason = e instanceof FlpError ? e.message : `Couldn't read the FL Studio project: ${e.message}`;
    return { ok: false, reason };
  }
}

module.exports = {
  FlpError,
  readEvents,
  parseFlp,
  partToMidiNotes,
  writeMidi,
  convertFlp,
  convertFlpFile,
};
