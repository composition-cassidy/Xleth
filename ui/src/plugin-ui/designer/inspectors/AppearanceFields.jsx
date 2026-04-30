import React from 'react'
import {
  getAppearanceNumberRange,
  getAppearanceOptionLabel,
  getAppearanceRulesForType,
  getRepairableEnumOptions,
  getRepairableTokenOptions,
} from '../../appearance/appearanceRegistry.js'
import { KNOB_PRESETS, KNOB_PRESET_IDS } from '../../appearance/knobPresets.js'
import { useUserKnobPresetsStore } from '../../appearance/useUserKnobPresetsStore.js'

const KNOB_ENUM_KEYS = [
  'sizePreset',
  'cap',
  'ring',
  'pointer',
  'ticks',
  'tickDensity',
  'valueReadout',
  'labelPlacement',
  'depth',
]

const KNOB_NUMBER_KEYS = ['sizePx']

const KNOB_TOKEN_KEYS = [
  'surfaceToken',
  'accentToken',
  'textToken',
]

const APPEARANCE_ERROR_CODES = new Set([
  'BAD_APPEARANCE',
  'APPEARANCE_NOT_SUPPORTED',
  'UNKNOWN_APPEARANCE_KEY',
  'UNKNOWN_APPEARANCE_VALUE',
  'UNKNOWN_APPEARANCE_TOKEN',
  'RAW_APPEARANCE_VALUE',
  'APPEARANCE_ESCAPE_KEY',
  'PLUGIN_KNOB_COLOR_FORBIDDEN',
  'BAD_APPEARANCE_NUMBER',
])

export function isAppearanceError(error) {
  return !!error && APPEARANCE_ERROR_CODES.has(error.code)
}

export function getAppearanceErrors(validationErrors = []) {
  return validationErrors.filter(isAppearanceError)
}

export function getAppearanceErrorForKey(validationErrors = [], key) {
  return getAppearanceErrors(validationErrors).find(error => error?.key === key) || null
}

export default function AppearanceFields({
  nodeType,
  appearance,
  onPatchAppearance,
  onApplyPresetDefaults,
  onReplaceAppearance,
  validationErrors = [],
  disabled = false,
}) {
  if (nodeType !== 'knob') return null

  const rules = getAppearanceRulesForType(nodeType)
  if (!rules) return null

  const appearanceObj = (appearance && typeof appearance === 'object' && !Array.isArray(appearance))
    ? appearance
    : {}

  const appearanceErrors = getAppearanceErrors(validationErrors)
  const presetError = getAppearanceErrorForKey(validationErrors, 'preset')
  const knobColorError = appearanceErrors.find(error => error.code === 'PLUGIN_KNOB_COLOR_FORBIDDEN')

  return (
    <div className="pluginui-designer-inspector-group pluginui-designer-appearance">
      <div className="pluginui-designer-inspector-group-title">Appearance</div>

      <KnobPresetPicker
        currentPresetId={appearanceObj.preset}
        onSelectPreset={(presetId) => handleSelectPreset(presetId, onPatchAppearance)}
        onApplyPresetDefaults={onApplyPresetDefaults}
        presetError={presetError}
        disabled={disabled}
      />

      {nodeType === 'knob' && onReplaceAppearance && (
        <UserKnobPresets
          currentAppearance={appearanceObj}
          onReplaceAppearance={onReplaceAppearance}
          disabled={disabled}
        />
      )}

      <div className="pluginui-designer-appearance-section">
        <div className="pluginui-designer-appearance-section-title">Style</div>
        {KNOB_ENUM_KEYS.map(key => (
          <AppearanceEnumRow
            key={key}
            nodeType={nodeType}
            appearanceKey={key}
            value={appearanceObj[key]}
            error={getAppearanceErrorForKey(validationErrors, key)}
            disabled={disabled}
            onChange={(nextValue) => handleEnumChange(onPatchAppearance, key, nextValue)}
          />
        ))}
        {KNOB_NUMBER_KEYS.map(key => (
          <AppearanceNumberRow
            key={key}
            nodeType={nodeType}
            appearanceKey={key}
            value={appearanceObj[key]}
            error={getAppearanceErrorForKey(validationErrors, key)}
            disabled={disabled}
            onChange={(nextValue) => handleNumberChange(onPatchAppearance, key, nextValue)}
          />
        ))}
      </div>

      <div className="pluginui-designer-appearance-section">
        <div className="pluginui-designer-appearance-section-title">Tokens</div>
        {KNOB_TOKEN_KEYS.map(key => (
          <AppearanceTokenRow
            key={key}
            nodeType={nodeType}
            appearanceKey={key}
            value={appearanceObj[key]}
            error={getAppearanceErrorForKey(validationErrors, key)}
            disabled={disabled}
            onChange={(nextValue) => handleTokenChange(onPatchAppearance, key, nextValue)}
          />
        ))}
      </div>

      {knobColorError && (
        <div className="pluginui-designer-appearance-hint pluginui-designer-appearance-hint--error">
          props.color is forbidden on plugin UI knobs. Use Accent token instead.
        </div>
      )}

      {appearanceErrors.filter(error => !error.key && error.code !== 'PLUGIN_KNOB_COLOR_FORBIDDEN').map((error, index) => (
        <div
          key={`${error.code}-${index}`}
          className="pluginui-designer-appearance-hint pluginui-designer-appearance-hint--error"
        >
          {error.message || error.code}
        </div>
      ))}
    </div>
  )
}

function handleSelectPreset(presetId, onPatchAppearance) {
  if (!presetId) {
    onPatchAppearance?.({ preset: undefined })
    return
  }
  onPatchAppearance?.({ preset: presetId })
}

function handleEnumChange(onPatchAppearance, key, nextValue) {
  if (!nextValue) {
    onPatchAppearance?.({ [key]: undefined })
    return
  }
  onPatchAppearance?.({ [key]: nextValue })
}

function handleTokenChange(onPatchAppearance, key, nextValue) {
  if (!nextValue) {
    onPatchAppearance?.({ [key]: undefined })
    return
  }
  onPatchAppearance?.({ [key]: nextValue })
}

function handleNumberChange(onPatchAppearance, key, nextValue) {
  if (nextValue === undefined || nextValue === null || Number.isNaN(nextValue)) {
    onPatchAppearance?.({ [key]: undefined })
    return
  }
  onPatchAppearance?.({ [key]: nextValue })
}

function KnobPresetPicker({ currentPresetId, onSelectPreset, onApplyPresetDefaults, presetError, disabled }) {
  const isKnown = !!currentPresetId && KNOB_PRESET_IDS.includes(currentPresetId)

  return (
    <div className="pluginui-designer-appearance-presets">
      <div className="pluginui-designer-appearance-section-title">Preset</div>
      <div className="pluginui-designer-appearance-preset-grid" role="radiogroup" aria-label="Knob preset">
        <PresetCard
          presetId=""
          label="Default"
          description="Use component default appearance."
          active={!currentPresetId}
          disabled={disabled}
          onSelect={() => onSelectPreset(undefined)}
        />
        {KNOB_PRESET_IDS.map(presetId => (
          <PresetCard
            key={presetId}
            presetId={presetId}
            label={KNOB_PRESETS[presetId].label}
            description={KNOB_PRESETS[presetId].description}
            active={currentPresetId === presetId}
            disabled={disabled}
            onSelect={() => onSelectPreset(presetId)}
          />
        ))}
        {!isKnown && currentPresetId && (
          <div
            className="pluginui-designer-appearance-preset-card pluginui-designer-appearance-preset-card--removed"
            role="status"
          >
            <span className="pluginui-designer-appearance-preset-card-label">
              (removed) {String(currentPresetId)}
            </span>
            <span className="pluginui-designer-appearance-preset-card-description">
              Pick a valid preset to repair.
            </span>
          </div>
        )}
      </div>

      {onApplyPresetDefaults && currentPresetId && isKnown && (
        <button
          type="button"
          className="pluginui-designer-appearance-apply-defaults"
          onClick={() => onApplyPresetDefaults(currentPresetId)}
          disabled={disabled}
        >
          Apply preset defaults
        </button>
      )}

      {presetError && (
        <div className="pluginui-designer-appearance-hint pluginui-designer-appearance-hint--warning">
          {formatAppearanceErrorMessage(presetError)}
        </div>
      )}
    </div>
  )
}

function PresetCard({ presetId, label, description, active, disabled, onSelect }) {
  const className = [
    'pluginui-designer-appearance-preset-card',
    active ? 'pluginui-designer-appearance-preset-card--active' : '',
  ].filter(Boolean).join(' ')

  return (
    <button
      type="button"
      className={className}
      role="radio"
      aria-checked={active}
      data-preset={presetId || 'default'}
      disabled={disabled}
      onClick={onSelect}
    >
      <span
        className={[
          'pluginui-designer-appearance-preset-swatch',
          presetId ? `pluginui-knob--${presetId}` : '',
        ].filter(Boolean).join(' ')}
        aria-hidden="true"
      />
      <span className="pluginui-designer-appearance-preset-card-label">{label}</span>
      <span className="pluginui-designer-appearance-preset-card-description">{description}</span>
    </button>
  )
}

function useUserKnobPresetsSnapshot() {
  const [, force] = React.useState(0)
  React.useEffect(() => useUserKnobPresetsStore.subscribe(() => force(n => n + 1)), [])
  return useUserKnobPresetsStore.getState()
}

function UserKnobPresets({ currentAppearance, onReplaceAppearance, disabled }) {
  const { presets, isLoaded, isLoading, loadError, saveError, load, saveCurrent, remove } = useUserKnobPresetsSnapshot()
  const [isNaming, setIsNaming] = React.useState(false)
  const [draftLabel, setDraftLabel] = React.useState('')
  const [pendingDeleteId, setPendingDeleteId] = React.useState(null)
  const [localError, setLocalError] = React.useState(null)

  React.useEffect(() => {
    if (!isLoaded && !isLoading) load()
  }, [isLoaded, isLoading, load])

  const hasAppearance = !!currentAppearance && Object.keys(currentAppearance).length > 0

  const startNaming = () => {
    setLocalError(null)
    setDraftLabel('')
    setIsNaming(true)
  }
  const cancelNaming = () => {
    setIsNaming(false)
    setDraftLabel('')
    setLocalError(null)
  }
  const commitNaming = async () => {
    const label = draftLabel.trim()
    if (!label) {
      setLocalError('Name is required')
      return
    }
    const result = await saveCurrent({ label, appearance: currentAppearance })
    if (result?.ok === false) {
      setLocalError(result.error || 'Save failed')
      return
    }
    cancelNaming()
  }

  const handleApply = (preset) => {
    if (!preset?.appearance) return
    onReplaceAppearance?.(preset.appearance)
  }

  const askDelete = (preset) => {
    if (!preset) return
    setPendingDeleteId(preset.id)
  }
  const cancelDelete = () => setPendingDeleteId(null)
  const confirmDelete = async (preset) => {
    setPendingDeleteId(null)
    await remove(preset.id)
  }

  return (
    <div className="pluginui-designer-appearance-presets pluginui-designer-appearance-user-presets">
      <div className="pluginui-designer-appearance-section-title">Your presets</div>

      {presets.length === 0 ? (
        <div className="pluginui-designer-appearance-hint">
          {isLoading ? 'Loading…' : 'No saved presets yet. Tune appearance, then save below.'}
        </div>
      ) : (
        <div className="pluginui-designer-appearance-preset-grid" role="list">
          {presets.map(preset => (
            <UserPresetCard
              key={preset.id}
              preset={preset}
              disabled={disabled}
              pendingDelete={pendingDeleteId === preset.id}
              onApply={() => handleApply(preset)}
              onAskDelete={() => askDelete(preset)}
              onConfirmDelete={() => confirmDelete(preset)}
              onCancelDelete={cancelDelete}
            />
          ))}
        </div>
      )}

      {isNaming ? (
        <div className="pluginui-designer-appearance-name-form">
          <input
            type="text"
            className="pluginui-designer-input"
            autoFocus
            placeholder="Preset name"
            maxLength={64}
            value={draftLabel}
            disabled={disabled}
            onChange={event => setDraftLabel(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') { event.preventDefault(); commitNaming() }
              else if (event.key === 'Escape') { event.preventDefault(); cancelNaming() }
            }}
          />
          <div className="pluginui-designer-appearance-name-form-actions">
            <button
              type="button"
              className="pluginui-designer-appearance-apply-defaults"
              onClick={commitNaming}
              disabled={disabled || !draftLabel.trim()}
            >
              Save
            </button>
            <button
              type="button"
              className="pluginui-designer-appearance-apply-defaults"
              onClick={cancelNaming}
              disabled={disabled}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="pluginui-designer-appearance-apply-defaults"
          onClick={startNaming}
          disabled={disabled || !hasAppearance}
          title={hasAppearance ? 'Save current appearance as a reusable preset' : 'Tune appearance first to save a preset'}
        >
          Save current as preset…
        </button>
      )}

      {(localError || loadError || saveError) && (
        <div className="pluginui-designer-appearance-hint pluginui-designer-appearance-hint--error">
          {localError || loadError || saveError}
        </div>
      )}
    </div>
  )
}

function UserPresetCard({ preset, disabled, pendingDelete, onApply, onAskDelete, onConfirmDelete, onCancelDelete }) {
  return (
    <div
      className="pluginui-designer-appearance-preset-card pluginui-designer-appearance-preset-card--user"
      role="listitem"
      data-user-preset-id={preset.id}
    >
      <button
        type="button"
        className="pluginui-designer-appearance-preset-card-apply"
        onClick={onApply}
        disabled={disabled || pendingDelete}
        title={preset.description || 'Apply this preset'}
      >
        <span
          className={[
            'pluginui-designer-appearance-preset-swatch',
            preset.appearance?.preset ? `pluginui-knob--${preset.appearance.preset}` : '',
          ].filter(Boolean).join(' ')}
          aria-hidden="true"
        />
        <span className="pluginui-designer-appearance-preset-card-label">{preset.label}</span>
        {preset.description && (
          <span className="pluginui-designer-appearance-preset-card-description">{preset.description}</span>
        )}
      </button>
      {pendingDelete ? (
        <div className="pluginui-designer-appearance-preset-card-delete-confirm">
          <button
            type="button"
            className="pluginui-designer-appearance-preset-card-delete pluginui-designer-appearance-preset-card-delete--yes"
            onClick={onConfirmDelete}
            disabled={disabled}
            title="Confirm delete"
            aria-label={`Confirm delete preset ${preset.label}`}
          >
            ✓
          </button>
          <button
            type="button"
            className="pluginui-designer-appearance-preset-card-delete"
            onClick={onCancelDelete}
            disabled={disabled}
            title="Cancel delete"
            aria-label="Cancel delete"
          >
            ↶
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="pluginui-designer-appearance-preset-card-delete"
          onClick={onAskDelete}
          disabled={disabled}
          aria-label={`Delete preset ${preset.label}`}
          title="Delete this preset"
        >
          ×
        </button>
      )}
    </div>
  )
}

function AppearanceEnumRow({ nodeType, appearanceKey, value, error, disabled, onChange }) {
  const options = getRepairableEnumOptions(nodeType, appearanceKey, value)

  return (
    <label className="pluginui-designer-field pluginui-designer-appearance-row">
      <span className="pluginui-designer-field-label">{enumKeyLabel(appearanceKey)}</span>
      <select
        className={[
          'pluginui-designer-select',
          error ? 'pluginui-designer-select--invalid' : '',
        ].filter(Boolean).join(' ')}
        value={value || ''}
        disabled={disabled}
        onChange={event => onChange(event.target.value || undefined)}
      >
        <option value="">(preset default)</option>
        {options.map(option => (
          <option
            key={option.value}
            value={option.value}
            disabled={option.disabled}
          >
            {option.label}
          </option>
        ))}
      </select>
      {error && (
        <span className="pluginui-designer-appearance-row-hint">
          {formatAppearanceErrorMessage(error)}
        </span>
      )}
    </label>
  )
}

function AppearanceTokenRow({ nodeType, appearanceKey, value, error, disabled, onChange }) {
  const options = getRepairableTokenOptions(nodeType, appearanceKey, value)

  return (
    <label className="pluginui-designer-field pluginui-designer-appearance-row">
      <span className="pluginui-designer-field-label">{tokenKeyLabel(appearanceKey)}</span>
      <select
        className={[
          'pluginui-designer-select',
          error ? 'pluginui-designer-select--invalid' : '',
        ].filter(Boolean).join(' ')}
        value={value || ''}
        disabled={disabled}
        onChange={event => onChange(event.target.value || undefined)}
      >
        <option value="">(preset default)</option>
        {options.map(option => (
          <option
            key={option.value}
            value={option.value}
            disabled={option.disabled}
          >
            {option.label}
          </option>
        ))}
      </select>
      {error && (
        <span className="pluginui-designer-appearance-row-hint">
          {formatAppearanceErrorMessage(error)}
        </span>
      )}
    </label>
  )
}

function enumKeyLabel(key) {
  switch (key) {
    case 'sizePreset': return 'Size'
    case 'cap': return 'Cap'
    case 'ring': return 'Ring'
    case 'pointer': return 'Pointer'
    case 'ticks': return 'Ticks'
    case 'tickDensity': return 'Tick density'
    case 'valueReadout': return 'Value readout'
    case 'labelPlacement': return 'Label placement'
    case 'depth': return 'Depth'
    default: return key
  }
}

function numberKeyLabel(key) {
  switch (key) {
    case 'sizePx': return 'Custom size (px)'
    default: return key
  }
}

function AppearanceNumberRow({ nodeType, appearanceKey, value, error, disabled, onChange }) {
  const range = getAppearanceNumberRange(nodeType, appearanceKey)
  const min = range?.min
  const max = range?.max
  const step = range?.integer ? 1 : 0.01
  const hasValue = typeof value === 'number' && Number.isFinite(value)
  const inputValue = hasValue ? String(value) : ''

  const commit = (raw) => {
    if (raw === '' || raw == null) {
      onChange(undefined)
      return
    }
    const parsed = range?.integer ? parseInt(raw, 10) : parseFloat(raw)
    if (!Number.isFinite(parsed)) {
      onChange(undefined)
      return
    }
    const clamped = Math.min(max, Math.max(min, parsed))
    const rounded = range?.integer ? Math.round(clamped) : clamped
    onChange(rounded)
  }

  return (
    <label className="pluginui-designer-field pluginui-designer-appearance-row">
      <span className="pluginui-designer-field-label">{numberKeyLabel(appearanceKey)}</span>
      <div className="pluginui-designer-appearance-number-row">
        <input
          type="number"
          className={[
            'pluginui-designer-input',
            error ? 'pluginui-designer-select--invalid' : '',
          ].filter(Boolean).join(' ')}
          value={inputValue}
          placeholder="(preset default)"
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={event => commit(event.target.value)}
        />
        {hasValue && (
          <button
            type="button"
            className="pluginui-designer-appearance-number-clear"
            onClick={() => onChange(undefined)}
            disabled={disabled}
            title="Clear override"
            aria-label="Clear custom size"
          >
            ×
          </button>
        )}
      </div>
      {error && (
        <span className="pluginui-designer-appearance-row-hint">
          {formatAppearanceErrorMessage(error)}
        </span>
      )}
    </label>
  )
}

function tokenKeyLabel(key) {
  switch (key) {
    case 'surfaceToken': return 'Surface'
    case 'accentToken': return 'Accent'
    case 'textToken': return 'Text'
    case 'meterFillToken': return 'Meter fill'
    default: return key
  }
}

function formatAppearanceErrorMessage(error) {
  if (!error) return ''
  switch (error.code) {
    case 'UNKNOWN_APPEARANCE_VALUE':
      return `Unknown value${error.value ? ` "${error.value}"` : ''}.`
    case 'UNKNOWN_APPEARANCE_TOKEN':
      return `Unknown token${error.value ? ` "${error.value}"` : ''}.`
    case 'RAW_APPEARANCE_VALUE':
      return 'Raw CSS or color is not allowed.'
    case 'APPEARANCE_ESCAPE_KEY':
      return 'This appearance key is not allowed.'
    case 'BAD_APPEARANCE':
      return 'Appearance must be a plain object.'
    case 'BAD_APPEARANCE_NUMBER':
      return error.message || 'Value out of range.'
    default:
      return error.message || error.code || 'Invalid appearance value.'
  }
}

export { getAppearanceOptionLabel }
