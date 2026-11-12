// One-off verification for the FL piano roll keys (run from ui/):
//   node tests/ui-audit/verify-fl-pianoroll.mjs <copied-project-dir> <out-dir>
// Real app, real engine, isolated profile. Checks editPatternNotes + undo,
// Ctrl+B / Ctrl+Enter / Ctrl+M through real key presses, and takes shots.
import path from 'node:path'
import fs from 'node:fs'
import * as lib from './lib.mjs'

const [projectDir, outDir] = process.argv.slice(2)
fs.mkdirSync(outDir, { recursive: true })
const log = (...a) => console.log('[verify]', ...a)
const sleep = lib.sleep

const { app, page } = await lib.launch({ projectDir })
try {
  await lib.setViewport(app, page, 1600, 1000)
  const DOCK = '[data-testid="xleth-detail-dock"]'
  const tab = page.locator('[data-detail-tab="pianoRoll"]').first()
  for (let i = 0; i < 3 && (await tab.getAttribute('aria-selected')) !== 'true'; i++) { await tab.click(); await sleep(900) }
  await page.getByText('Pattern 8', { exact: false }).first().dblclick()
  await sleep(1500)

  // 1. Engine: the new call exists and lands as ONE undo entry.
  const engine = await page.evaluate(async () => {
    const tl = window.xleth.timeline
    const pats = await tl.getAllPatterns()
    const p8 = pats.find((p) => /Pattern 8/.test(p.name)) || pats[0]
    const before = (await tl.getPattern(p8.id)).notes
    const after = [...before.map((n) => ({ ...n })), { positionTicks: 0, durationTicks: 240, pitch: 30, velocity: 0.5 }]
    after[0].positionTicks += 240
    const result = await tl.editPatternNotes(p8.id, after)
    const mid = (await tl.getPattern(p8.id)).notes
    await window.xleth.undo.undo()
    const undone = (await tl.getPattern(p8.id)).notes
    await window.xleth.undo.redo()
    const redone = (await tl.getPattern(p8.id)).notes
    await window.xleth.undo.undo()
    return {
      hasCall: typeof tl.editPatternNotes === 'function',
      patternId: p8.id,
      before: before.length, mid: mid.length, undone: undone.length, redone: redone.length,
      returnedIds: Array.isArray(result) && result.every((n) => Number.isInteger(n.id) && n.id > 0),
      firstMovedThenRestored: mid.find((n) => n.id === before[0].id)?.positionTicks === before[0].positionTicks + 240
        && undone.find((n) => n.id === before[0].id)?.positionTicks === before[0].positionTicks,
      idsKept: before.every((n) => undone.some((u) => u.id === n.id)),
    }
  })
  log('engine', JSON.stringify(engine))

  // Focus the piano roll grid, then use real key presses.
  const grid = page.locator(`${DOCK} .piano-roll-canvas-container`).first()
  const box = await grid.boundingBox()
  const count = () => page.evaluate(async (id) => (await window.xleth.timeline.getPattern(id)).notes.length, engine.patternId)
  const nStart = await count()
  // Ctrl+click empty = deselect (and focuses the panel); mouse.click has no modifiers option.
  await page.keyboard.down('Control')
  await page.mouse.click(box.x + box.width - 30, box.y + 10)
  await page.keyboard.up('Control')
  await sleep(300)
  const n0 = await count()
  log('ctrl+click empty adds nothing', JSON.stringify({ before: nStart, after: n0 }))
  await page.keyboard.press('Control+a'); await sleep(200)
  await page.keyboard.press('Control+Enter'); await sleep(400)
  await page.screenshot({ path: path.join(outDir, '1-time-selection.png') })
  await page.keyboard.press('Control+b'); await sleep(900)
  const n1 = await count()
  await page.screenshot({ path: path.join(outDir, '2-after-ctrl-b.png') })
  await page.keyboard.press('Control+z'); await sleep(900)
  const n2 = await count()
  log('ctrl+b', JSON.stringify({ before: n0, afterCtrlB: n1, afterOneUndo: n2 }))

  // Shift+Up = semitone, Ctrl+Up = octave on the selection.
  const pitchOf = () => page.evaluate(async (id) => (await window.xleth.timeline.getPattern(id)).notes[0].pitch, engine.patternId)
  await page.keyboard.press('Control+a'); await sleep(200)
  const p0 = await pitchOf()
  await page.keyboard.press('Shift+ArrowUp'); await sleep(700)
  const p1 = await pitchOf()
  await page.keyboard.press('Control+ArrowUp'); await sleep(700)
  const p2 = await pitchOf()
  await page.keyboard.press('Control+z'); await sleep(500)
  await page.keyboard.press('Control+z'); await sleep(700)
  const p3 = await pitchOf()
  log('transpose', JSON.stringify({ p0, shiftUp: p1, ctrlUp: p2, afterTwoUndos: p3 }))

  // Ctrl+M: opens MIDI import, must NOT toggle the mixer.
  const mixerOpen = () => page.evaluate(() => !!document.querySelector('[data-panel-id="mixer"]:not([hidden])') || !!document.querySelector('.mixer-strip'))
  const mixBefore = await mixerOpen()
  await page.keyboard.down('Control'); await page.mouse.click(box.x + box.width - 30, box.y + 10); await page.keyboard.up('Control'); await sleep(200)
  await page.keyboard.press('Control+m'); await sleep(900)
  const dialog = await page.getByText('Import MIDI', { exact: false }).count()
  const mixAfter = await mixerOpen()
  await page.screenshot({ path: path.join(outDir, '3-ctrl-m.png') })
  await page.keyboard.press('Escape'); await sleep(400)
  log('ctrl+m', JSON.stringify({ midiDialogShown: dialog > 0, mixerBefore: mixBefore, mixerAfter: mixAfter }))

  // Ruler: Ctrl+drag selects time; the band shows on the ruler and the grid.
  const ruler = await page.locator(`${DOCK} .piano-roll-ruler`).first().boundingBox()
  await page.keyboard.down('Control')
  await page.mouse.move(ruler.x + 330, ruler.y + 10)
  await page.mouse.down()
  await page.mouse.move(ruler.x + 650, ruler.y + 10, { steps: 8 })
  await page.mouse.up()
  await page.keyboard.up('Control')
  await sleep(500)
  await page.screenshot({ path: path.join(outDir, '5-ruler-time-selection.png'), clip: { x: box.x - 60, y: box.y - 40, width: box.width + 60, height: box.height + 40 } })

  // Toolbar shows the Paint tool.
  log('paint tool button', await page.locator(`${DOCK} [aria-label="Paint tool"]`).count())
  await page.screenshot({ path: path.join(outDir, '4-toolbar.png'), clip: { x: box.x - 60, y: box.y - 90, width: Math.min(1500, box.width + 60), height: 90 } })

  const errs = lib.consoleLog.filter((l) => l.type === 'pageerror' || (l.type === 'error' && /PianoRoll|pianoRoll/.test(l.text)))
  log('page errors', JSON.stringify(errs.slice(0, 10)))
} finally {
  await app.close().catch(() => {})
}
