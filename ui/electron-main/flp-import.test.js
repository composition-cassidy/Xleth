import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import flp from './flp-import.js';

const { readEvents, parseFlp, partToMidiNotes, writeMidi, convertFlp, convertFlpFile } = flp;

// ── Synthetic .flp builder ───────────────────────────────────────────────────
// Just enough of the FL event stream for the reader: version, tempo, one or
// more patterns with notes, channels with names, arrangements with playlist
// items and track records.

function ev(id, value) {
  if (id < 64) return Buffer.from([id, value & 0xff]);
  if (id < 128) { const b = Buffer.alloc(3); b[0] = id; b.writeUInt16LE(value, 1); return b; }
  if (id < 192) { const b = Buffer.alloc(5); b[0] = id; b.writeUInt32LE(value >>> 0, 1); return b; }
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const len = [];
  let n = data.length;
  do { let byte = n & 0x7f; n >>= 7; if (n) byte |= 0x80; len.push(byte); } while (n);
  return Buffer.concat([Buffer.from([id, ...len]), data]);
}
const utf16 = (s) => Buffer.from(s + '\0', 'utf16le');

function notesData(notes) {
  const b = Buffer.alloc(24 * notes.length);
  notes.forEach((n, i) => {
    const o = i * 24;
    b.writeUInt32LE(n.pos, o);
    b.writeUInt16LE(n.flags || 0, o + 4);
    b.writeUInt16LE(n.chan, o + 6);
    b.writeUInt32LE(n.len, o + 8);
    b.writeUInt16LE(n.key ?? 60, o + 12);
    b[o + 21] = n.vel ?? 100;
  });
  return b;
}

function playlistData(items, size = 88) {
  const b = Buffer.alloc(size * items.length);
  items.forEach((it, i) => {
    const o = i * size;
    b.writeUInt32LE(it.pos, o);
    b.writeUInt16LE(it.idx, o + 6);
    b.writeUInt32LE(it.len, o + 8);
    b.writeUInt16LE(499 - (it.track || 0), o + 12);
    b.writeUInt16LE(it.muted ? 0x2000 : 0, o + 18);
    if (it.offset) { b.writeInt32LE(it.offset[0], o + 24); b.writeInt32LE(it.offset[1], o + 28); }
    else { b.writeInt32LE(-1, o + 24); b.writeInt32LE(-1, o + 28); }
  });
  return b;
}

function trackData(iid, enabled) {
  const b = Buffer.alloc(13);
  b.writeUInt32LE(iid, 0);
  b[12] = enabled ? 1 : 0;
  return b;
}

function buildFlp({ ppq = 96, bpm = 140, patterns = {}, channels = [], arrangements = [] }) {
  const body = [ev(199, Buffer.from('26.1.5.5613\0', 'latin1')), ev(156, Math.round(bpm * 1000))];
  for (const [iid, notes] of Object.entries(patterns)) {
    body.push(ev(65, Number(iid)), ev(224, notesData(notes)));
  }
  for (const ch of channels) {
    body.push(ev(64, ch.iid), ev(21, ch.type ?? 0));
    if (ch.name) body.push(ev(203, utf16(ch.name)));
    if (ch.sample) body.push(ev(196, utf16(ch.sample)));
  }
  arrangements.forEach((a, i) => {
    body.push(ev(99, i));
    if (a.name) body.push(ev(241, utf16(a.name)));
    body.push(ev(233, playlistData(a.items, a.itemSize)));
    for (const t of a.tracks || []) {
      body.push(ev(238, trackData(t.iid, t.enabled)));
      if (t.name) body.push(ev(239, utf16(t.name)));
    }
  });
  if (arrangements.current != null) body.push(ev(100, arrangements.current));
  const data = Buffer.concat(body);
  const head = Buffer.alloc(22);
  head.write('FLhd', 0, 'latin1');
  head.writeUInt32LE(6, 4);
  head.writeInt16LE(0, 8);
  head.writeUInt16LE(channels.length, 10);
  head.writeUInt16LE(ppq, 12);
  head.write('FLdt', 14, 'latin1');
  head.writeUInt32LE(data.length, 18);
  return Buffer.concat([head, data]);
}

const PAT = 20480;

// ── Tiny MIDI reader, to check what writeMidi produced ───────────────────────
function readMidi(buf) {
  expect(buf.toString('latin1', 0, 4)).toBe('MThd');
  const ppq = buf.readUInt16BE(12);
  const trackCount = buf.readUInt16BE(10);
  const tracks = [];
  let p = 14;
  for (let t = 0; t < trackCount; t++) {
    expect(buf.toString('latin1', p, p + 4)).toBe('MTrk');
    const len = buf.readUInt32BE(p + 4);
    let q = p + 8;
    const end = q + len;
    let tick = 0;
    const track = { name: null, tempos: [], notes: [] };
    const open = new Map();
    while (q < end) {
      let d = 0, b;
      do { b = buf[q++]; d = d * 128 + (b & 0x7f); } while (b & 0x80);
      tick += d;
      const st = buf[q++];
      if (st === 0xff) {
        const type = buf[q++];
        let l = 0;
        do { b = buf[q++]; l = l * 128 + (b & 0x7f); } while (b & 0x80);
        const payload = buf.subarray(q, q + l);
        q += l;
        if (type === 0x03) track.name = payload.toString('utf8');
        if (type === 0x51) track.tempos.push([tick, 60000000 / payload.readUIntBE(0, 3)]);
      } else if ((st & 0xf0) === 0x90) {
        const key = buf[q++], vel = buf[q++];
        open.set(key, { start: tick, key, vel });
      } else if ((st & 0xf0) === 0x80) {
        const key = buf[q++]; q++;
        const n = open.get(key);
        open.delete(key);
        track.notes.push({ ...n, end: tick });
      }
    }
    tracks.push(track);
    p = end;
  }
  return { ppq, tracks };
}

describe('FLP event stream', () => {
  it('rejects files that are not FL projects', () => {
    expect(() => readEvents(Buffer.from('MThd not an flp at all......'))).toThrow(/FL Studio project/);
  });
});

describe('parseFlp', () => {
  const project = buildFlp({
    patterns: {
      1: [
        { pos: 0, len: 48, key: 64, chan: 0 },
        { pos: 96, len: 0, key: 60, chan: 1 },   // step hit
        { pos: 192, len: 0, key: 60, chan: 1 },
      ],
    },
    channels: [
      { iid: 0, name: 'Lead' },
      { iid: 1, sample: '%FLStudioUserData%\\Projects\\x\\ac kick.wav' },
      { iid: 2, name: 'Vocal chop', type: 0 },
    ],
    arrangements: Object.assign([{
      name: 'Main',
      items: [
        { pos: 0, idx: PAT + 1, len: 384 },
        { pos: 384, idx: PAT + 1, len: 384, muted: true },
        { pos: 768, idx: PAT + 1, len: 384, track: 3 },
        { pos: 1536, idx: 2, len: 96 },          // audio clip on channel 2
      ],
      tracks: [{ iid: 4, enabled: false, name: 'Off track' }],
    }], { current: 0 }),
  });

  it('reads header, tempo and version', () => {
    const p = parseFlp(project);
    expect(p.ppq).toBe(96);
    expect(p.bpm).toBe(140);
    expect(p.version).toBe('26.1.5.5613');
  });

  it('names channels, falling back to the sample file name', () => {
    const arr = parseFlp(project).arrangements[0];
    expect(arr.parts.map(x => [x.id, x.name])).toEqual([
      ['0:notes', 'Lead'],
      ['1:notes', 'ac kick'],
      ['2:clips', 'Vocal chop'],
    ]);
  });

  it('places pattern notes per playlist clip and flags muted clips and disabled tracks', () => {
    const arr = parseFlp(project).arrangements[0];
    const lead = arr.parts.find(x => x.id === '0:notes').items;
    expect(lead.map(n => [n.start, n.end, n.muted])).toEqual([[0, 48, false], [384, 432, true], [768, 816, true]]);
    expect(arr.mutedClips).toBe(1);
    expect(arr.mutedTracks).toEqual(['Off track']);
    const kick = arr.parts.find(x => x.id === '1:notes').items;
    expect(kick.every(n => n.step)).toBe(true);
  });

  // 15 records of 32 bytes = 480 bytes, which also divides by 60 and 80.
  it.each([32, 60, 80, 88])('detects %i-byte playlist records', (itemSize) => {
    const items = Array.from({ length: 15 }, (_, i) => ({ pos: i * 96, idx: PAT + 1, len: 96 }));
    const p = parseFlp(buildFlp({
      patterns: { 1: [{ pos: 0, len: 24, chan: 0 }] },
      channels: [{ iid: 0, name: 'A' }],
      arrangements: [{ items, itemSize }],
    }));
    expect(p.arrangements[0].parts[0].items.map(n => n.start)).toEqual(items.map(it => it.pos));
  });

  it('honours a pattern clip trim', () => {
    const p = parseFlp(buildFlp({
      patterns: { 1: [{ pos: 0, len: 24, chan: 0 }, { pos: 96, len: 24, chan: 0 }, { pos: 200, len: 24, chan: 0 }] },
      channels: [{ iid: 0, name: 'A' }],
      arrangements: [{ items: [{ pos: 1000, idx: PAT + 1, len: 100, offset: [96, 196] }] }],
    }));
    expect(p.arrangements[0].parts[0].items.map(n => [n.start, n.end])).toEqual([[1000, 1024]]);
  });
});

describe('partToMidiNotes', () => {
  const part = (items, kind = 'notes') => ({ kind, items: items.map(n => ({ key: 60, vel: 128, step: false, slide: false, muted: false, ...n })) });

  it('gives step hits a length up to the next hit, the last a quarter note', () => {
    const notes = partToMidiNotes(part([
      { start: 0, end: 0, step: true },
      { start: 48, end: 48, step: true },
    ]), { ppq: 96 });
    expect(notes.map(n => [n.start, n.end])).toEqual([[0, 48], [48, 144]]);
  });

  it('merges a slide into the note it glides from', () => {
    const notes = partToMidiNotes(part([
      { start: 0, end: 96, key: 60 },
      { start: 48, end: 200, key: 67, slide: true },
    ]));
    expect(notes).toEqual([{ start: 0, end: 200, key: 60, vel: 127 }]);
  });

  it('skips muted notes unless asked, and scales velocity to 1..127', () => {
    const p = part([{ start: 0, end: 10, vel: 100 }, { start: 20, end: 30, muted: true }]);
    expect(partToMidiNotes(p)).toEqual([{ start: 0, end: 10, key: 60, vel: 99 }]);
    expect(partToMidiNotes(p, { includeMuted: true })).toHaveLength(2);
  });

  it('never overlaps two notes of one key', () => {
    const notes = partToMidiNotes(part([
      { start: 0, end: 100 },
      { start: 0, end: 50 },
      { start: 40, end: 120 },
    ]));
    expect(notes.map(n => [n.start, n.end])).toEqual([[0, 40], [40, 120]]);
  });
});

describe('writeMidi', () => {
  it('writes a format-1 file a MIDI reader can read back', () => {
    const buf = writeMidi({
      ppq: 96,
      tempo: [[0, 120], [384, 150]],
      tracks: [{ name: 'Kick', notes: [{ start: 0, end: 48, key: 36, vel: 100 }, { start: 48, end: 96, key: 36, vel: 90 }] }],
    });
    const midi = readMidi(buf);
    expect(midi.ppq).toBe(96);
    expect(midi.tracks[0].tempos).toEqual([[0, 120], [384, 150]]);
    expect(midi.tracks[1].name).toBe('Kick');
    expect(midi.tracks[1].notes).toEqual([
      { start: 0, end: 48, key: 36, vel: 100 },
      { start: 48, end: 96, key: 36, vel: 90 },
    ]);
  });
});

describe('convertFlp', () => {
  const twoArrangements = buildFlp({
    patterns: { 1: [{ pos: 0, len: 24, chan: 0 }] },
    channels: [{ iid: 0, name: 'Hit' }, { iid: 1, name: 'Hit' }],
    arrangements: Object.assign([
      { name: 'Verse', items: [{ pos: 0, idx: PAT + 1, len: 96 }] },
      { name: 'Chorus', items: [{ pos: 0, idx: PAT + 1, len: 96 }, { pos: 96, idx: PAT + 1, len: 96 }, { pos: 0, idx: 1, len: 48 }] },
    ], { current: 1 }),
  });

  it('defaults to the current arrangement and lists all of them', () => {
    const { info, midi } = convertFlp(twoArrangements);
    expect(info.arrangementIndex).toBe(1);
    expect(info.arrangements.map(a => a.name)).toEqual(['Verse', 'Chorus']);
    const tracks = readMidi(midi).tracks.slice(1);
    // Same channel name twice → distinct row names.
    expect(tracks.map(t => [t.name, t.notes.length])).toEqual([['Hit', 2], ['Hit 2', 1]]);
    expect(info.audioClipTracks).toBe(1);
  });

  it('switches arrangement on request', () => {
    const { info } = convertFlp(twoArrangements, { arrangementIndex: 0 });
    expect(info.arrangementIndex).toBe(0);
    expect(info.tracks).toEqual([{ name: 'Hit', kind: 'notes', noteCount: 1 }]);
  });

  it('writes the MIDI to disk and reports an all-muted arrangement', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flp-test-'));
    const file = path.join(tempDir, 'song.flp');
    fs.writeFileSync(file, twoArrangements);
    const ok = convertFlpFile(file, {}, { tempDir });
    expect(ok.ok).toBe(true);
    expect(fs.readFileSync(ok.midiPath).toString('latin1', 0, 4)).toBe('MThd');

    fs.writeFileSync(file, buildFlp({
      patterns: { 1: [{ pos: 0, len: 24, chan: 0 }] },
      channels: [{ iid: 0, name: 'A' }],
      arrangements: [{ items: [{ pos: 0, idx: PAT + 1, len: 96, muted: true }] }],
    }));
    const muted = convertFlpFile(file, {}, { tempDir });
    expect(muted.ok).toBe(false);
    expect(muted.info.mutedNotes).toBe(1);
    expect(convertFlpFile(file, { includeMuted: true }, { tempDir }).ok).toBe(true);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('falls back to the selected pattern when the playlist is empty', () => {
    const buf = buildFlp({
      patterns: {
        1: [{ pos: 0, len: 24, chan: 0 }],
        2: [{ pos: 0, len: 0, chan: 1 }, { pos: 96, len: 0, chan: 1 }, { pos: 192, len: 48, chan: 0, key: 62 }],
      },
      channels: [{ iid: 0, name: 'Bass' }, { iid: 1, name: 'Kick' }],
      arrangements: [{ items: [] }],
    });
    // Event 67 = the selected pattern.
    const selected = Buffer.concat([buf, Buffer.from([67, 2, 0])]);
    const { info, midi } = convertFlp(selected);
    expect(info.pattern).toEqual({ iid: 2, name: 'Pattern 2' });
    expect(info.patterns.map(x => x.iid)).toEqual([1, 2]);
    const tracks = readMidi(midi).tracks.slice(1);
    expect(tracks.map(t => [t.name, t.notes.map(n => [n.start, n.end])])).toEqual([
      ['Bass', [[192, 240]]],
      ['Kick', [[0, 96], [96, 192]]],
    ]);
    expect(convertFlp(selected, { patternIid: 1 }).info.tracks).toEqual([{ name: 'Bass', kind: 'notes', noteCount: 1 }]);
  });

  it('returns a readable reason for a broken file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flp-test-'));
    const file = path.join(tempDir, 'broken.flp');
    fs.writeFileSync(file, 'nope');
    expect(convertFlpFile(file, {}, { tempDir })).toEqual({ ok: false, reason: "This isn't an FL Studio project file." });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
