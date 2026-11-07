// UI render harness (Phase 0). Builds the renderer, serves it with `vite preview`,
// drives the locally installed Edge/Chrome through playwright-core, and writes
//   tests/ui-render/out/<label>/shot-<W>x<H>.png   one screenshot per viewport
//   tests/ui-render/out/<label>/report.json        text nodes < 4.5:1 or < 10px
// and can pixel-diff two labelled runs.
//
// It runs WITHOUT the engine: `window.xleth` is absent, so this covers chrome only.
// Anything that needs live audio/video or the bridge must be checked in Electron.
//
// Usage (from ui/):
//   npm run shots -- --label before                 build + capture
//   npm run shots -- --label after --no-build       capture the existing dist/
//   npm run shots -- --compare before after         pixel diff (+ report deltas)
//   npm run shots:gallery -- --label kit            UI kit gallery (Phase 2) at 100% and 150% zoom
//                                                    -> gallery-100.png, gallery-150.png, report.json
//                                                    (built into tests/ui-render/out/_gallery-build with
//                                                    VITE_XLETH_UI_KIT_GALLERY=1, meters frozen)
//   Options: --channel msedge|chrome|chromium   (default msedge, env XLETH_SHOTS_CHANNEL)
//            --executable <path>                use a specific browser binary
//            --port <n>                         preview port (default 4173)
//            --threshold <0..1>                 pixelmatch threshold for --compare (default 0.1)
//            --theme <slug>                     shipped theme to photograph (xleth-default|light|warm|cool|high-contrast)
//            --scale <100..200>                 UI scale %: CDP metrics override, so the CSS viewport shrinks and
//                                               devicePixelRatio rises exactly as Electron window zoom does
//            --viewport <WxH>                   only this viewport (default: all three)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UI_ROOT = path.resolve(HERE, '..', '..')
const OUT_ROOT = path.join(HERE, 'out')

export const VIEWPORTS = [
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '2560x1440', width: 2560, height: 1440 },
]

const MIN_CONTRAST = 4.5
const MIN_FONT_PX = 10

const log = (...a) => console.log('[UIKit:shots]', ...a)

function parseArgs(argv) {
  const args = { label: 'latest', build: true, channel: process.env.XLETH_SHOTS_CHANNEL || 'msedge', port: 4173, threshold: 0.1 }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--label') args.label = argv[++i]
    else if (a === '--no-build') args.build = false
    else if (a === '--gallery') args.gallery = true
    else if (a === '--channel') args.channel = argv[++i]
    else if (a === '--executable') args.executable = argv[++i]
    else if (a === '--port') args.port = Number(argv[++i])
    else if (a === '--threshold') args.threshold = Number(argv[++i])
    else if (a === '--theme') args.theme = argv[++i]
    else if (a === '--scale') args.scale = Number(argv[++i])
    else if (a === '--viewport') args.viewport = argv[++i]
    else if (a === '--compare') { args.compare = [argv[++i], argv[++i]] }
    else throw new Error(`unknown argument: ${a}`)
  }
  if (args.compare && args.compare.some((x) => !x)) throw new Error('--compare needs two labels')
  if (!/^[\w.-]+$/.test(args.label)) throw new Error('--label may only contain letters, digits, ., _ and -')
  return args
}

// Runs inside the page. Must be self-contained (it is serialised by Playwright).
function auditTextInPage({ minContrast, minFontPx }) {
  const cv = document.createElement('canvas')
  cv.width = 1
  cv.height = 1
  const cx = cv.getContext('2d', { willReadFrequently: true })
  // Canvas understands every CSS colour syntax Chrome can return from
  // getComputedStyle (rgb(), color(srgb …), oklch(), color-mix results).
  const parse = (s) => {
    cx.clearRect(0, 0, 1, 1)
    cx.fillStyle = '#000'
    cx.fillStyle = s
    cx.fillRect(0, 0, 1, 1)
    const d = cx.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2], d[3] / 255]
  }
  const over = (fg, bg) => {
    const a = fg[3]
    return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1]
  }
  const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
  const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')

  const describe = (el) => {
    const parts = []
    for (let n = el, i = 0; n && n.nodeType === 1 && i < 3; n = n.parentElement, i += 1) {
      const cls = (typeof n.className === 'string' ? n.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.')
      parts.unshift(n.tagName.toLowerCase() + (cls ? '.' + cls : ''))
    }
    return parts.join(' > ')
  }

  const backgroundOf = (el) => {
    const layers = []
    let uncertain = false
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n)
      if (cs.backgroundImage && cs.backgroundImage !== 'none') uncertain = true
      const c = parse(cs.backgroundColor)
      if (c[3] > 0) layers.push(c)
      if (c[3] >= 1) break
    }
    let acc = [255, 255, 255, 1] // no opaque ancestor: the canvas default
    for (let i = layers.length - 1; i >= 0; i -= 1) acc = over(layers[i], acc)
    return { bg: acc, uncertain }
  }

  const opacityOf = (el) => {
    let o = 1
    for (let n = el; n; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity) || 0
    return o
  }

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const out = { total: 0, lowContrast: 0, small: 0, uncertainBackground: 0, entries: [] }
  const range = document.createRange()
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue.replace(/\s+/g, ' ').trim()
    if (!text) continue
    const el = node.parentElement
    if (!el || /^(SCRIPT|STYLE|NOSCRIPT|OPTION)$/.test(el.tagName)) continue
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue
    range.selectNodeContents(node)
    const r = range.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) continue

    const cs = getComputedStyle(el)
    const fontPx = parseFloat(cs.fontSize)
    const { bg, uncertain } = backgroundOf(el)
    const fgRaw = parse(cs.color)
    fgRaw[3] *= opacityOf(el)
    const fg = over(fgRaw, bg)
    const cr = ratio(fg, bg)

    out.total += 1
    const reasons = []
    if (cr < minContrast) { reasons.push('contrast'); out.lowContrast += 1 }
    if (fontPx < minFontPx) { reasons.push('size'); out.small += 1 }
    if (uncertain) out.uncertainBackground += 1
    if (reasons.length) {
      out.entries.push({
        text: text.slice(0, 60),
        where: describe(el),
        fontPx: Math.round(fontPx * 100) / 100,
        fontWeight: cs.fontWeight,
        fg: hex(fg),
        bg: hex(bg),
        ratio: Math.round(cr * 100) / 100,
        backgroundUncertain: uncertain,
        reasons,
      })
    }
  }
  return out
}

// Runs inside the page. Strips whose content is wider than the strip and that neither
// scroll nor clip on purpose are reported: at 200 % on a 1366 x 768 window (683 x 384 CSS
// px) these are the transport cluster, the dock tab strip and the hint bar.
function overflowInPage() {
  const SELECTORS = [
    ['transport / title bar', '[class*="titlebar"], [class*="TitleBar"], header'],
    ['dock tab strip', '[role="tablist"]'],
    ['hint bar', '[class*="hintBar"], [class*="HintBar"], [data-testid="hint-bar"]'],
  ]
  const out = []
  for (const [name, sel] of SELECTORS) {
    document.querySelectorAll(sel).forEach((el) => {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return
      const over = el.scrollWidth - el.clientWidth
      // Children that stick out past the strip's own box and past the viewport edge.
      let outside = 0
      el.querySelectorAll('*').forEach((c) => {
        const cr = c.getBoundingClientRect()
        if (cr.width > 0 && (cr.right > Math.min(r.right, innerWidth) + 1 || cr.left < r.left - 1)) outside += 1
      })
      const cs = getComputedStyle(el)
      const scrolls = /(auto|scroll)/.test(cs.overflowX)
      if (over > 1 || outside > 0) out.push({ strip: name, tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 60), clientWidth: el.clientWidth, scrollWidth: el.scrollWidth, childrenOutside: outside, scrollsHorizontally: scrolls })
    })
  }
  return out
}

const GALLERY_OUT_DIR = path.join('tests', 'ui-render', 'out', '_gallery-build')

// Phase 2: the dev-only UI kit gallery, full page, at 100% and 150% zoom.
async function captureGallery(args) {
  const { chromium } = await import('playwright-core')
  const vite = await import('vite')
  process.env.VITE_XLETH_UI_KIT_GALLERY = '1'
  const buildOpts = { root: UI_ROOT, logLevel: 'warn', build: { outDir: GALLERY_OUT_DIR, emptyOutDir: true } }

  if (args.build) {
    log('vite build (gallery) …')
    await vite.build(buildOpts)
  } else if (!fs.existsSync(path.join(UI_ROOT, GALLERY_OUT_DIR, 'index.html'))) {
    throw new Error(`${GALLERY_OUT_DIR}/index.html missing; run without --no-build`)
  }

  const server = await vite.preview({ ...buildOpts, preview: { port: args.port, strictPort: true, host: '127.0.0.1' } })
  const url = `http://127.0.0.1:${args.port}/?view=ui-kit&shots=1`
  const launchOpts = args.executable ? { executablePath: args.executable } : { channel: args.channel }
  const browser = await chromium.launch({ ...launchOpts, headless: true })
  const outDir = path.join(OUT_ROOT, args.label)
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })

  const report = { label: args.label, generatedAt: new Date().toISOString(), browser: `${args.executable || args.channel} ${browser.version()}`, thresholds: { minContrast: MIN_CONTRAST, minFontPx: MIN_FONT_PX }, note: 'UI kit gallery; meters show a frozen synthetic test signal.', zooms: {} }
  try {
    for (const zoom of [1, 1.5]) {
      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, reducedMotion: 'reduce' })
      const page = await context.newPage()
      const pageErrors = []
      const consoleErrors = []
      page.on('pageerror', (e) => pageErrors.push(String(e.message || e)))
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)) })
      await page.goto(`${url}&zoom=${zoom}`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[data-testid="ui-kit-gallery"]')
      await page.evaluate(() => document.fonts.ready)
      await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' })
      await page.waitForTimeout(500)
      const name = `gallery-${Math.round(zoom * 100)}`
      // CSS zoom defeats fullPage's height measurement: size the viewport to the gallery instead.
      const bottom = await page.evaluate(() => Math.ceil(document.querySelector('[data-testid="ui-kit-gallery"]').getBoundingClientRect().bottom))
      await page.setViewportSize({ width: 1920, height: Math.max(1080, bottom + 16) })
      await page.waitForTimeout(250)
      await page.screenshot({ path: path.join(outDir, `${name}.png`) })
      const audit = await page.evaluate(auditTextInPage, { minContrast: MIN_CONTRAST, minFontPx: MIN_FONT_PX })
      report.zooms[name] = { ...audit, pageErrors, consoleErrors }
      log(`${name}: ${audit.total} text nodes, ${audit.lowContrast} < ${MIN_CONTRAST}:1, ${audit.small} < ${MIN_FONT_PX}px, ${pageErrors.length} page errors`)
      await context.close()
    }
  } finally {
    await browser.close()
    await new Promise((resolve) => server.httpServer.close(resolve))
  }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2))
  log('wrote', path.relative(UI_ROOT, outDir))
}

async function capture(args) {
  const { chromium } = await import('playwright-core')
  const vite = await import('vite')

  if (args.build) {
    log('vite build …')
    await vite.build({ root: UI_ROOT, logLevel: 'warn' })
  } else if (!fs.existsSync(path.join(UI_ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/index.html missing; run without --no-build')
  }

  const server = await vite.preview({ root: UI_ROOT, logLevel: 'warn', preview: { port: args.port, strictPort: true, host: '127.0.0.1' } })
  const url = `http://127.0.0.1:${args.port}/`
  log('preview at', url)

  const launchOpts = args.executable ? { executablePath: args.executable } : { channel: args.channel }
  const browser = await chromium.launch({ ...launchOpts, headless: true })
  const outDir = path.join(OUT_ROOT, args.label)
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })

  const report = {
    label: args.label,
    generatedAt: new Date().toISOString(),
    browser: `${args.executable || args.channel} ${browser.version()}`,
    thresholds: { minContrast: MIN_CONTRAST, minFontPx: MIN_FONT_PX },
    note: 'No engine: window.xleth is absent. Chrome only; canvas text is not covered.',
    theme: args.theme || 'xleth-default',
    scale: args.scale || 100,
    viewports: {},
  }

  try {
    const scale = (args.scale || 100) / 100
    const viewports = args.viewport ? VIEWPORTS.filter((v) => v.name === args.viewport) : VIEWPORTS
    if (viewports.length === 0) throw new Error(`unknown --viewport ${args.viewport}`)
    for (const vp of viewports) {
      // Same effect as Electron window zoom: fewer CSS pixels (the layout viewport shrinks by the
      // scale) and more device pixels per CSS pixel, so the screenshot is still vp.width x vp.height.
      const context = await browser.newContext({
        viewport: { width: Math.round(vp.width / scale), height: Math.round(vp.height / scale) },
        deviceScaleFactor: scale,
        reducedMotion: 'reduce',
      })
      const page = await context.newPage()
      const pageErrors = []
      const consoleErrors = []
      page.on('pageerror', (e) => pageErrors.push(String(e.message || e)))
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)) })

      await page.goto(args.theme ? `${url}?theme=${encodeURIComponent(args.theme)}` : url, { waitUntil: 'networkidle' })
      await page.evaluate(() => document.fonts.ready)
      // Freeze motion and the text caret so two runs of the same build are pixel-identical.
      await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' })
      await page.waitForTimeout(600)

      const shotPath = path.join(outDir, `shot-${vp.name}.png`)
      await page.screenshot({ path: shotPath })
      const audit = await page.evaluate(auditTextInPage, { minContrast: MIN_CONTRAST, minFontPx: MIN_FONT_PX })
      const overflow = await page.evaluate(overflowInPage)
      report.viewports[vp.name] = { ...audit, overflow, pageErrors, consoleErrors }
      log(`${vp.name} @${Math.round(scale * 100)}% ${args.theme || 'xleth-default'}: ${audit.total} text nodes, ${audit.lowContrast} < ${MIN_CONTRAST}:1, ${audit.small} < ${MIN_FONT_PX}px, ${overflow.length} overflowing, ${pageErrors.length} page errors`)
      await context.close()
    }
  } finally {
    await browser.close()
    await new Promise((resolve) => server.httpServer.close(resolve))
  }

  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2))
  log('wrote', path.relative(UI_ROOT, outDir))
}

async function compare(args) {
  const [a, b] = args.compare
  const { PNG } = await import('pngjs')
  const { default: pixelmatch } = await import('pixelmatch')
  const diffDir = path.join(OUT_ROOT, `compare-${a}-vs-${b}`)
  fs.rmSync(diffDir, { recursive: true, force: true })
  fs.mkdirSync(diffDir, { recursive: true })

  const rows = []
  for (const vp of VIEWPORTS) {
    const pa = path.join(OUT_ROOT, a, `shot-${vp.name}.png`)
    const pb = path.join(OUT_ROOT, b, `shot-${vp.name}.png`)
    if (!fs.existsSync(pa) || !fs.existsSync(pb)) throw new Error(`missing shot for ${vp.name}: capture both labels first`)
    const ia = PNG.sync.read(fs.readFileSync(pa))
    const ib = PNG.sync.read(fs.readFileSync(pb))
    if (ia.width !== ib.width || ia.height !== ib.height) throw new Error(`${vp.name}: size mismatch`)
    const diff = new PNG({ width: ia.width, height: ia.height })
    const changed = pixelmatch(ia.data, ib.data, diff.data, ia.width, ia.height, { threshold: args.threshold })
    fs.writeFileSync(path.join(diffDir, `diff-${vp.name}.png`), PNG.sync.write(diff))
    const pct = (changed / (ia.width * ia.height)) * 100
    rows.push({ viewport: vp.name, changedPixels: changed, percent: Number(pct.toFixed(4)) })
  }

  const ra = JSON.parse(fs.readFileSync(path.join(OUT_ROOT, a, 'report.json'), 'utf8'))
  const rb = JSON.parse(fs.readFileSync(path.join(OUT_ROOT, b, 'report.json'), 'utf8'))
  console.log(`\nPixel diff ${a} -> ${b} (pixelmatch threshold ${args.threshold})`)
  console.table(rows)
  console.log('Text audit (visible text nodes)')
  console.table(VIEWPORTS.map((vp) => {
    const x = ra.viewports[vp.name]
    const y = rb.viewports[vp.name]
    return {
      viewport: vp.name,
      [`${a} total`]: x.total, [`${b} total`]: y.total,
      [`${a} <4.5:1`]: x.lowContrast, [`${b} <4.5:1`]: y.lowContrast,
      [`${a} <10px`]: x.small, [`${b} <10px`]: y.small,
    }
  }))
  fs.writeFileSync(path.join(diffDir, 'compare.json'), JSON.stringify({ a, b, threshold: args.threshold, pixels: rows }, null, 2))
  log('diff images in', path.relative(UI_ROOT, diffDir))
}

const args = parseArgs(process.argv.slice(2))
if (args.compare) await compare(args)
else if (args.gallery) await captureGallery(args)
else await capture(args)
