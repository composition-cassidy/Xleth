import React from 'react'
import { PALETTE_ENTRIES } from './paletteCatalog.js'
import { addChildToSelected } from './designerActions.js'

export default function ComponentPalette() {
  return (
    <ComponentPaletteContent
      entries={PALETTE_ENTRIES}
      onAdd={addChildToSelected}
    />
  )
}

export function ComponentPaletteContent({ entries = [], onAdd }) {
  return (
    <div className="pluginui-designer-palette" aria-label="Component palette">
      {entries.map(entry => (
        <button
          key={entry.type}
          type="button"
          className="pluginui-designer-palette-button"
          onClick={() => onAdd?.(entry.type)}
          title={`Add ${entry.label}`}
        >
          {entry.label}
        </button>
      ))}
    </div>
  )
}
