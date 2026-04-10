import { useEffect, useRef } from 'react'
import { ChevronRight } from 'lucide-react'
import { labelColor } from '../constants/labels.js'
import SampleRow from './SampleRow.jsx'

/**
 * Collapsible section for one label group in the Sample Selector.
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
}) {
  // Lazy root note detection — when Pitch group is first expanded
  const hasFetchedRef = useRef(false)
  useEffect(() => {
    if (label === 'Pitch' && !collapsed && samples.length > 0 && !hasFetchedRef.current) {
      hasFetchedRef.current = true
      onFetchRootNotes(samples)
    }
  }, [label, collapsed, samples, onFetchRootNotes])

  return (
    <div className="sample-group">
      {/* ── Group header ───────────────────────────────────────────── */}
      <button className="sample-group-header" onClick={onToggle}>
        <ChevronRight
          size={12}
          className={`sample-group-chevron ${!collapsed ? 'expanded' : ''}`}
        />
        <span className="tab-label-dot" style={{ background: labelColor(label) }} />
        <span className="sample-group-name">{label}</span>
        <span className="tab-item-count">{samples.length}</span>
      </button>

      {/* ── Rows ───────────────────────────────────────────────────── */}
      {!collapsed && samples.length > 0 && (
        <div className="sample-group-rows">
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
      )}
    </div>
  )
}
