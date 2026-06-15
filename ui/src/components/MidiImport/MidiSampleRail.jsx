import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Image, Music2, Search } from 'lucide-react'
import XlethSelect from '../common/XlethSelect.jsx'

function getItemKey(item) {
  return item?.id == null ? '__none__' : String(item.id)
}

function canRequestPreview(item) {
  return item?.source?.id != null && item?.source?.hasVideo !== false
}

export default function MidiSampleRail({
  items = [],
  value = null,
  onChange,
  disabled = false,
  compact = false,
  ariaLabel = 'Sample assignment',
}) {
  const [previews, setPreviews] = useState({})
  const requestedRef = useRef(new Set())
  const [search, setSearch] = useState('')
  const [filterTag, setFilterTag] = useState('all')

  const railItems = useMemo(() => [
    {
      id: null,
      name: 'None',
      subLabel: 'Assign later',
      isNone: true,
    },
    ...(items || []),
  ], [items])

  // Derive labels and swapped status from the item set
  const availableLabels = useMemo(() => {
    const labelSet = new Set()
    for (const item of items) {
      if (item.region?.label) labelSet.add(item.region.label)
    }
    return Array.from(labelSet).sort()
  }, [items])

  const hasSwapped = useMemo(
    () => items.some(item => item.region?.hasSwappedAudio),
    [items]
  )

  // Reset filter if the selected tag is no longer present
  useEffect(() => {
    if (filterTag === 'all' || filterTag === 'swapped') return
    const valid = availableLabels.some(l => l.toLowerCase() === filterTag)
    if (!valid) setFilterTag('all')
  }, [availableLabels, filterTag])

  const filteredRailItems = useMemo(() => {
    const searchTerm = search.trim().toLowerCase()
    return railItems.filter(item => {
      if (item.isNone) return true
      if (filterTag === 'swapped') {
        if (!item.region?.hasSwappedAudio) return false
      } else if (filterTag !== 'all') {
        if ((item.region?.label || '').toLowerCase() !== filterTag) return false
      }
      if (searchTerm) {
        const nameMatch = item.name?.toLowerCase().includes(searchTerm)
        const subMatch = item.subLabel?.toLowerCase().includes(searchTerm)
        if (!nameMatch && !subMatch) return false
      }
      return true
    })
  }, [railItems, search, filterTag])

  const hasActiveFilter = search.trim() !== '' || filterTag !== 'all'
  const showEmpty = hasActiveFilter && filteredRailItems.length <= 1 && items.length > 0

  useEffect(() => {
    if (disabled || typeof window === 'undefined') return
    const getFrameAtTime = window.xleth?.video?.getFrameAtTime
    if (typeof getFrameAtTime !== 'function') return

    for (const item of railItems) {
      const key = getItemKey(item)
      if (item.isNone || requestedRef.current.has(key) || previews[key] || !canRequestPreview(item)) continue
      requestedRef.current.add(key)
      const sourceId = item.source.id
      const time = Number.isFinite(item.previewTime) ? item.previewTime : 0
      getFrameAtTime(sourceId, time, compact ? 96 : 144, compact ? 54 : 81)
        .then(dataUrl => {
          if (!dataUrl) return
          setPreviews(prev => ({ ...prev, [key]: dataUrl }))
        })
        .catch(() => {
          setPreviews(prev => ({ ...prev, [key]: null }))
        })
    }
  }, [compact, disabled, previews, railItems])

  return (
    <div className={`midi-sample-rail-wrap${compact ? ' midi-sample-rail-wrap--compact' : ''}`}>
      {items.length > 0 && (
        <div className="midi-sample-rail-controls">
          <div className="midi-sample-rail-search-wrap">
            <Search size={compact ? 11 : 12} className="midi-sample-rail-search-icon" aria-hidden="true" />
            <input
              type="text"
              className="midi-sample-rail-search"
              placeholder="Search…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              aria-label="Search samples"
            />
          </div>
          <XlethSelect
            value={filterTag}
            options={[
              { value: 'all', label: 'All' },
              ...(hasSwapped ? [{ value: 'swapped', label: 'Swapped' }] : []),
              ...availableLabels.map(lbl => ({ value: lbl.toLowerCase(), label: lbl })),
            ]}
            onChange={setFilterTag}
            ariaLabel="Filter samples by tag"
            className="midi-sample-rail-filter"
          />
        </div>
      )}
      <div
        className={`midi-sample-rail${compact ? ' midi-sample-rail--compact' : ''}`}
        role="listbox"
        aria-label={ariaLabel}
        aria-disabled={disabled || undefined}
      >
        {filteredRailItems.map(item => {
          const key = getItemKey(item)
          const selected = item.id == null
            ? value == null || Number(value) < 0
            : String(value) === String(item.id)
          const preview = previews[key]
          const mediaIcon = item.source?.hasVideo === false ? Music2 : Image
          const MediaIcon = item.isNone ? Music2 : mediaIcon

          return (
            <button
              key={key}
              type="button"
              className={`midi-sample-tile${selected ? ' midi-sample-tile--selected' : ''}${item.isNone ? ' midi-sample-tile--none' : ''}`}
              role="option"
              aria-selected={selected}
              aria-pressed={selected}
              disabled={disabled}
              title={item.title || item.name}
              onClick={() => onChange?.(item.id == null ? null : item.id)}
            >
              <span className="midi-sample-tile-preview" aria-hidden="true">
                {preview ? (
                  <img src={preview} alt="" />
                ) : (
                  <span className="midi-sample-tile-placeholder">
                    <MediaIcon size={compact ? 15 : 18} aria-hidden="true" />
                  </span>
                )}
              </span>
              <span className="midi-sample-tile-copy">
                <span className="midi-sample-tile-name">{item.name}</span>
                {item.subLabel && (
                  <span className="midi-sample-tile-sub">{item.subLabel}</span>
                )}
              </span>
            </button>
          )
        })}
        {showEmpty && (
          <span className="midi-sample-rail-empty">No matches</span>
        )}
      </div>
    </div>
  )
}
