import '../../../src/components/timeline/clipControls.css'
import { CLIP_CONTROL_DEFAULTS } from '../../../src/components/timeline/clipControlSpec.js'
import {
  drawClipFadeOverlay,
  drawClipInlineControls,
} from '../../../src/components/timeline/timelineDrawing.js'
import './style.css'

const MATRIX_SIZES = [[40, 20], [64, 46], [180, 46], [360, 86]]
const MATRIX_STATES = ['idle', 'selected', 'hovered', 'active']
const COLORS = ['#5687de', '#36bfa2', '#d36a86', '#c99b48']

const baseClip = {
  id: 1,
  velocity: 1,
  fadeInPercent: 18,
  fadeOutPercent: 24,
  fadeInX1: 0.18,
  fadeInY1: 0,
  fadeInX2: 0.72,
  fadeInY2: 1,
  fadeOutX1: 0.18,
  fadeOutY1: 0,
  fadeOutX2: 0.72,
  fadeOutY2: 1,
}

function drawControlCanvas({ width, height, state, color, clipPatch = {} }) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  const ctx = canvas.getContext('2d')
  const clip = { ...baseClip, ...clipPatch }
  const selected = state === 'selected' || state === 'active'
  const hovered = state === 'hovered' ? { clipId: clip.id, kind: 'volume' } : null
  const active = state === 'active' ? { clipId: clip.id, kind: 'volume', value: clip.velocity } : null

  const body = ctx.createLinearGradient(0, 0, 0, height)
  body.addColorStop(0, color)
  body.addColorStop(1, '#25334f')
  ctx.fillStyle = body
  ctx.fillRect(0, 0, width, height)
  ctx.strokeStyle = selected ? '#87b7ff' : 'rgba(255,255,255,.24)'
  ctx.lineWidth = selected ? 2 : 1
  ctx.strokeRect(0.5, 0.5, Math.max(0, width - 1), Math.max(0, height - 1))
  drawClipFadeOverlay(ctx, clip, 0, 0, width, height, selected, 'rgba(3,7,16,.72)', CLIP_CONTROL_DEFAULTS)
  drawClipInlineControls(
    ctx, clip, 0, 0, width, height, color, selected,
    active, hovered, CLIP_CONTROL_DEFAULTS,
  )
  return canvas
}

function labelledCanvas(label, options) {
  const item = document.createElement('figure')
  const caption = document.createElement('figcaption')
  caption.textContent = label
  item.append(caption, drawControlCanvas(options))
  return item
}

const matrix = document.querySelector('#matrix-grid')
for (const [stateIndex, state] of MATRIX_STATES.entries()) {
  for (const [sizeIndex, [width, height]] of MATRIX_SIZES.entries()) {
    matrix.append(labelledCanvas(
      `${state} · ${width}×${height}`,
      { width, height, state, color: COLORS[(stateIndex + sizeIndex) % COLORS.length] },
    ))
  }
}

const cases = [
  ['short', { width: 40, height: 20, state: 'selected' }],
  ['normal', { width: 180, height: 46, state: 'idle' }],
  ['long', { width: 360, height: 86, state: 'idle' }],
  ['selected', { width: 180, height: 46, state: 'selected' }],
  ['hovered', { width: 180, height: 46, state: 'hovered' }],
  ['active', { width: 180, height: 46, state: 'active' }],
  ['unity', { width: 180, height: 46, state: 'selected', clipPatch: { velocity: 1 } }],
  ['muted', { width: 180, height: 46, state: 'selected', clipPatch: { velocity: 0 } }],
  ['maximum gain', { width: 180, height: 46, state: 'selected', clipPatch: { velocity: 2 } }],
  ['overlapping fades', { width: 180, height: 46, state: 'selected', clipPatch: { fadeInPercent: 49, fadeOutPercent: 49 } }],
]
const caseGrid = document.querySelector('#case-grid')
for (const [index, [label, options]] of cases.entries()) {
  caseGrid.append(labelledCanvas(label, { color: COLORS[index % COLORS.length], ...options }))
}

document.documentElement.dataset.ready = 'true'
