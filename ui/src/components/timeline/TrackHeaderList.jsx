import { useCallback, useMemo, useRef, useState, useEffect } from 'react'
import { ChevronDown, ChevronRight, EyeOff, Folder, Plus, Sliders, Trash2 } from 'lucide-react'
import TrackHeader from './TrackHeader.jsx'
import TrackColorPopover from './TrackColorPopover.jsx'
import TrackContextMenu from './TrackContextMenu.jsx'
import { RULER_HEIGHT, HEADER_WIDTH, ADD_TRACK_ROW_HEIGHT } from '../../constants/timeline.js'
import { resolveAutoTrackColor, normalizeTrackPalette, TRACK_PALETTE_FALLBACK } from './trackColorResolver.js'
import { folderMapForLayout } from './trackFolderLayout.js'
import { tokenValue } from '../../theming/tokenValue.ts'

export default function TrackHeaderList({
  tracks,
  focusedTrackId, onFocusTrack, onOpenInMixer,
  onAddTrack, onMute, onSolo, onVisualOnly, onRename, onRemove, onRequestContextMenu,
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
  onHideMacroLane,
}) {
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

  const lanesByTrack = useMemo(() => {
    const map = new Map()
    for (const row of macroRows) {
      if (!map.has(row.parentTrackId)) map.set(row.parentTrackId, [])
      map.get(row.parentTrackId).push(row)
    }
    return map
  }, [macroRows])

  const [openColorPickerId, setOpenColorPickerId] = useState(null)
  const [folderMenu, setFolderMenu] = useState(null)
  const [colorPickerAnchorRect, setColorPickerAnchorRect] = useState(null)
  const [, setThemeRevision] = useState(0)
  useEffect(() => {
    const handler = () => setThemeRevision(revision => revision + 1)
    document.addEventListener('xleth-theme-changed', handler)
    return () => document.removeEventListener('xleth-theme-changed', handler)
  }, [])

  const rawPalette = Array.from({ length: 16 }, (_, i) => tokenValue(`--theme-track-palette-${i + 1}`))
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
    const ids = selectedTrackIds.has(trackId)
      ? flatVisibleIds.filter(id => selectedTrackIds.has(id))
      : [trackId]
    dragRef.current = { kind: 'tracks', trackIds: ids }
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', `tracks:${ids.join(',')}`)
  }, [flatVisibleIds, selectedTrackIds])

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

  const renderTrack = (trackId, target) => {
    const track = trackById.get(trackId)
    if (!track) return null
    const canonicalIndex = Math.max(0, tracks.findIndex(item => item.id === track.id))
    const color = resolveAutoTrackColor(
      track, canonicalIndex, trackPalette, TRACK_PALETTE_FALLBACK[canonicalIndex % 16])
    const laneRows = lanesByTrack.get(track.id) ?? []
    return (
      <div key={track.id} className="track-header-group">
        <TrackHeader
          track={track}
          index={canonicalIndex}
          trackHeight={trackHeight}
          trackColor={color}
          isFocused={focusedTrackId === track.id}
          isSelected={selectedTrackIds.has(track.id)}
          onMute={onMute}
          onSolo={onSolo}
          onVisualOnly={onVisualOnly}
          onRename={onRename}
          onRemove={onRemove}
          onRequestContextMenu={onRequestContextMenu}
          onFocus={onFocusTrack}
          onSelect={onSelectTrack}
          onOpenInMixer={onOpenInMixer}
          onDragStart={(event) => beginTrackDrag(event, track.id)}
          onDragOver={allowDrop}
          onDrop={(event) => dropAt(event, target)}
          onOpenColorPicker={openColorPicker}
        />
        {laneRows.map(lane => (
          <div
            key={lane.id}
            className={`track-header-macro-lane${lane.targetUnavailable ? ' track-header-macro-lane--orphan' : ''}`}
            style={{ height: lane.height, borderLeftColor: color }}
            title={lane.label}
          >
            <Sliders size={10} className="track-header-macro-lane-icon" strokeWidth={2} />
            <span className="track-header-macro-lane-label">{lane.label}</span>
            {onHideMacroLane && (
              <button className="track-header-macro-lane-hide" title="Hide automation lane"
                aria-label="Hide automation lane"
                onClick={() => onHideMacroLane(lane.parentTrackId, lane.macroNodeId)}>
                <EyeOff size={10} strokeWidth={2} />
              </button>
            )}
          </div>
        ))}
      </div>
    )
  }

  const rootOrder = folderLayout?.rootOrder ?? tracks.map(track => ({ kind: 'track', id: track.id }))
  return (
    <div className="timeline-header-column" style={{ width }}>
      <div className="timeline-header-spacer" style={{ height: RULER_HEIGHT }} />
      <div className="timeline-header-scroll" onScroll={handleScroll}
        onMouseDown={(event) => { if (event.target === event.currentTarget) onClearSelection?.() }}>
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
                <div className="track-folder-members">
                  {folder.trackIds.map((trackId, memberIndex) =>
                    renderTrack(trackId, { kind: 'folder', folderId: folder.id, index: memberIndex }))}
                </div>
              )}
            </div>
          )
        })}
        <div className="timeline-root-drop-zone" onMouseDown={() => onClearSelection?.()} onDragOver={allowDrop}
          onDrop={(event) => dropAt(event, { kind: 'root', index: rootOrder.length })} />
        <button className="timeline-add-track" style={{ height: ADD_TRACK_ROW_HEIGHT }} onClick={onAddTrack} title="Add track">
          <Plus size={14} /><span>Add Track</span>
        </button>
      </div>

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
    <div className="track-folder-header" style={{ height: 32 }} draggable
      onContextMenu={onContextMenu}
      onDragStart={(event) => {
        if (event.target.closest?.('button, input')) {
          event.preventDefault()
          return
        }
        onDragStart(event, folder.id)
      }} onDragOver={onDragOver} onDrop={onDrop}>
      <button className="track-folder-toggle" onClick={() => onToggle?.(folder.id, !folder.collapsed)}
        title={folder.collapsed ? 'Expand folder' : 'Collapse folder'}>
        {folder.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
      </button>
      <Folder size={14} className="track-folder-icon" />
      {editing ? (
        <input ref={inputRef} className="track-folder-name-input" value={name}
          onChange={event => setName(event.target.value)} onBlur={commit}
          onKeyDown={event => {
            if (event.key === 'Enter') commit()
            if (event.key === 'Escape') { setName(folder.name); onFinishEdit?.() }
          }} />
      ) : (
        <span className="track-folder-name" title={folder.name}
          onDoubleClick={() => onFinishEdit?.(folder.id)}>{folder.name}</span>
      )}
      <span className="track-folder-count">{folder.trackIds.length}</span>
      <button className="track-folder-delete" onClick={() => onRemove?.(folder.id)}
        title="Delete Folder (Keep Tracks)" aria-label="Delete Folder (Keep Tracks)">
        <Trash2 size={11} />
      </button>
    </div>
  )
}
