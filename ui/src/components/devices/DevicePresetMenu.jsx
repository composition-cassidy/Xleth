import React, { useMemo } from 'react'
import { IconButton, Select } from '../../ui-kit'
import styles from './DevicePresetMenu.module.css'
import { iconComponent } from '../../ui-kit/icons'

const IcCheck = iconComponent('check')
const IcX = iconComponent('x')

// The device title bar's preset menu. Driven by useEffectPresets (the same
// state the legacy EffectPresetBar uses). Save / delete / undo-load live in the
// device's "more" menu (presetMoreItems), so the title bar stays one row.

export function presetMoreItems(presets) {
  return [
    { label: 'Save preset…', onSelect: presets.beginSave, disabled: !presets.hasTarget || presets.busy },
    {
      label: 'Delete preset',
      onSelect: presets.handleDelete,
      disabled: !presets.canDelete || presets.busy,
      danger: true,
    },
    { label: 'Undo preset load', onSelect: presets.handleUndo, disabled: !presets.undoBlob || presets.busy },
  ]
}

export default function DevicePresetMenu({ presets, deviceName }) {
  const {
    groups, selectValue, hasAny, hasTarget, busy, errorText, setErrorText, saving, draftName,
    setDraftName, overwriteArmed, setOverwriteArmed, nameInputRef, applyPreset, cancelSave,
    commitSave, handleNameKeyDown,
  } = presets

  const options = useMemo(() => [
    ...groups.factory.map((p) => ({ value: `factory:${p.slug}`, label: p.name, group: 'Factory' })),
    ...groups.user.map((p) => ({ value: `user:${p.slug}`, label: p.name, group: 'User' })),
  ], [groups])

  if (errorText) {
    return (
      <div className={styles.row} role="alert">
        <span className={styles.error} title={errorText}>{errorText}</span>
        <IconButton size="sm" label="Dismiss the preset error" onClick={() => setErrorText(null)}>
          <IcX aria-hidden="true" />
        </IconButton>
      </div>
    )
  }

  if (saving) {
    return (
      <div className={styles.row}>
        <input
          ref={nameInputRef}
          type="text"
          className={styles.name}
          placeholder={overwriteArmed ? 'Overwrite?' : 'Preset name'}
          value={draftName}
          maxLength={80}
          onChange={(e) => { setDraftName(e.target.value); setOverwriteArmed(false) }}
          onKeyDown={handleNameKeyDown}
          aria-label={`${deviceName} preset name`}
          data-hint="Name the preset. Enter saves, Escape cancels."
        />
        <IconButton
          size="sm"
          label={overwriteArmed ? 'Confirm overwrite' : 'Save preset'}
          pressed={overwriteArmed || undefined}
          onClick={commitSave}
          disabled={busy}
        >
          <IcCheck aria-hidden="true" />
        </IconButton>
        <IconButton size="sm" label="Cancel saving" onClick={cancelSave}>
          <IcX aria-hidden="true" />
        </IconButton>
      </div>
    )
  }

  return (
    <Select
      size="sm"
      className={styles.select}
      ariaLabel={`${deviceName} preset`}
      hint="Load a preset. Save, delete and undo are in the more menu."
      placeholder={hasAny ? 'Presets…' : 'No presets'}
      value={selectValue || null}
      options={options}
      disabled={!hasTarget || busy || !hasAny}
      onChange={(value) => {
        const raw = String(value)
        const sep = raw.indexOf(':')
        applyPreset(raw.slice(0, sep), raw.slice(sep + 1))
      }}
    />
  )
}
