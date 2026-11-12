import { useCallback, useEffect, useRef } from 'react'
import { labelColor } from '../constants/labels.js'
import SampleRow from './SampleRow.jsx'
import SampleThumbnail from './SampleThumbnail.jsx'
import Disclosure from './browser/Disclosure.jsx'
import styles from './browser/Browser.module.css'

/**
 * Collapsible section for one label group in the Sample Selector: a disclosure
 * triangle, the label's identity colour, its name and its count, then the rows.
 *
 * Props:
 *   label            – string (e.g. "Kick", "Pitch")
 *   samples          – array of region objects
 *   collapsed        – boolean
 *   onToggle         – () => void
 *   activeSampleId   – string | null
 *   onSelect         – (id) => void
 *   onContextMenu    – (e, region) => void
 *   editingNameId    – string | null
 *   editingNameValue – string
 *   onRenameChange   – (value) => void
 *   onRenameCommit   – () => void
 *   onRenameCancel   – () => void
 *   sources          – { [id]: sourceObject }
 *   rootNotes        – { [sourceId]: number }  (MIDI note, -1 = not found)
 *   onFetchRootNotes – (samples) => void
 */
export default function SampleGroup({
  label,
  samples,
  collapsed,
  onToggle,
  activeSampleId,
  onSelect,
  onContextMenu,
  editingNameId,
  editingNameValue,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  sources,
  rootNotes,
  onFetchRootNotes,
  viewMode = 'list',
  onOpenPicker,
}) {
  // Lazy root note detection — when Pitch group is first expanded
  const hasFetchedRef = useRef(false)
  useEffect(() => {
    if (label === 'Pitch' && !collapsed && samples.length > 0 && !hasFetchedRef.current) {
      hasFetchedRef.current = true
      onFetchRootNotes(samples)
    }
  }, [label, collapsed, samples, onFetchRootNotes])

  // One stable callback for every tile (a per-tile inline closure would defeat
  // SampleThumbnail's memo and re-render the whole grid on each parent render).
  const handleOpen = useCallback((region) => {
    const src = sources[region.sourceId]
    if (src && onOpenPicker) onOpenPicker(src)
  }, [sources, onOpenPicker])

  return (
    <div className={styles.group} role="group" aria-label={`${label}, ${samples.length} samples`}>
      {/* ── Group header ───────────────────────────────────────────── */}
      <button
        type="button"
        className={styles.groupHeader}
        onClick={onToggle}
        aria-expanded={!collapsed}
        data-hint={`${label} samples. Click to ${collapsed ? 'expand' : 'collapse'}.`}
      >
        <Disclosure open={!collapsed} />
        <span className={styles.swatch} style={{ background: labelColor(label) }} aria-hidden="true" />
        <span className={styles.groupName}>{label}</span>
        <span className={styles.count}>{samples.length}</span>
      </button>

      {/* ── Rows / Thumbnails ──────────────────────────────────────── */}
      {!collapsed && samples.length > 0 && (
        viewMode === 'thumbnails' ? (
          <div className={styles.thumbGrid}>
            {samples.map(region => {
              const src = sources[region.sourceId]
              return (
                <SampleThumbnail
                  key={region.id}
                  region={region}
                  isActive={region.id === activeSampleId}
                  onSelect={onSelect}
                  onContextMenu={onContextMenu}
                  sourceFilePath={src?.filePath || ''}
                  sourceHasVideo={src?.hasVideo}
                  sourceDuration={src?.duration}
                  rootNote={rootNotes[region.sourceId] ?? null}
                  onOpen={handleOpen}
                />
              )
            })}
          </div>
        ) : (
          <div className={styles.rows}>
            {samples.map(region => {
              const src = sources[region.sourceId]
              return (
                <SampleRow
                  key={region.id}
                  region={region}
                  isActive={region.id === activeSampleId}
                  onSelect={onSelect}
                  onContextMenu={onContextMenu}
                  isEditing={region.id === editingNameId}
                  editValue={editingNameValue}
                  onRenameChange={onRenameChange}
                  onRenameCommit={onRenameCommit}
                  onRenameCancel={onRenameCancel}
                  sourceName={src?.name || '?'}
                  sourceFilePath={src?.filePath || ''}
                  rootNote={rootNotes[region.sourceId] ?? null}
                />
              )
            })}
          </div>
        )
      )}
    </div>
  )
}
