import React from 'react'
import useEffectPresets from './useEffectPresets.js'
import { iconComponent } from '../ui-kit/icons'

const IcArrowUUpLeft = iconComponent('arrow-u-up-left')
const IcCheck = iconComponent('check')
const IcFloppyDisk = iconComponent('floppy-disk')
const IcTrash = iconComponent('trash')
const IcX = iconComponent('x')

// Framework-level preset bar for stock effect windows.
//
// Drop this into any stock effect panel (bespoke ones like ApexPanel, or the
// shared StockPluginRuntimeRenderer chrome that hosts every plugin-ui-layout
// effect) and that effect inherits named preset save / load / delete for free.
// It is fully generic: it only needs the effect's `effectType` id and the open
// `target` ({ trackId, nodeId, storeKey }). All effect-specific state capture /
// apply lives behind the preset adapter registry (effectPresetAdapters.js).
//
// Discrete-action discipline: every operation (select-to-load, save, delete,
// undo) is a single click / submit — there is no drag, so no IPC ever fires
// mid-gesture. Theming: CSS custom-property tokens only, no hardcoded hex,
// tokenValue() is never called here; flat, zero-border-radius; Lucide icons
// only. Reserved script identifiers (name, event, status, …) are never declared.
//
// Props:
//   effectType  – stock effect id ("apex", "compressor", …)
//   target      – { trackId, nodeId, storeKey } | null
//   onApplied   – (stateBlob) => void, called after a load or undo so the host
//                 can sync its own UI from the applied state without re-reading.
//   className   – optional extra class for placement.

export default function EffectPresetBar({ effectType, target, onApplied, className }) {
  const {
    groups, selectValue, hasAny, hasTarget, busy, errorText, setErrorText,
    saving, draftName, setDraftName, overwriteArmed, setOverwriteArmed, nameInputRef,
    undoBlob, canDelete,
    handleSelectChange, handleUndo, beginSave, cancelSave, commitSave, handleNameKeyDown, handleDelete,
  } = useEffectPresets({ effectType, target, onApplied })

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className={`fx-preset-bar${className ? ' ' + className : ''}`} data-effect-type={effectType}>
      {saving ? (
        <div className="fx-preset-bar__save-form">
          <input
            ref={nameInputRef}
            type="text"
            className="fx-preset-bar__name-input"
            placeholder={overwriteArmed ? 'Overwrite existing preset?' : 'Preset name'}
            value={draftName}
            maxLength={80}
            onChange={(e) => { setDraftName(e.target.value); setOverwriteArmed(false) }}
            onKeyDown={handleNameKeyDown}
            aria-label="Preset name"
          />
          <button
            type="button"
            className={`fx-preset-bar__icon-btn${overwriteArmed ? ' fx-preset-bar__icon-btn--warn' : ''}`}
            onClick={commitSave}
            disabled={busy}
            title={overwriteArmed ? 'Confirm overwrite' : 'Save preset'}
          >
            <IcCheck size={14} />
          </button>
          <button
            type="button"
            className="fx-preset-bar__icon-btn"
            onClick={cancelSave}
            title="Cancel"
          >
            <IcX size={14} />
          </button>
        </div>
      ) : (
        <>
          <select
            className="fx-preset-bar__select"
            value={selectValue}
            onChange={handleSelectChange}
            disabled={!hasTarget || busy}
            title="Load a preset"
          >
            <option value="">{hasAny ? 'Presets…' : 'No presets'}</option>
            {groups.factory.length > 0 && (
              <optgroup label="Factory">
                {groups.factory.map(p => (
                  <option key={`factory:${p.slug}`} value={`factory:${p.slug}`}>{p.name}</option>
                ))}
              </optgroup>
            )}
            {groups.user.length > 0 && (
              <optgroup label="User">
                {groups.user.map(p => (
                  <option key={`user:${p.slug}`} value={`user:${p.slug}`}>{p.name}</option>
                ))}
              </optgroup>
            )}
          </select>

          <button
            type="button"
            className="fx-preset-bar__icon-btn"
            onClick={beginSave}
            disabled={!hasTarget || busy}
            title="Save current settings as a preset"
          >
            <IcFloppyDisk size={14} />
          </button>

          <button
            type="button"
            className="fx-preset-bar__icon-btn"
            onClick={handleDelete}
            disabled={!canDelete || busy}
            title={canDelete ? 'Delete this user preset' : 'Only user presets can be deleted'}
          >
            <IcTrash size={14} />
          </button>

          {undoBlob && (
            <button
              type="button"
              className="fx-preset-bar__icon-btn"
              onClick={handleUndo}
              disabled={busy}
              title="Undo preset load"
            >
              <IcArrowUUpLeft size={14} />
            </button>
          )}
        </>
      )}

      {errorText && (
        <div className="fx-preset-bar__error" role="alert">
          <span className="fx-preset-bar__error-text">{errorText}</span>
          <button
            type="button"
            className="fx-preset-bar__icon-btn"
            onClick={() => setErrorText(null)}
            title="Dismiss"
          >
            <IcX size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
