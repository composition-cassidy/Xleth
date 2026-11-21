import { useState } from 'react'
import useSandboxStore from '../../stores/sandboxStore.js'
import { Button, Menu, MenuCustom } from '../../ui-kit'
import { formatSamples, formatSamplesShort, formatHz } from './sandboxFormat.js'
import { resolveView, viewSpan, isFitted } from './sandboxView.js'
import { activeToolOf, SANDBOX_KEYS, TOOL_HINTS } from './sandboxToolConstants.js'
import { formatCombo } from '../../windowing/managers/shortcutCatalog.ts'
import { resolveCombo } from '../../windowing/managers/shortcutOverrides.ts'
import SandboxRenderChip from './SandboxRenderChip.jsx'
import styles from './Sandbox.module.css'
import { iconComponent } from '../../ui-kit/icons'

const IcKeyboard = iconComponent('keyboard')

// ── Status line ─────────────────────────────────────────────────────────────
//
// One line. Left: what the pointer does with the armed tool. Right: the facts
// that have no control of their own to live on — how much of the layer is on
// screen, the spectral readout, what is on the clipboard, and whether the mix
// Play will use is rendered.
//
// It used to be up to four stacked lines: Cursor / Selection / Length on the
// left (now the transport's own Start / End / Length boxes), a layer count and
// an undo depth on the right (the layer list and the Undo button say both).
// The key legend that filled the foot of the old tool column is the Keys
// button here.
//
// Time formatting is shared with the ruler and the edit stack (sandboxFormat.js).

// Time × Hz span of a committed SPC selection's shapes — min/max across every
// shape, so a multi-shape freehand selection reads as ONE bounding readout
// rather than a list. `sampleRate` is the rendered buffer's own rate, same
// convention every other readout in this file uses.
function spcSelectionSpan(spcSelection, sampleRate) {
  const shapes = spcSelection?.shapes
  if (!shapes?.length || !sampleRate) return null
  let startSample = Infinity, endSample = -Infinity, minHz = Infinity, maxHz = -Infinity
  for (const s of shapes) {
    startSample = Math.min(startSample, s.centerSample - s.halfWidthSamples)
    endSample   = Math.max(endSample, s.centerSample + s.halfWidthSamples)
    minHz = Math.min(minHz, s.centerFreqHz - s.halfHeightHz)
    maxHz = Math.max(maxHz, s.centerFreqHz + s.halfHeightHz)
  }
  return { startSample, endSample, minHz: Math.max(0, minHz), maxHz }
}

// Composite auto-render state, folded into the same idle/rendering/ready/
// error vocabulary the per-layer render chip uses. `debouncePending` /
// `pending` (sandboxStore's compositeAutoRender) both mean "a render is
// scheduled or in flight" — see _scheduleCompositeAutoRender /
// _runCompositeAutoRender.
function compositeChipState(composite, compositeAutoRender) {
  if (composite.renderState === 'error') return 'error'
  if (compositeAutoRender.debouncePending || compositeAutoRender.pending || composite.renderState === 'rendering') return 'rendering'
  if (composite.renderState === 'ready') return 'ready'
  return 'idle'
}

// The Keys list's size, for placing it above its button: two columns of groups, about 20px a row.
const KEYS_MENU_W = 520
const KEYS_MENU_H = 310

// "Mix" is what Play plays: every layer, by its gain, pan, offset, mute and solo.
const MIX_CHIP_LABEL = {
  idle: 'Mix not rendered', rendering: 'Rendering mix…', ready: 'Mix ready', error: 'Mix failed',
}
const MIX_CHIP_TITLE = {
  idle: 'The mix of all layers renders the first time you press Play',
  rendering: 'Rendering the mix of all layers',
  ready: 'The mix of all layers is rendered and up to date',
  error: 'The mix could not be rendered',
}

export default function SandboxStatusBar() {
  const layers = useSandboxStore((s) => s.layers)
  const activeLayerId = useSandboxStore((s) => s.activeLayerId)
  const clipboard = useSandboxStore((s) => s.clipboard)
  const viewMode = useSandboxStore((s) => s.viewMode)
  const spcSelection = useSandboxStore((s) => s.spcSelection)
  const spcHoverReadout = useSandboxStore((s) => s.spcHoverReadout)
  const composite = useSandboxStore((s) => s.composite)
  const compositeAutoRender = useSandboxStore((s) => s.compositeAutoRender)
  const view = useSandboxStore((s) => s.view)
  const envelopeEditMode = useSandboxStore((s) => s.envelopeEditMode)
  const paintEditMode = useSandboxStore((s) => s.paintEditMode)
  const spcSelectMode = useSandboxStore((s) => s.spcSelectMode)
  const [keysAt, setKeysAt] = useState(null)
  const layer = layers.find((l) => l.id === activeLayerId) ?? null

  // What the pointer currently does.
  const toolHint = TOOL_HINTS[activeToolOf({ paintEditMode, envelopeEditMode, spcSelectMode })]

  const sampleRate = layer?.renderedBuffer?.sampleRate
  const numSamples = layer?.renderedBuffer?.numSamples ?? 0
  const fitted = isFitted(view, numSamples)
  const visibleSamples = viewSpan(resolveView(view, numSamples))

  const chipState = compositeChipState(composite, compositeAutoRender)

  // Time × Hz readout — live under the pointer while hovering the SPC canvas,
  // falling back to the committed region selection's own bounding span so the
  // readout stays informative between drags, then to '—' when neither exists.
  // Only shown in SPC view: WAV has no frequency axis for this to describe.
  const spcSpan = spcSelectionSpan(spcSelection, sampleRate)
  const spcReadout = viewMode !== 'spc'
    ? null
    : spcHoverReadout
      ? `${spcHoverReadout.sec.toFixed(3)} s, ${formatHz(spcHoverReadout.hz)} Hz`
      : spcSpan
        ? `${formatSamples(spcSpan.startSample, sampleRate)}–${formatSamples(spcSpan.endSample, sampleRate)} s, ${formatHz(spcSpan.minHz)}–${formatHz(spcSpan.maxHz)} Hz`
        : '—'

  const openKeys = (e) => {
    if (keysAt) { setKeysAt(null); return }
    const r = e.currentTarget.getBoundingClientRect()
    // Opens upward, since the button sits on the bottom edge of the panel. The kit Menu takes its top-left
    // corner and clamps itself into the window, so aim above the button by the list's own height.
    setKeysAt({ x: r.right - KEYS_MENU_W, y: r.top - 4 - KEYS_MENU_H })
  }

  return (
    <div className={styles.status}>
      <span className={styles.hint}>{layer ? toolHint : 'Drop a sample or an audio file to begin'}</span>

      <div className={styles.readouts}>
        {viewMode === 'spc' && (
          <span className={styles.readout}>Pointer <span className={styles.mono}>{spcReadout}</span></span>
        )}
        {/* Zoom, stated as a span rather than a percentage: "0.42s visible" is
            the number you can act on when deciding whether to zoom further,
            and "1400%" is not. */}
        {!!layer && (
          <span className={styles.readout} title="How much of the layer is on screen. Ctrl+F fits the whole layer">
            View <span className={styles.mono}>{fitted ? 'all' : formatSamplesShort(visibleSamples, sampleRate)}</span>
          </span>
        )}
        <span className={styles.readout}>
          Clipboard <span className={styles.mono}>{clipboard ? formatSamplesShort(clipboard.numSamples, sampleRate) : 'empty'}</span>
        </span>
        <SandboxRenderChip state={chipState} title={MIX_CHIP_TITLE[chipState]}>{MIX_CHIP_LABEL[chipState]}</SandboxRenderChip>
        <Button
          size="sm" variant="ghost" glyph={<IcKeyboard />}
          aria-haspopup="menu" aria-expanded={!!keysAt}
          onClick={openKeys}
          hint="Keys" hintMods="The Sandbox's keyboard and mouse shortcuts. Rebind them in Settings, Shortcuts"
        >
          Keys
        </Button>
      </div>

      {keysAt && (
        <Menu x={keysAt.x} y={keysAt.y} onClose={() => setKeysAt(null)} label="Sandbox keys" className={styles.keysMenu}>
          <MenuCustom>
            <div className={styles.keys}>
              {SANDBOX_KEYS.map(([group, rows]) => (
                <div key={group} className={styles.keyGroup} role="group" aria-label={group}>
                  <div className={styles.keysTitle}>{group}</div>
                  {rows.map((row) => (
                    <span key={row.cmd ?? row.keys} className={styles.keyRow}>
                      <kbd className={styles.kbd}>{row.keys ?? formatCombo(resolveCombo(row.cmd))}</kbd>
                      <span>{row.what}</span>
                    </span>
                  ))}
                </div>
              ))}
            </div>
          </MenuCustom>
        </Menu>
      )}
    </div>
  )
}
