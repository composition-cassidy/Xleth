import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { IconButton, Menu, MenuItem, MenuSeparator, Pearl, TextField } from '../../ui-kit'
import { iconComponent } from '../../ui-kit/icons'
import Disclosure from '../browser/Disclosure.jsx'
import ParentPicker from './ParentPicker.jsx'
import MotionValueCell from './MotionValueCell.jsx'
import { useMotionTick } from './motionTick.js'
import { useMotionViewStore } from '../../motion/motionViewStore.js'
import { rowKeys, rowIndexAtY } from '../../motion/rowRegistry.js'
import { SAME_TICK, instanceIndexAfter, playingInstanceAt } from '../../motion/providers/common.js'
import { formatValue, propertyById } from '../../motion/schema.js'
import {
  cloneKindLabel, formatDelay, isClone, isTrailClone, sourceOf, voiceNumberOf,
} from '../../clones/cloneModel.js'
import styles from './MotionView.module.css'

// The Motion view property tree (docs/XLETH_MOTION_VIEW_DESIGN.md 5.3, R3, R4, R24):
// the DOM header column of Motion view, beside the canvas key area. Rows sit at
// their layout y (rowRegistry.buildMotionRows) inside a spacer as tall as the
// content, and only the rows near the viewport are mounted (in blocks of
// WINDOW_BLOCK, so scrolling re-renders a few times per screen, not per frame).
//
//   track row     twirl, identity chip, name, kind tag, output pearl (the same
//                 mute / solo handlers as the Edit headers), Parent picker. A Clone
//                 (docs/XLETH_CLONE_SPEC.md) is indented under its source and tagged
//                 "Voice clone" / "Trail clone"; a Trail shows "follows <source>"
//                 where other tracks have the Parent picker (it cannot have one)
//   group row     twirl, label (Masks: count + Add mask menu; Mask n: delete). A
//                 group with no rows (a Linked Voice clone's Lens) is a read-only line
//   property row  key toggle (animatable rows only, R3), label, value cell (R4),
//                 key navigation: previous, add / at key, next
//
// Live values follow the playhead at the display rate through useMotionTick, with
// a selector per cell that returns a primitive, so a cell re-renders only when
// ITS value, toggle or navigation state changes.

const IcPlus = iconComponent('plus')
const IcTrash = iconComponent('trash')
const IcPrev = iconComponent('caret-left')
const IcNext = iconComponent('caret-right')

export const WINDOW_BLOCK = 16
const OVERSCAN_PX = 240
export const NAV_WIDTH = 72

const KIND_TAG = { Pattern: 'Pattern', Clip: 'Clip' }
const TRAIL_OPACITY = propertyById('trail.opacity')

/** The kind tag of a track row: 'Voice clone' / 'Trail clone' / 'Pattern' / 'Clip'. */
export const trackKindTag = (t) => cloneKindLabel(t) ?? KIND_TAG[t?.type] ?? 'Clip'

/** The name of the track a Trail follows ('its source' when it is gone), or null for any other track. */
export function followsName(t, allTracks) {
  if (!isTrailClone(t)) return null
  return sourceOf(allTracks, t)?.name ?? 'its source'
}

/** The hint of a track row; a Clone says what it is, whose it is and what it plays. */
export function trackRowHint(t, data, allTracks) {
  const name = t?.name ?? `Track ${t?.id}`
  if (!isClone(t)) return `${name}: its motion. The key area shows its ${t?.type === 'Pattern' ? 'notes' : 'clips'} for reference`
  const src = sourceOf(allTracks, t)?.name ?? 'its source'
  const c = data?.cloneOf?.(t.id) ?? null
  if (isTrailClone(t)) {
    const how = c ? `${formatDelay(c.delayTicks)} behind, tinted ${c.tint}, at ${formatValue(TRAIL_OPACITY, c.opacity)} opacity` : 'behind it'
    return `${name}: Trail clone. It follows ${src}'s whole picture ${how}. Video only. The key area shows ${src}'s notes, shifted by the delay`
  }
  const voice = voiceNumberOf(allTracks, t)
  const lens = c?.lensMode === 'Own' ? 'its own Lens' : `${src}'s Lens`
  return `${name}: Voice clone${voice ? ` (voice ${voice})` : ''}. It plays the notes ${src} cannot, in its own cell, with ${lens}. Video only. The key area shows the notes it plays`
}

/** [first, end) row indices to mount for a scroll position, snapped outward to WINDOW_BLOCK. */
export function treeWindow(layout, scrollTop, height) {
  const n = layout?.rows?.length ?? 0
  if (n === 0) return [0, 0]
  const a = rowIndexAtY(layout, Math.max(0, scrollTop - OVERSCAN_PX))
  const b = rowIndexAtY(layout, Math.max(0, scrollTop + Math.max(height, 1) + OVERSCAN_PX))
  const first = Math.floor(a / WINDOW_BLOCK) * WINDOW_BLOCK
  const end = Math.min(n, (Math.floor(b / WINDOW_BLOCK) + 1) * WINDOW_BLOCK)
  return [first, end]
}

/** What a row's key toggle, value and navigation read at a tick (primitives only: zustand v5 selectors). */
export function rowValueKey(row, data, tick) {
  const p = row.prop
  const v = row.provider.valueAt(row, data, tick)
  if (p.type === 'motionBlur') return v ? `${v.enabled ? 1 : 0}:${v.shutterAngleDeg}` : null
  if (p.type === 'shape') return v?.kind ?? null
  return v ?? null
}

const blockerAt = (row, data, tick, intent) => row.provider.editBlocker?.(row, data, tick, intent) ?? null

/**
 * The key navigation state at a tick: bit 1 = a key before, 2 = a key after, 4 = at a key.
 * Runs per mounted property row on every display tick: binary searches over the
 * row's cached keys (sorted by tick), nothing allocated. Keys that do not play
 * (`outside`) are skipped, like the previous / next buttons skip them. "At a key"
 * is the key the add / remove button acts on (the provider's keyAtPlayhead when it
 * has one: the key of the event that plays at a boundary).
 */
export function navState(row, data, tick) {
  const keys = rowKeys(row, data)
  const n = keys.length
  if (n === 0) return 0
  let s = 0
  for (let i = instanceIndexAfter(keys, tick - SAME_TICK, false) - 1; i >= 0; i--) {
    if (!keys[i].outside) { s |= 1; break }
  }
  for (let i = instanceIndexAfter(keys, tick + SAME_TICK); i < n; i++) {
    if (!keys[i].outside) { s |= 2; break }
  }
  const at = row.provider.keyAtPlayhead
    ? row.provider.keyAtPlayhead(row, data, tick, keys)
    : playingInstanceAt(keys, tick)
  if (at) s |= 4
  return s
}

// ── Glyphs (inline: the icon set has no stopwatch or key diamond) ─────────────

function StopwatchGlyph({ on }) {
  return (
    <svg className={styles.glyph} width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.5 1.5h3M7 1.5v1.6" stroke="currentColor" strokeWidth="1.3" fill="none" />
      {on
        ? <path d="M7 5.2l2.8 2.8L7 10.8 4.2 8z" fill="currentColor" />
        : <path d="M7 8V5.4" stroke="currentColor" strokeWidth="1.3" fill="none" />}
    </svg>
  )
}

function KeyGlyph({ filled }) {
  return (
    <svg className={styles.glyph} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M6 1.5L10.5 6 6 10.5 1.5 6z" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

const indentOf = (row) => ({ paddingLeft: row.depth * 14 })

// ── Rows ─────────────────────────────────────────────────────────────────────

function Twirl({ row, onToggle }) {
  return (
    <button
      type="button"
      className={styles.twirl}
      aria-expanded={row.expanded}
      aria-label={`${row.expanded ? 'Collapse' : 'Expand'} ${row.label}`}
      data-hint={row.expanded ? `Collapse ${row.label}` : `Expand ${row.label}`}
      data-hint-mods="Alt+click: every row inside it"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => onToggle(row, e)}
      data-testid={`motion-twirl-${row.key}`}
    >
      <Disclosure open={row.expanded} />
    </button>
  )
}

const TrackRow = memo(function TrackRow({
  row, api, allTracks, selected, focused, color, heard, parentTrackId, kindTag, follows, hint,
}) {
  const t = row.track
  return (
    <div
      className={styles.row}
      data-kind="track"
      data-clone={isClone(t) || undefined}
      data-selected={selected || undefined}
      data-focused={focused || undefined}
      data-muted={!heard || undefined}
      style={{ top: row.y, height: row.height, ...indentOf(row), '--track-chip': color }}
      data-testid={`motion-row-${row.key}`}
      data-hint={hint}
      data-hint-mods="Click: select · Ctrl: toggle · Shift: add · Twirl: show its properties"
    >
      <Twirl row={row} onToggle={api.toggle} />
      <span className={styles.chip} aria-hidden="true" />
      <span
        className={styles.label}
        role="button"
        tabIndex={-1}
        onMouseDown={(e) => api.selectRow(row, e)}
      >
        <span className={styles.labelText}>{t.name ?? `Track ${t.id}`}</span>
        <span className={styles.tag}>{kindTag}</span>
      </span>
      <span className={styles.trackTools}>
        <Pearl
          lit={heard}
          label={t.name ?? `Track ${t.id}`}
          onToggle={() => api.pearl(t.id, 'toggle')}
          onSolo={() => api.pearl(t.id, 'solo')}
        />
        {follows !== null ? (
          <span
            className={styles.follows}
            data-testid={`motion-follows-${t.id}`}
            data-hint={`A Trail clone always follows ${follows}: it has no cell of its own, so it cannot have a Parent or be one`}
          >
            {`follows ${follows}`}
          </span>
        ) : (
          <ParentPicker
            trackId={t.id}
            tracks={allTracks}
            parentTrackId={parentTrackId}
            onChoose={(id, opts) => api.chooseParent(t.id, id, opts)}
            className={styles.parent}
            data-testid={`motion-parent-${t.id}`}
          />
        )}
      </span>
    </div>
  )
})

function AddMaskButton({ row, api }) {
  const [anchor, setAnchor] = useState(null)
  const ref = useRef(null)
  const blockers = api.maskBlockers(row.trackId)
  const open = (e) => {
    e.stopPropagation()
    if (anchor) { setAnchor(null); return }
    const r = ref.current?.getBoundingClientRect?.()
    setAnchor({ x: r ? r.left : 0, y: r ? r.bottom + 2 : 0 })
  }
  const pick = (kind) => { setAnchor(null); api.addMask(row.trackId, kind) }
  const item = (kind, label) => (
    <MenuItem disabled={!!blockers[kind]} onSelect={() => pick(kind)}>
      {blockers[kind] ? `${label}: ${blockers[kind]}` : label}
    </MenuItem>
  )
  return (
    <>
      <IconButton
        ref={ref}
        size="sm"
        label="Add mask"
        hint="Add mask: Rectangle, Ellipse, or a Path drawn on the viewer"
        hintMods="Up to 8 masks, 32 points each, 64 points per track"
        onMouseDown={(e) => { e.stopPropagation() }}
        onClick={open}
        data-testid={`motion-add-mask-${row.trackId}`}
      >
        <IcPlus size={14} />
      </IconButton>
      {anchor ? (
        <Menu x={anchor.x} y={anchor.y} onClose={() => setAnchor(null)} label="Add mask">
          {item('Rectangle', 'Rectangle')}
          {item('Ellipse', 'Ellipse')}
          <MenuSeparator />
          {item('Path', 'Path (draw on the viewer)')}
        </Menu>
      ) : null}
    </>
  )
}

/** The right-click menu of a "Mask n" row: Rename, Duplicate, Move up / down, Delete (R15 caps in the item). */
function MaskRowMenu({ row, api, at, onClose, onRename }) {
  const { trackId } = row
  const maskId = row.target.maskId
  const st = api.maskMenuState(trackId, maskId)
  return (
    <Menu x={at.x} y={at.y} kind="context" label={row.label} onClose={onClose}>
      <MenuItem onSelect={onRename}>Rename</MenuItem>
      <MenuItem disabled={!!st.duplicateBlocker} onSelect={() => api.duplicateMask(trackId, maskId)}>
        {st.duplicateBlocker ? `Duplicate: ${st.duplicateBlocker}` : 'Duplicate'}
      </MenuItem>
      <MenuSeparator />
      <MenuItem disabled={st.index <= 0} onSelect={() => api.moveMask(trackId, maskId, -1)}>Move up</MenuItem>
      <MenuItem disabled={st.index < 0 || st.index >= st.count - 1} onSelect={() => api.moveMask(trackId, maskId, 1)}>Move down</MenuItem>
      <MenuSeparator />
      <MenuItem danger onSelect={() => api.deleteMask(trackId, maskId)}>Delete</MenuItem>
    </Menu>
  )
}

/** The inline name field of a mask row: Enter or leaving it renames, Escape keeps the name. */
function MaskNameField({ row, api, onDone }) {
  const [text, setText] = useState(row.label)
  const done = useRef(false)
  const finish = (save) => {
    if (done.current) return
    done.current = true
    if (save) api.renameMask(row.trackId, row.target.maskId, text)
    onDone()
  }
  return (
    <TextField
      size="sm"
      label={`Name of ${row.label}`}
      hint={`Rename ${row.label}`}
      hintMods="Enter: rename · Escape: keep the name · up to 64 characters"
      className={styles.nameField}
      value={text}
      maxLength={64}
      autoFocus
      onChange={setText}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true) } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false) }
      }}
      onBlur={() => finish(true)}
      data-testid={`motion-mask-name-${row.key}`}
    />
  )
}

const GroupRow = memo(function GroupRow({ row, api, selected }) {
  const isMasks = row.groupId === 'masks'
  const isMask = row.groupId === 'mask'
  const readOnly = !row.expandable
  const [menuAt, setMenuAt] = useState(null)
  const [renaming, setRenaming] = useState(false)
  return (
    <div
      className={styles.row}
      data-kind="group"
      data-readonly={readOnly || undefined}
      data-selected={selected || undefined}
      style={{ top: row.y, height: row.height, ...indentOf(row) }}
      data-testid={`motion-row-${row.key}`}
      data-hint={row.hint ?? row.label}
      data-hint-mods={isMask
        ? 'Click: select (the viewer shows its shape) · Double-click the name: rename · Right-click: rename, duplicate, reorder, delete'
        : readOnly ? 'Read-only: nothing to key here' : 'Click: select its rows · Twirl: show them'}
      onContextMenu={isMask ? (e) => { e.preventDefault(); setMenuAt({ x: e.clientX, y: e.clientY }) } : undefined}
    >
      {readOnly ? <span className={styles.slot} aria-hidden="true" /> : <Twirl row={row} onToggle={api.toggle} />}
      {renaming ? (
        <MaskNameField row={row} api={api} onDone={() => setRenaming(false)} />
      ) : (
        <span
          className={styles.label}
          role="button"
          tabIndex={-1}
          onMouseDown={(e) => api.selectRow(row, e)}
          onDoubleClick={isMask ? () => setRenaming(true) : undefined}
        >
          <span className={styles.labelText}>{row.label}</span>
          {isMasks ? <span className={styles.count} aria-label={`${row.count ?? 0} masks`}>{row.count ?? 0}</span> : null}
        </span>
      )}
      {isMasks ? <AddMaskButton row={row} api={api} /> : null}
      {isMask ? (
        <IconButton
          size="sm"
          label={`Delete ${row.label}`}
          hint={`Delete ${row.label}`}
          hintMods="Ctrl+Z undoes it"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => api.deleteMask(row.trackId, row.target.maskId)}
          data-testid={`motion-delete-mask-${row.key}`}
        >
          <IcTrash size={14} />
        </IconButton>
      ) : null}
      {menuAt ? (
        <MaskRowMenu row={row} api={api} at={menuAt} onClose={() => setMenuAt(null)} onRename={() => setRenaming(true)} />
      ) : null}
    </div>
  )
})

const PropRow = memo(function PropRow({ row, api, data, selected, valueWidth }) {
  const p = row.prop
  const provider = row.provider
  const tickSel = useCallback((s) => rowValueKey(row, data, s.tick), [row, data])
  const valueKey = useMotionTick(tickSel)
  const animated = useMotionTick(useCallback((s) => provider.isAnimated(row, data, s.tick), [provider, row, data]))
  const valueBlocker = useMotionTick(useCallback((s) => blockerAt(row, data, s.tick, 'value'), [row, data]))
  const swBlocker = useMotionTick(useCallback((s) => (p.animatable ? blockerAt(row, data, s.tick, 'stopwatch') : null), [p, row, data]))
  const keyBlocker = useMotionTick(useCallback((s) => (p.animatable ? blockerAt(row, data, s.tick, 'key') : null), [p, row, data]))
  const nav = useMotionTick(useCallback((s) => (p.animatable ? navState(row, data, s.tick) : 0), [p, row, data]))

  const value = p.type === 'motionBlur' ? data.motionBlur : p.type === 'shape' ? (valueKey ? { kind: valueKey } : null) : valueKey
  const h = provider.hint(row)
  const atKey = (nav & 4) !== 0
  return (
    <div
      className={styles.row}
      data-kind="prop"
      data-selected={selected || undefined}
      data-animated={animated || undefined}
      style={{ top: row.y, height: row.height, ...indentOf(row) }}
      data-testid={`motion-row-${row.key}`}
      data-hint={h.hint}
      data-hint-mods={h.mods || 'Click: select the row (the graph shows it) · Ctrl: toggle · Shift: add'}
    >
      {p.animatable ? (
        <button
          type="button"
          className={styles.stopwatch}
          aria-pressed={animated}
          aria-label={`Animate ${p.label}`}
          disabled={!!swBlocker}
          data-hint={swBlocker ?? (animated
            ? `Key toggle: ${p.label} is animated. Off removes every key and keeps the value at the playhead`
            : `Key toggle: animate ${p.label}. On writes a key at the playhead`)}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => api.stopwatch(row, !animated)}
          data-testid={`motion-stopwatch-${row.key}`}
        >
          <StopwatchGlyph on={animated} />
        </button>
      ) : <span className={styles.slot} aria-hidden="true" />}
      <span className={styles.label} role="button" tabIndex={-1} onMouseDown={(e) => api.selectRow(row, e)}>
        <span className={styles.labelText}>{p.label}</span>
      </span>
      <MotionValueCell
        row={row}
        value={value}
        blocker={valueBlocker}
        animated={animated}
        hint={h.hint}
        width={valueWidth}
        onPlan={api.valuePlan}
        onMotionBlur={api.setMotionBlur}
      />
      <span className={`${styles.nav}${p.animatable ? '' : ` ${styles.navHidden}`}`} aria-hidden={!p.animatable || undefined}>
        <IconButton
          size="sm"
          label={`Previous ${p.label} key`}
          hint={`Previous ${p.label} key: move the playhead there`}
          disabled={!p.animatable || (nav & 1) === 0}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => api.jump(row, -1)}
          data-testid={`motion-prev-${row.key}`}
        >
          <IcPrev size={12} />
        </IconButton>
        <IconButton
          size="sm"
          label={atKey ? `Remove the ${p.label} key at the playhead` : `Add a ${p.label} key at the playhead`}
          className={styles.navBtn}
          data-at-key={atKey || undefined}
          disabled={!p.animatable || !!keyBlocker}
          hint={keyBlocker ?? (atKey ? `At a key: click removes the ${p.label} key at the playhead` : `Add a ${p.label} key at the playhead`)}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => api.toggleKey(row, atKey)}
          data-testid={`motion-key-${row.key}`}
        >
          <KeyGlyph filled={atKey} />
        </IconButton>
        <IconButton
          size="sm"
          label={`Next ${p.label} key`}
          hint={`Next ${p.label} key: move the playhead there`}
          disabled={!p.animatable || (nav & 2) === 0}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => api.jump(row, 1)}
          data-testid={`motion-next-${row.key}`}
        >
          <IcNext size={12} />
        </IconButton>
      </span>
    </div>
  )
})

/**
 * The tree. Props: layout, data, api (see MotionView), allTracks (the Parent picker), selectedRows, focusedTrackId,
 * colorOf(trackId), heardOf(trackId), parentOf(trackId), scrollRef (the tree scroller),
 * onScroll(scrollTop), bottomPad, valueWidth.
 */
export default function MotionTree({
  layout, data, api, allTracks, selectedRows, focusedTrackId, colorOf, heardOf, parentOf, scrollRef, onScroll, bottomPad = 24,
  valueWidth,
}) {
  const [win, setWin] = useState([0, WINDOW_BLOCK * 3])
  const sizeRef = useRef(0)

  const recompute = useCallback(() => {
    const sc = scrollRef.current
    const h = sc?.clientHeight || sizeRef.current || 800
    const next = treeWindow(layout, sc?.scrollTop ?? 0, h)
    setWin((cur) => (cur[0] === next[0] && cur[1] === next[1] ? cur : next))
  }, [layout, scrollRef])

  useLayoutEffect(() => { recompute() }, [recompute])

  useEffect(() => {
    const sc = scrollRef.current
    if (!sc || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => { sizeRef.current = sc.clientHeight; recompute() })
    ro.observe(sc)
    return () => ro.disconnect()
  }, [recompute, scrollRef])

  const handleScroll = (e) => {
    recompute()
    onScroll?.(e.currentTarget.scrollTop)
  }

  const rows = layout?.rows ?? []
  const [first, end] = win
  const out = []
  for (let i = first; i < Math.min(end, rows.length); i++) {
    const row = rows[i]
    const selected = selectedRows?.has(row.key) ?? false
    if (row.kind === 'track') {
      out.push(
        <TrackRow
          key={row.key}
          row={row}
          api={api}
          allTracks={allTracks}
          selected={selected}
          focused={focusedTrackId === row.trackId}
          color={colorOf(row.trackId)}
          heard={heardOf(row.trackId)}
          parentTrackId={parentOf(row.trackId)}
          kindTag={trackKindTag(row.track)}
          follows={followsName(row.track, allTracks)}
          hint={trackRowHint(row.track, data, allTracks)}
        />,
      )
    } else if (row.kind === 'group') {
      out.push(<GroupRow key={row.key} row={row} api={api} selected={selected} />)
    } else {
      out.push(<PropRow key={row.key} row={row} api={api} data={data} selected={selected} valueWidth={valueWidth} />)
    }
  }

  return (
    <div className={styles.treeScroll} ref={scrollRef} onScroll={handleScroll} data-testid="motion-tree-scroll">
      <div
        className={styles.treeBody}
        style={{ height: (layout?.totalHeight ?? 0) + bottomPad }}
        role="tree"
        aria-label="Motion properties"
        onMouseDown={(e) => { if (e.target === e.currentTarget) useMotionViewStore.getState().clearRowSelection() }}
      >
        {rows.length === 0 ? (
          <div className={styles.empty} data-hint="Motion view lists every track's Lens, Roam, Masks and Sweep">
            No tracks yet: add one in the Edit view.
          </div>
        ) : out}
      </div>
    </div>
  )
}
