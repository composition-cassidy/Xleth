import { useCallback, useEffect, useState } from 'react'
import { Button, Menu, MenuCustom, MenuItem, Toggle } from '../ui-kit'
import { playheadClock } from '../services/PlayheadClock.js'
import styles from './PreviewHeader.module.css'
import { iconComponent } from '../ui-kit/icons'
import PreviewGradeControls from './colorGrade/PreviewGradeControls.jsx'

const IcCaretDown = iconComponent('caret-down')
const IcGridNine = iconComponent('grid-nine')
const IcInfo = iconComponent('info')
const IcTrayArrowDown = iconComponent('tray-arrow-down')

export const RESOLUTION_CHOICES = [
  { value: 'auto', label: 'Auto' },
  { value: '1.0', label: '100%' },
  { value: '0.75', label: '75%' },
  { value: '0.5', label: '50%' },
  { value: '0.25', label: '25%' },
]

export const POSTER_CHIP_HINT = 'Poster frames: grid cells show one still frame per sample, so the preview is faster but not frame-accurate. Exports are always full-fidelity.'

/** What the renderer is, in words. WebGL is the default, so only the others become a chip. */
export function rendererLabel(mode) {
  if (mode === 'webgl') return 'WebGL'
  if (mode === 'canvas2d') return 'Canvas 2D'
  if (mode === 'no-shm' || mode === 'shm-error') return 'No preview surface'
  return 'Starting'
}

/** The menu value that matches the current resolution state. */
export function pickedResolution(autoResolution, resolutionScale) {
  if (autoResolution) return 'auto'
  const hit = RESOLUTION_CHOICES.find((c) => c.value !== 'auto' && Math.abs(parseFloat(c.value) - resolutionScale) < 0.001)
  return hit ? hit.value : String(resolutionScale)
}

function usePlaying() {
  const [playing, setPlaying] = useState(() => playheadClock.isPlaying)
  useEffect(() => {
    const sync = () => setPlaying((prev) => (prev === playheadClock.isPlaying ? prev : playheadClock.isPlaying))
    sync()
    return playheadClock.onDisplayUpdate(sync)
  }, [])
  return playing
}

/** A state that differs from the default, as a neutral chip. Never warning-coloured. */
function StateChip({ label, hint }) {
  return (
    <span className={styles.chip} data-hint={hint}>
      <IcInfo className={styles.chipGlyph} aria-hidden="true" />
      <span className={styles.chipText}>{label}</span>
      <span className={styles.srOnly}>{`. ${hint}`}</span>
    </span>
  )
}

/**
 * The Preview's header. Right: FPS (only while playing), state chips (only when a
 * state differs from the default), the View menu (renderer, resolution, quality),
 * then FX, Edit (grid) and Import.
 *
 * inTitlebar: a floating or maximized Preview has a window titlebar, so the
 * controls are portaled into it (PreviewPanel owns the slot) instead of taking
 * a second 28px row. The slot is the size container there, not this element.
 */
export default function PreviewHeader({
  fps,
  mode,
  outputDims,
  resolutionScale,
  autoResolution,
  onResolutionChange,
  effectsBypass,
  onEffectsToggle,
  posterMode,
  onPosterToggle,
  gridEditMode,
  onGridEditChange,
  importing,
  onImport,
  headerActions = null,
  inTitlebar = false,
}) {
  const playing = usePlaying()
  const [menu, setMenu] = useState(null)
  const closeMenu = useCallback(() => setMenu(null), [])

  const openMenu = (event) => {
    if (menu) { setMenu(null); return }
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({ x: rect.left, y: rect.bottom + 2 })
  }

  const sizeText = outputDims.w > 0 ? `${outputDims.w}×${outputDims.h}` : null
  const picked = pickedResolution(autoResolution, resolutionScale)
  const fault = mode !== 'webgl' && mode !== 'init' ? rendererLabel(mode) : null

  return (
    <div
      className={inTitlebar ? `${styles.header} ${styles.inTitlebar}` : styles.header}
      data-testid="preview-header"
      data-in-titlebar={inTitlebar ? 'true' : undefined}
    >
      <div className={styles.right}>
        {playing ? (
          <span className={styles.fps} data-hint="Frames drawn per second in the Preview while playing">{fps} FPS</span>
        ) : null}
        {posterMode ? <StateChip label="Poster" hint={POSTER_CHIP_HINT} /> : null}
        {fault ? (
          <StateChip
            label={fault}
            hint={mode === 'canvas2d'
              ? 'WebGL is unavailable, so the Preview is drawn in software and may be slower.'
              : 'The shared-memory surface the engine draws into could not be opened.'}
          />
        ) : null}

        <Button
          size="sm"
          glyph={<IcCaretDown />}
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          aria-label="View"
          hint="View: renderer, resolution and quality of the Preview"
          onClick={openMenu}
        >
          <span className={styles.viewLabel}>View</span>
        </Button>

        <PreviewGradeControls labelClass={styles.label} />

        <Toggle
          size="sm"
          on={!effectsBypass}
          onChange={() => onEffectsToggle()}
          hint={effectsBypass
            ? 'Effects are bypassed in the Preview: click to apply them'
            : 'Effects are applied in the Preview: click to bypass them'}
        >
          FX
        </Toggle>
        {/* "Edit" then the grid glyph: it reads as "Edit grid" in five letters. */}
        <Toggle
          size="sm"
          on={gridEditMode}
          onChange={onGridEditChange}
          glyph={<IcGridNine aria-hidden="true" />}
          glyphEnd
          aria-label="Edit grid"
          hint="Edit the grid layout on the picture"
        >
          <span className={styles.label}>Edit</span>
        </Toggle>
        <Button
          size="sm"
          glyph={<IcTrayArrowDown />}
          aria-label="Import"
          disabled={importing}
          hint="Import a video source for the preview timeline"
          onClick={onImport}
        >
          <span className={styles.label}>{importing ? 'Loading…' : 'Import'}</span>
        </Button>
        {headerActions}
      </div>

      {menu ? (
        <Menu x={menu.x} y={menu.y} onClose={closeMenu} label="Preview view">
          <MenuCustom>
            <div className={styles.menuHead}>Renderer</div>
            <div className={styles.menuNote}>{rendererLabel(mode)}</div>
          </MenuCustom>
          <MenuCustom>
            <div className={styles.menuHead}>
              {sizeText ? `Resolution · ${sizeText}${autoResolution ? ' (auto)' : ''}` : 'Resolution'}
            </div>
          </MenuCustom>
          {RESOLUTION_CHOICES.map((choice) => (
            <MenuItem key={choice.value} checked={picked === choice.value} onSelect={() => onResolutionChange(choice.value)}>
              {choice.label}
            </MenuItem>
          ))}
          <MenuCustom>
            <div className={styles.menuHead}>Quality</div>
          </MenuCustom>
          <MenuItem checked={posterMode} onSelect={() => { if (!posterMode) onPosterToggle() }}>
            Poster frames (faster)
          </MenuItem>
          <MenuItem checked={!posterMode} onSelect={() => { if (posterMode) onPosterToggle() }}>
            Live frames (every frame)
          </MenuItem>
        </Menu>
      ) : null}
    </div>
  )
}
