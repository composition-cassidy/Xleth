import { useCallback, useMemo, useRef, useState, useEffect } from 'react'
import { IconButton, isHeard } from '../../ui-kit'
import Disclosure from '../browser/Disclosure.jsx'
import TrackHeader from './TrackHeader.jsx'
import TrackColorPopover from './TrackColorPopover.jsx'
import TrackContextMenu from './TrackContextMenu.jsx'
import { RULER_HEIGHT, HEADER_WIDTH, ADD_TRACK_ROW_HEIGHT, TIMELINE_HSCROLL_HEIGHT } from '../../constants/timeline.js'
import { resolveAutoTrackColor, normalizeTrackPalette, TRACK_PALETTE_FALLBACK } from './trackColorResolver.js'
import { folderMapForLayout } from './trackFolderLayout.js'
import { FOLDER_ROW_HEIGHT } from './timelineRowLayout.js'
import { tokenValue } from '../../theming/tokenValue.ts'
import styles from './TrackHeaderList.module.css'
import { iconComponent } from '../../ui-kit/icons'
import { cloneKindOf, isClone, parseTint } from '../../clones/cloneModel.js'
import { draggableTrackIds } from './cloneTimeline.js'

const IcEyeSlash = iconComponent('eye-slash')
const IcFolder = iconComponent('folder')
const IcLock = iconComponent('lock-simple')
const IcPlus = iconComponent('plus')
const IcTrash = iconComponent('trash')
const IcXAutomation = iconComponent('xleth-automation')

const NO_MOTION = new Set()
/**
 * `motionTrackIds` (a Set, an array or null) as a Set of String(trackId), so a numeric
 * id and its string form both match. Anything that is not a list means "no motion".
 */
function motionTrackIdSet(ids) {
  if (ids == null || typeof ids[Symbol.iterator] !== 'function' || typeof ids === 'string') return NO_MOTION
  const out = new Set()
  for (const id of ids) {
    if (id != null) out.add(String(id))
  }
  return out
}

export default function TrackHeaderList({
  tracks,
  focusedTrackId, onFocusTrack, onOpenInMixer,
  onAddTrack, onMute, onSolo, onPearl, onVisualOnly, onRename, onRequestContextMenu,
  onSetTrackColor,
  folderLayout,
  selectedTrackIds = new Set(),
  onSelectTrack,
  onClearSelection,
  onMoveTracks,
  onMoveFolder,
  onToggleFolder,
  onRenameFolder,
  onRemoveFolder,
  editingFolderId = null,
  onFinishFolderEdit,
  scrollContainerRef,
  width = HEADER_WIDTH,
  trackHeight,
  macroRows = [],
  // Reel lane (read-only video lane under a Pattern track with video): one row
  // per such track, and the collapse toggle.
  reelRows = [],
  onToggleReelLane,
  // Clone rows (timelineRowLayout laneKind 'clone'): a Clone's header takes its
  // row's height, which follows its lane (and collapses with its source's Reel lane).
  cloneRows = [],
  // The Roam and Sweep key lanes are gone from the Edit view (docs/XLETH_MOTION_VIEW_DESIGN.md
  // R17): motion is edited in Motion view. Old `roamRows` / `sweepRows` props are ignored.
  // Tracks that have motion (R18: keys, a non-identity Roam base, Parent, Masks...): their
  // header shows the motion marker. A Set or an array of track ids; null = none.
  motionTrackIds = null,
  onHideMacroLane,
  automationGroupRows = [],
  automationLaneRows = [],
  onToggleAutomationGroup,
  onDeleteAutomationLane,
  // Fixed (non-scrolling) rows pinned under the ruler spacer, mirroring the
  // canvas column's pinned lanes (the Snapshots cue lane).
  pinnedHeader = null,
  // Empty project: two ghost rows that add the first track of either kind.
  onAddClipTrack,
  onAddPatternTrack,
}) {
  // What is heard: Clones make no sound, so they never take part in the pearl rules.
  const pearlItems = (tracks ?? []).filter((t) => !isClone(t))
    .map((t) => ({ id: t.id, muted: !!t.muted, soloed: !!t.solo }))
  const dragRef = useRef(null)
  const trackById = useMemo(() => new Map(tracks.map(track => [track.id, track])), [tracks])
  const folderById = useMemo(() => folderMapForLayout(folderLayout), [folderLayout])
  const flatVisibleIds = useMemo(() => {
    const ids = []
    for (const item of folderLayout?.rootOrder ?? tracks.map(track => ({ kind: 'track', id: track.id }))) {
      if (item.kind === 'track') ids.push(item.id)
      else {
        const folder = folderById.get(item.id)
        if (folder && !folder.collapsed) ids.push(...folder.trackIds)
      }
    }
    return ids
  }, [folderLayout, folderById, tracks])

  const reelByTrack = useMemo(() => {
    const map = new Map()
    for (const row of reelRows) map.set(row.parentTrackId, row)
    return map
  }, [reelRows])

  const cloneRowByTrack = useMemo(() => {
    const map = new Map()
    for (const row of cloneRows) map.set(row.trackId, row)
    return map
  }, [cloneRows])

  // sourceId -> { all, voice } Clone counts, for the source's Reel lane header.
  const cloneCounts = useMemo(() => {
    const map = new Map()
    for (const t of tracks ?? []) {
      if (!isClone(t)) continue
      const c = map.get(t.cloneOf) ?? { all: 0, voice: 0 }
      c.all++
      if (cloneKindOf(t) === 'Voice') c.voice++
      map.set(t.cloneOf, c)
    }
    return map
  }, [tracks])
  const cloneCountOf = (sourceId) => cloneCounts.get(sourceId)?.all ?? 0
  const voiceCloneCountOf = (sourceId) => cloneCounts.get(sourceId)?.voice ?? 0

  const motionIds = useMemo(() => motionTrackIdSet(motionTrackIds), [motionTrackIds])

  const lanesByTrack = useMemo(() => {
    const map = new Map()
    for (const row of macroRows) {
      if (!map.has(row.parentTrackId)) map.set(row.parentTrackId, [])
      map.get(row.parentTrackId).push(row)
    }
    return map
  }, [macroRows])

  // Automation clip lanes (Phase B) — grouped under their owning track, or the
  // pinned Master group (ownerTrackId -1), rendered separately from macro lanes.
  const automationGroupByOwner = useMemo(() => {
    const map = new Map()
    for (const row of automationGroupRows) map.set(row.ownerTrackId, row)
    return map
  }, [automationGroupRows])
  const automationLanesByOwner = useMemo(() => {
    const map = new Map()
    for (const row of automationLaneRows) {
      if (!map.has(row.ownerTrackId)) map.set(row.ownerTrackId, [])
      map.get(row.ownerTrackId).push(row)
    }
    return map
  }, [automationLaneRows])

  const [openColorPickerId, setOpenColorPickerId] = useState(null)
  const [folderMenu, setFolderMenu] = useState(null)
  const [laneMenu, setLaneMenu] = useState(null)
  const [colorPickerAnchorRect, setColorPickerAnchorRect] = useState(null)
  const [, setThemeRevision] = useState(0)
  useEffect(() => {
    const handler = () => setThemeRevision(revision => revision + 1)
    document.addEventListener('xleth-theme-changed', handler)
    return () => document.removeEventListener('xleth-theme-changed', handler)
  }, [])

  const rawPalette = Array.from({ length: 16 }, (_, i) => tokenValue(`--theme-track-palette-${i + 1}`))
  // The two candidate label inks for text on an identity colour (DESIGN.md 3.4).
  const labelInks = { light: tokenValue('--ui-ink') || '#E6E6E6', dark: tokenValue('--ui-g1') || '#1B1B1B' }
  const trackPalette = normalizeTrackPalette(rawPalette)

  const closeColorPicker = useCallback(() => {
    setOpenColorPickerId(null)
    setColorPickerAnchorRect(null)
  }, [])
  const openColorPicker = useCallback((trackId, rect) => {
    setOpenColorPickerId(previous => previous === trackId ? null : trackId)
    setColorPickerAnchorRect(rect)
  }, [])

  const beginTrackDrag = useCallback((event, trackId) => {
    // Clones follow their source (the engine keeps them under it), so a selected
    // Clone never moves on its own.
    const ids = draggableTrackIds(selectedTrackIds.has(trackId)
      ? flatVisibleIds.filter(id => selectedTrackIds.has(id))
      : [trackId], tracks)
    if (ids.length === 0) {
      event.preventDefault()
      return
    }
    dragRef.current = { kind: 'tracks', trackIds: ids }
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', `tracks:${ids.join(',')}`)
  }, [flatVisibleIds, selectedTrackIds, tracks])

  const beginFolderDrag = useCallback((event, folderId) => {
    dragRef.current = { kind: 'folder', folderId }
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', `folder:${folderId}`)
  }, [])

  const dropAt = useCallback((event, target) => {
    event.preventDefault()
    event.stopPropagation()
    const drag = dragRef.current
    dragRef.current = null
    if (!drag) return
    if (drag.kind === 'tracks') onMoveTracks?.(drag.trackIds, target)
    else if (target.kind === 'root') onMoveFolder?.(drag.folderId, target.index)
  }, [onMoveFolder, onMoveTracks])

  const allowDrop = useCallback((event) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const handleScroll = useCallback((event) => {
    if (scrollContainerRef?.current) scrollContainerRef.current.scrollTop = event.currentTarget.scrollTop
  }, [scrollContainerRef])

  const renderAutomationGroup = (ownerTrackId) => {
    const groupRow = automationGroupByOwner.get(ownerTrackId)
    if (!groupRow) return null
    const laneRows = automationLanesByOwner.get(ownerTrackId) ?? []
    return (
      <div key={`automation-group:${ownerTrackId}`} className="track-header-automation-group">
        <button
          type="button"
          className={`track-header-automation-group-header ${styles.groupHeader}`}
          style={{ height: groupRow.height }}
          onClick={() => onToggleAutomationGroup?.(ownerTrackId, !groupRow.collapsed)}
          aria-expanded={!groupRow.collapsed}
          data-hint={groupRow.collapsed ? 'Expand automation lanes' : 'Collapse automation lanes'}
        >
          <Disclosure open={!groupRow.collapsed} />
          <IcXAutomation size={14} className={styles.groupIcon} aria-hidden="true" />
          <span className={styles.groupLabel}>{groupRow.label || 'Automation'}</span>
          <span className={styles.count} role="img" aria-label={`${groupRow.laneCount} lanes`}>{groupRow.laneCount}</span>
        </button>
        {!groupRow.collapsed && laneRows.map((lane) => (
          <div
            key={lane.id}
            className={`track-header-automation-lane ${styles.autoLane}`}
            style={{ height: lane.height }}
            title={lane.label || `Lane ${lane.index + 1}`}
            onContextMenu={onDeleteAutomationLane ? (event) => {
              event.preventDefault()
              event.stopPropagation()
              setLaneMenu({ lane, x: event.clientX, y: event.clientY })
            } : undefined}
          >
            <span className={styles.laneLabel}>{lane.label || `Lane ${lane.index + 1}`}</span>
            {onDeleteAutomationLane && (
              <IconButton size="sm" label="Delete automation lane" className={styles.laneDelete}
                hint="Delete automation lane" hintMods="Its clips go too. Ctrl+Z undoes it"
                onClick={() => onDeleteAutomationLane(lane.laneId)}>
                <IcTrash size={14} />
              </IconButton>
            )}
          </div>
        ))}
      </div>
    )
  }

  const resolvedColorOf = (track) => {
    const index = Math.max(0, tracks.findIndex(item => item.id === track.id))
    return resolveAutoTrackColor(track, index, trackPalette, TRACK_PALETTE_FALLBACK[index % 16])
  }

  // A Clone's chip and stripe: its source's colour for a Voice clone (it is the
  // same picture), its tint for a Trail clone (what its copy is tinted with).
  const cloneColorOf = (clone) => {
    if (cloneKindOf(clone) === 'Trail' && parseTint(clone.clone?.tint)) return clone.clone.tint.toUpperCase()
    const source = trackById.get(clone.cloneOf)
    return source ? resolvedColorOf(source) : resolvedColorOf(clone)
  }

  const renderTrack = (trackId, target) => {
    const track = trackById.get(trackId)
    if (!track) return null
    const canonicalIndex = Math.max(0, tracks.findIndex(item => item.id === track.id))
    const clone = isClone(track)
    const color = clone ? cloneColorOf(track) : resolvedColorOf(track)
    const laneRows = lanesByTrack.get(track.id) ?? []
    const reelRow = clone ? null : reelByTrack.get(track.id)
    // A Clone's row is its lane: the header takes the row's height (the canvas
    // row model's), so the two columns stay in lockstep.
    const rowHeight = clone ? (cloneRowByTrack.get(track.id)?.height ?? trackHeight) : trackHeight
    return (
      <div key={track.id} className="track-header-group">
        <TrackHeader
          track={track}
          index={canonicalIndex}
          trackHeight={rowHeight}
          trackColor={color}
          labelInks={labelInks}
          isFocused={focusedTrackId === track.id}
          isSelected={selectedTrackIds.has(track.id)}
          hasMotion={motionIds.has(String(track.id))}
          cloneKind={clone ? cloneKindOf(track) : null}
          onMute={onMute}
          onSolo={onSolo}
          onPearl={onPearl}
          lit={clone ? undefined : isHeard({ id: track.id, muted: !!track.muted, soloed: !!track.solo }, pearlItems)}
          onVisualOnly={onVisualOnly}
          onRename={onRename}
          onRequestContextMenu={onRequestContextMenu}
          onFocus={onFocusTrack}
          onSelect={onSelectTrack}
          onOpenInMixer={onOpenInMixer}
          onDragStart={clone ? undefined : (event) => beginTrackDrag(event, track.id)}
          onDragOver={allowDrop}
          onDrop={(event) => dropAt(event, target)}
          onOpenColorPicker={clone ? undefined : openColorPicker}
        />
        {reelRow && (
          <div
            key={reelRow.id}
            className={`track-header-reel-lane ${styles.reelLane}`}
            style={{ height: reelRow.height, borderLeftColor: color }}
            role="group"
            aria-label="Reel lane, read only. Timing comes from notes"
          >
            <button
              type="button"
              className={styles.disclosureBtn}
              onClick={() => onToggleReelLane?.(track.id)}
              aria-expanded={!reelRow.collapsed}
              aria-label={reelRow.collapsed ? 'Expand Reel lane' : 'Collapse Reel lane'}
              data-hint={reelRow.collapsed ? 'Expand the Reel lane' : 'Collapse the Reel lane'}
              data-hint-mods={cloneCountOf(track.id) > 0
                ? `Its clones' lanes ${reelRow.collapsed ? 'expand' : 'collapse'} with it`
                : undefined}
            >
              <Disclosure open={!reelRow.collapsed} />
            </button>
            <span className={styles.reelLabel}>Reel</span>
            <IcLock size={12} className={styles.groupIcon} aria-hidden="true" />
            <span className={styles.reelHint}>
              {voiceCloneCountOf(track.id) > 0 ? 'Voice 0. Timing comes from notes' : 'Timing comes from notes'}
            </span>
          </div>
        )}
        {renderAutomationGroup(track.id)}
        {laneRows.map(lane => (
          <div
            key={lane.id}
            className={`track-header-macro-lane ${styles.macroLane}${lane.targetUnavailable ? ` track-header-macro-lane--orphan ${styles.orphan}` : ''}`}
            style={{ height: lane.height, borderLeftColor: color }}
            title={lane.label}
          >
            <IcXAutomation size={14} className={styles.groupIcon} aria-hidden="true" />
            <span className={styles.laneLabel}>{lane.label}</span>
            {onHideMacroLane && (
              <IconButton size="sm" label="Hide automation lane" hint="Hide this automation lane"
                onClick={() => onHideMacroLane(lane.parentTrackId, lane.macroNodeId)}>
                <IcEyeSlash size={14} />
              </IconButton>
            )}
          </div>
        ))}
      </div>
    )
  }

  const rootOrder = folderLayout?.rootOrder ?? tracks.map(track => ({ kind: 'track', id: track.id }))
  return (
    <div className={`timeline-header-column ${styles.column}`} style={{ width }}>
      <div className={`timeline-header-spacer ${styles.spacer}`} style={{ height: RULER_HEIGHT }} />
      {pinnedHeader}
      <div className={`timeline-header-scroll ${styles.scroll}`} onScroll={handleScroll}
        onMouseDown={(event) => { if (event.target === event.currentTarget) onClearSelection?.() }}>
        {renderAutomationGroup(-1)}
        {rootOrder.map((item, rootIndex) => {
          if (item.kind === 'track') return renderTrack(item.id, { kind: 'root', index: rootIndex })
          const folder = folderById.get(item.id)
          if (!folder) return null
          return (
            <div key={`folder:${folder.id}`} className="track-folder-group">
              <FolderHeader
                folder={folder}
                editing={editingFolderId === folder.id}
                onFinishEdit={onFinishFolderEdit}
                onRename={onRenameFolder}
                onToggle={onToggleFolder}
                onRemove={onRemoveFolder}
                onContextMenu={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  setFolderMenu({ folder, x: event.clientX, y: event.clientY })
                }}
                onDragStart={beginFolderDrag}
                onDragOver={allowDrop}
                onDrop={(event) => {
                  const drag = dragRef.current
                  const nearTop = event.clientY - event.currentTarget.getBoundingClientRect().top <= 8
                  dropAt(event, drag?.kind === 'tracks' && !nearTop
                    ? { kind: 'folder', folderId: folder.id, index: folder.trackIds.length }
                    : { kind: 'root', index: rootIndex })
                }}
              />
              {!folder.collapsed && folder.trackIds.length > 0 && (
                <div className={`track-folder-members ${styles.members}`}>
                  {folder.trackIds.map((trackId, memberIndex) =>
                    renderTrack(trackId, { kind: 'folder', folderId: folder.id, index: memberIndex }))}
                </div>
              )}
            </div>
          )
        })}
        <div className={`timeline-root-drop-zone ${styles.dropZone}`} onMouseDown={() => onClearSelection?.()} onDragOver={allowDrop}
          onDrop={(event) => dropAt(event, { kind: 'root', index: rootOrder.length })} />
        {rootOrder.length === 0 ? (
          <div className={styles.ghosts} role="group" aria-label="Add the first track">
            <button type="button" className={styles.ghost} style={{ height: trackHeight }} onClick={onAddClipTrack}
              data-hint="Add a clip track: audio and video clips">
              <IcPlus size={14} aria-hidden="true" /><span>Clip track</span>
            </button>
            <button type="button" className={styles.ghost} style={{ height: trackHeight }} onClick={onAddPatternTrack}
              data-hint="Add a pattern track: notes that trigger samples">
              <IcPlus size={14} aria-hidden="true" /><span>Pattern track</span>
            </button>
          </div>
        ) : (
          <button type="button" className={`timeline-add-track ${styles.addTrack}`} style={{ height: ADD_TRACK_ROW_HEIGHT }} onClick={onAddTrack}
            data-hint="Add a track" aria-label="Add track">
            <IcPlus size={14} aria-hidden="true" /><span>Add track</span>
          </button>
        )}
      </div>
      {/* Mirrors the canvas column's horizontal scrollbar so both scroll viewports are the same height. */}
      <div className={styles.footer} style={{ height: TIMELINE_HSCROLL_HEIGHT }} aria-hidden="true" />

      {openColorPickerId !== null && colorPickerAnchorRect !== null && (() => {
        const openTrack = tracks.find(track => track.id === openColorPickerId)
        if (!openTrack) return null
        const index = tracks.findIndex(track => track.id === openColorPickerId)
        const color = resolveAutoTrackColor(
          openTrack, index, trackPalette, TRACK_PALETTE_FALLBACK[index % 16])
        return (
          <TrackColorPopover
            anchorRect={colorPickerAnchorRect}
            track={openTrack}
            palette={trackPalette}
            resolvedTrackColor={color}
            onChooseAuto={() => { onSetTrackColor?.(openColorPickerId, { mode: 'auto' }); closeColorPicker() }}
            onChooseSlot={(slot) => { onSetTrackColor?.(openColorPickerId, { mode: 'paletteSlot', slot }); closeColorPicker() }}
            onChooseCustom={(customColor) => onSetTrackColor?.(openColorPickerId, { mode: 'custom', customColor })}
            onClose={closeColorPicker}
          />
        )
      })()}
      {laneMenu && (
        <TrackContextMenu
          x={laneMenu.x}
          y={laneMenu.y}
          items={[{
            label: 'Delete automation lane',
            danger: true,
            onClick: () => onDeleteAutomationLane?.(laneMenu.lane.laneId),
          }]}
          onClose={() => setLaneMenu(null)}
        />
      )}
      {folderMenu && (
        <TrackContextMenu
          x={folderMenu.x}
          y={folderMenu.y}
          items={[{
            label: 'Delete Folder (Keep Tracks)',
            danger: true,
            onClick: () => onRemoveFolder?.(folderMenu.folder.id),
          }]}
          onClose={() => setFolderMenu(null)}
        />
      )}
    </div>
  )
}

function FolderHeader({ folder, editing, onFinishEdit, onRename, onToggle, onRemove,
  onContextMenu, onDragStart, onDragOver, onDrop }) {
  const [name, setName] = useState(folder.name)
  const inputRef = useRef(null)
  useEffect(() => setName(folder.name), [folder.name])
  useEffect(() => { if (editing) setTimeout(() => inputRef.current?.select(), 0) }, [editing])
  const commit = () => {
    const trimmed = name.trim()
    if (trimmed && trimmed !== folder.name) onRename?.(folder.id, trimmed)
    else setName(folder.name)
    onFinishEdit?.()
  }
  return (
    <div className={`track-folder-header ${styles.folder}`} style={{ height: FOLDER_ROW_HEIGHT }} draggable
      onContextMenu={onContextMenu}
      onDragStart={(event) => {
        if (event.target.closest?.('button, input')) {
          event.preventDefault()
          return
        }
        onDragStart(event, folder.id)
      }} onDragOver={onDragOver} onDrop={onDrop}>
      <button type="button" className={`track-folder-toggle ${styles.disclosureBtn}`}
        onClick={() => onToggle?.(folder.id, !folder.collapsed)}
        aria-expanded={!folder.collapsed}
        aria-label={folder.collapsed ? `Expand folder ${folder.name}` : `Collapse folder ${folder.name}`}
        data-hint={folder.collapsed ? 'Expand folder' : 'Collapse folder'}>
        <Disclosure open={!folder.collapsed} />
      </button>
      <IcFolder size={14} className={styles.folderGlyph} aria-hidden="true" />
      {editing ? (
        <input ref={inputRef} className={`track-folder-name-input ${styles.folderInput}`} value={name}
          aria-label="Folder name"
          onChange={event => setName(event.target.value)} onBlur={commit}
          onKeyDown={event => {
            if (event.key === 'Enter') commit()
            if (event.key === 'Escape') { setName(folder.name); onFinishEdit?.() }
          }} />
      ) : (
        <span className={`track-folder-name ${styles.folderName}`} title={folder.name}
          onDoubleClick={() => onFinishEdit?.(folder.id)}>{folder.name}</span>
      )}
      <span className={`track-folder-count ${styles.count}`} role="img"
        aria-label={`${folder.trackIds.length} ${folder.trackIds.length === 1 ? 'track' : 'tracks'}`}>{folder.trackIds.length}</span>
      <IconButton size="sm" label="Delete folder, keep tracks" className={styles.folderDelete}
        hint="Delete folder" hintMods="Its tracks stay"
        onClick={() => onRemove?.(folder.id)}>
        <IcTrash size={14} />
      </IconButton>
    </div>
  )
}
