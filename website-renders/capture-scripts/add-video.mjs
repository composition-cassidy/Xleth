// Adds a generated video clip on a "Visuals" track to the demo project, then saves it.
// Usage (from ui/): node <this> <projectDir> <profileDir> <videoPath>
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ui')
const require = createRequire(pathToFileURL(path.join(UI, 'package.json')))
const { _electron: electron } = require('playwright')
const [PROJECT, PROFILE, VIDEO] = process.argv.slice(2)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const BAR = 3840
const DUR = 6.857142857142857

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
await sleep(2500)
if (!(await welcome.evaluate((dir) => window.xlethWelcome.project.load(dir), PROJECT))) throw new Error('load failed')
await welcome.evaluate(({ dir, name }) => window.xlethWelcome.projectReady(dir, name), { dir: PROJECT, name: 'XLETH Demo' }).catch(() => {})
let page = null
const t1 = Date.now()
while (!page && Date.now() - t1 < 90000) {
  for (const w of app.windows()) {
    if (await w.evaluate(() => typeof window.xleth === 'object' && !window.xlethWelcome).catch(() => false)) { page = w; break }
  }
  if (!page) await sleep(400)
}
await page.waitForSelector('[data-testid="xleth-windowing-shell"]', { timeout: 60000 })
await sleep(2000)

const out = await page.evaluate(async ({ video, bar, dur }) => {
  const xl = window.xleth
  const log = []
  const src = await xl.project.importSource(video)
  log.push(`source ${src}`)
  const region = await xl.timeline.addRegion({ sourceId: src, startTime: 0, endTime: dur, label: 'Custom', name: 'visuals loop' })
  log.push(`region ${region}`)
  const track = await xl.timeline.addTrack({ name: 'Visuals', order: 6 })
  log.push(`track ${track}`)
  for (const pos of [0, 4 * bar]) log.push(`clip@${pos} ${await xl.timeline.addClip({ trackId: track, regionId: region, positionTicks: pos, durationTicks: 4 * bar })}`)
  log.push(`save ${await xl.project.save()}`)
  return log
}, { video: VIDEO, bar: BAR, dur: DUR })
console.log(out.join('\n'))
await sleep(2000)
await app.close()
