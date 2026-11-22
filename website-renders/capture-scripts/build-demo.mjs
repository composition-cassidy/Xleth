// Builds a neutral demo project through the real engine (window.xleth) and saves it.
// Usage (from ui/ so 'playwright' resolves):  node <this file> <mediaDir> <parentDir> <profileDir>
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ui')
const require = createRequire(pathToFileURL(path.join(UI, 'package.json')))
const { _electron: electron } = require('playwright')

const [MEDIA, PARENT, PROFILE] = process.argv.slice(2)
const NAME = 'XLETH Demo'
const PROJECT_DIR = path.join(PARENT, NAME)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const manifest = JSON.parse(fs.readFileSync(path.join(MEDIA, 'manifest.json'), 'utf8'))
const files = Object.fromEntries(['kick', 'snare', 'hats', 'bass', 'lead', 'pad'].map((k) => [k, path.join(MEDIA, `${k}.wav`)]))
const dur = Object.fromEntries(Object.entries(manifest.durations).map(([f, d]) => [f.replace('.wav', ''), d]))

const PPQ = 960
const BAR = 4 * PPQ
const ROOTS = [45, 41, 48, 43] // Am F C G, as MIDI pitches
const CHORD_LEAD = [[69, 72, 76], [65, 69, 72], [60, 64, 67], [67, 71, 74]]
const CHORD_PAD = [[57, 60, 64], [53, 57, 60], [60, 64, 67], [55, 59, 62]]
const bassNotes = []
const leadNotes = []
const padNotes = []
for (let b = 0; b < 4; b++) {
  const r = ROOTS[b]
  ;[r, r, r + 12, r, r + 7, r, r + 12, r + 5].forEach((p, i) =>
    bassNotes.push({ positionTicks: b * BAR + i * PPQ / 2, durationTicks: PPQ / 2 - 60, pitch: p, velocity: i % 2 ? 0.8 : 1 }))
  const arp = b % 2 ? [2, 1, 0, 1, 2, 0, 1, 0] : [0, 1, 2, 1, 0, 2, 1, 2]
  arp.forEach((ci, i) =>
    leadNotes.push({ positionTicks: b * BAR + i * PPQ / 2, durationTicks: PPQ / 2 - 40, pitch: CHORD_LEAD[b][ci] + (b === 2 ? 12 : 0), velocity: i % 4 === 0 ? 1 : 0.85 }))
  CHORD_PAD[b].forEach((p) =>
    padNotes.push({ positionTicks: b * BAR, durationTicks: BAR - 40, pitch: p, velocity: 0.7 }))
}

const content = { files, dur, bassNotes, leadNotes, padNotes, BAR, PPQ }

const app = await electron.launch({
  args: [path.join(UI, 'main.js'), `--user-data-dir=${PROFILE}`],
  cwd: UI,
  env: { ...process.env, XLETH_PLAYWRIGHT: '1', ELECTRON_ENABLE_LOGGING: '0' },
})

let welcome = null
const t0 = Date.now()
while (!welcome && Date.now() - t0 < 60000) {
  for (const w of app.windows()) {
    if (await w.evaluate(() => !!window.xlethWelcome).catch(() => false)) { welcome = w; break }
  }
  if (!welcome) await sleep(300)
}
if (!welcome) throw new Error('Welcome window never appeared')
await sleep(2500)
const created = await welcome.evaluate(async (form) => window.xlethWelcome.project.create(form), { parentDir: PARENT, name: NAME })
console.log('create ->', JSON.stringify(created).slice(0, 300))
await welcome.evaluate(({ dir, name }) => window.xlethWelcome.projectReady(dir, name), { dir: PROJECT_DIR, name: NAME }).catch(() => {})

let page = null
const t1 = Date.now()
while (!page && Date.now() - t1 < 90000) {
  for (const w of app.windows()) {
    if (await w.evaluate(() => typeof window.xleth === 'object' && !window.xlethWelcome).catch(() => false)) { page = w; break }
  }
  if (!page) await sleep(400)
}
if (!page) throw new Error('workspace window never appeared')
await page.waitForSelector('[data-testid="xleth-windowing-shell"]', { timeout: 60000 })
await sleep(1500)

const log = await page.evaluate(async (c) => {
  const xl = window.xleth
  const out = []
  const step = async (label, fn) => {
    try { const v = await fn(); out.push(`${label}: ${JSON.stringify(v)}`); return v } catch (e) { out.push(`${label}: FAIL ${e?.message || e}`); return null }
  }
  await step('bpm', () => xl.timeline.setBPM(140))
  const src = {}
  for (const [k, f] of Object.entries(c.files)) src[k] = await step(`import ${k}`, () => xl.project.importSource(f))
  // one region per stem; the four-bar loop regions are the audio clips
  const region = {}
  for (const k of Object.keys(c.files)) {
    region[k] = await step(`region ${k}`, () => xl.timeline.addRegion({
      sourceId: src[k], startTime: 0, endTime: c.dur[k], label: 'Custom', name: `${k} loop`,
    }))
  }
  const audioTrack = async (name, order, k) => {
    const id = await step(`track ${name}`, () => xl.timeline.addTrack({ name, order }))
    for (const pos of [0, 4 * c.BAR]) {
      await step(`clip ${name}@${pos}`, () => xl.timeline.addClip({ trackId: id, regionId: region[k], positionTicks: pos, durationTicks: 4 * c.BAR }))
    }
    return id
  }
  const patternTrack = async (name, order, k, notes, patName) => {
    const id = await step(`track ${name}`, () => xl.timeline.addTrack({ name, order }))
    await step(`convert ${name}`, () => xl.timeline.convertToPatternTrack(id))
    const pat = await step(`pattern ${name}`, () => xl.timeline.addPattern({ name: patName, regionId: region[k], lengthTicks: 4 * c.BAR }))
    await step(`notes ${name}`, () => xl.timeline.addNotesBatch(pat, notes))
    for (const pos of [0, 4 * c.BAR]) {
      await step(`block ${name}@${pos}`, () => xl.timeline.addPatternBlock({ trackId: id, patternId: pat, positionTicks: pos, durationTicks: 4 * c.BAR, offsetTicks: 0 }))
    }
    return id
  }
  const kick = await audioTrack('Kick', 0, 'kick')
  const snare = await audioTrack('Snare', 1, 'snare')
  const hats = await audioTrack('Hats', 2, 'hats')
  const bass = await patternTrack('Bass', 3, 'bass', c.bassNotes, 'Bass line')
  const lead = await patternTrack('Lead', 4, 'lead', c.leadNotes, 'Lead arp')
  const pads = await patternTrack('Pads', 5, 'pad', c.padNotes, 'Pad chords')
  // stock effects so the device and mixer views have chains to show
  const fx = async (trackId, plugin, label) => step(`fx ${label}`, () => xl.audio.addEffect(trackId, plugin, 0))
  await fx(kick, 'compressor', 'kick comp')
  await fx(bass, 'xletheq', 'bass eq')
  await fx(bass, 'compressor', 'bass comp')
  await fx(lead, 'delay', 'lead delay')
  await fx(lead, 'chorus', 'lead chorus')
  await fx(pads, 'reverb', 'pad reverb')
  await fx(hats, 'limiter', 'hats limiter')
  await step('save', () => xl.project.save())
  return out
}, content)
console.log(log.join('\n'))
await page.evaluate(() => window.xleth.transport.seek(0)).catch(() => {})
await sleep(1500)
const saved = await page.evaluate(() => window.xleth.project.getInfo?.()).catch((e) => `getInfo failed: ${e.message}`)
console.log('info ->', JSON.stringify(saved).slice(0, 400))
await app.close()
console.log('project at', PROJECT_DIR)
