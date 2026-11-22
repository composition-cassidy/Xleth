// Website renders: opens the demo project at 1920x1080 CSS px, device scale 2, and captures each view.
// Usage (from ui/): node <this> <projectDir> <profileDir> <outDir> [onlyShotName ...]
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ui')
const require = createRequire(pathToFileURL(path.join(UI, 'package.json')))
const { _electron: electron } = require('playwright')
const [PROJECT, PROFILE, OUT, ...ONLY] = process.argv.slice(2)
fs.mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PARK = [1500, 900] // empty arrangement area: a neutral pointer position

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
if (!(await welcome.evaluate((dir) => window.xlethWelcome.project.load(dir), PROJECT))) throw new Error('project.load returned false')
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
await sleep(2500)

const cdp = await page.context().newCDPSession(page)
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 2, mobile: false })
await sleep(1000)
console.log('viewport', JSON.stringify(await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }))))

const park = async () => { await page.mouse.move(PARK[0], PARK[1]); await sleep(300) }
// Dock tabs move when the dock opens, so find each tab by its label at click time.
const clickTab = async (label) => {
  const c = await page.evaluate((lab) => {
    const hits = [...document.querySelectorAll('button, [role="tab"], div, span')]
      .filter((e) => e.textContent.trim() === lab)
      .map((e) => ({ r: e.getBoundingClientRect() }))
      .filter(({ r }) => r.top > 600 && r.width > 0 && r.width < 260 && r.height > 0)
      .sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height)
    if (!hits.length) return null
    const r = hits[0].r
    return [r.left + r.width / 2, r.top + r.height / 2]
  }, label)
  if (!c) throw new Error(`dock tab not found: ${label}`)
  await page.mouse.click(c[0], c[1])
  await sleep(1000)
  await park()
}
const capture = async (name) => {
  await sleep(800)
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 } })
  const file = path.join(OUT, `${name}.png`)
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
  console.log('wrote', file, fs.statSync(file).size)
}
const want = (n) => ONLY.length === 0 || ONLY.includes(n)

// Shot order matters: each step builds on the last dock state.
// Setup for every shot: wait for the proxies, then hide the black preview box.
{
  // Preview frames only show once the background proxy transcodes are done.
  for (let i = 0; i < 120; i++) {
    const st = await page.evaluate(() => window.xleth.proxy.getStatus()).catch(() => null)
    if (st && st.pending === 0 && st.inFlight === 0) break
    await sleep(1000)
  }
  console.log('proxy status', JSON.stringify(await page.evaluate(() => window.xleth.proxy.getStatus()).catch(() => null)))
  // The preview stays black in this build's demo (no grid placement), so hide it for the hero.
  const tp = await page.evaluate(() => {
    const b = document.querySelector('button[aria-label="Toggle Preview"]')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return [r.left + r.width / 2, r.top + r.height / 2]
  })
  if (tp) { await page.mouse.click(tp[0], tp[1]); await sleep(800); await park() }
}

if (want('hero-workspace')) {
  await clickTab('Mixer')
  await page.evaluate(() => window.xleth.transport.seek(0)).catch(() => {})
  await page.mouse.click(789, 17) // Play
  await sleep(4500) // a few seconds in, so the gradient preview has colour
  await capture('hero-workspace')
  await page.mouse.click(759, 17) // Stop
  await sleep(500)
}
if (want('mixer')) {
  await clickTab('Mixer')
  await capture('mixer')
}
if (want('devices')) {
  await clickTab('Devices')
  await capture('devices')
}
if (want('piano-roll')) {
  // Click the Bass line pattern block: the roll shows that pattern. (Clicking the Patterns list
  // row instead opened a floating Sampler window over the dock tabs.)
  await page.mouse.click(1000, 288)
  await sleep(800)
  await park()
  await clickTab('Piano Roll')
  await capture('piano-roll')
}
if (want('fx-graph')) {
  await clickTab('FX Graph')
  await capture('fx-graph')
}
if (want('sampler')) {
  await clickTab('Sampler')
  await capture('sampler')
}

await app.close()
