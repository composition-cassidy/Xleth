import React, { useCallback, useEffect, useState } from 'react'
import { getTokenOptionsForGroup } from '../../appearance/tokenSlots.js'
import { InspectorGroup, SelectField } from './FieldControls.jsx'
import FrameFields from './FrameFields.jsx'
import { PLACEHOLDER_DECAL_ID } from '../../appearance/decals/placeholder.js'
import { listDecalAssets, importDecalAsset, deleteDecalAsset } from '../../appearance/decals/assetRegistry.js'

const FIT_OPTIONS = [
  { value: 'contain', label: 'Contain' },
  { value: 'cover',   label: 'Cover' },
  { value: 'stretch', label: 'Stretch' },
]

const OPACITY_OPTIONS = [
  { value: '25',  label: '25%' },
  { value: '50',  label: '50%' },
  { value: '75',  label: '75%' },
  { value: '100', label: '100%' },
]

function buildTintTokenOptions() {
  return [
    { value: 'tint.none', label: 'No Tint' },
    ...getTokenOptionsForGroup('accent').map(o => ({ value: o.value, label: o.label })),
    ...getTokenOptionsForGroup('text').map(o  => ({ value: o.value, label: o.label })),
  ]
}

export default function DecalInspector({ node, onPatchProps }) {
  const props = node.props || {}
  const frame = props.frame || {}
  const tintTokenOptions = buildTintTokenOptions()
  const currentAssetId = props.assetId || PLACEHOLDER_DECAL_ID

  const [assetList, setAssetList]   = useState([
    { assetId: PLACEHOLDER_DECAL_ID, label: 'Placeholder (missing asset)' },
  ])
  const [importError, setImportError] = useState(null)
  const [isImporting, setIsImporting] = useState(false)
  const [deleteError, setDeleteError] = useState(null)

  const patchFrame = (newFrame) => onPatchProps?.({ frame: newFrame })

  const refreshAssetList = useCallback(async () => {
    const list = await listDecalAssets()
    setAssetList(list)
  }, [])

  useEffect(() => { refreshAssetList() }, [refreshAssetList])

  const handleImport = async () => {
    setImportError(null)
    setIsImporting(true)
    try {
      const imported = await importDecalAsset()
      if (imported) {
        await refreshAssetList()
        onPatchProps?.({ assetId: imported.assetId })
      }
    } catch (err) {
      setImportError(err?.message || 'Import failed.')
    } finally {
      setIsImporting(false)
    }
  }

  const handleDelete = async () => {
    if (!window.confirm('Delete this decal asset from the local registry? Layouts using it will show a placeholder.')) return
    setDeleteError(null)
    try {
      await deleteDecalAsset(currentAssetId)
      await refreshAssetList()
      onPatchProps?.({ assetId: PLACEHOLDER_DECAL_ID })
    } catch (err) {
      setDeleteError(err?.message || 'Delete failed.')
    }
  }

  // Build dropdown options from the live asset list.
  const assetOptions = assetList.map(a => ({
    value: a.assetId,
    label: a.label || a.assetId,
  }))

  // Detect missing: valid user-imported id that isn't in the loaded list.
  // assetList.length > 1 means the list has finished loading (placeholder + any user assets).
  // With the initial state (just placeholder), any user.imported.* id is "missing" until the list loads.
  const isUserAsset     = currentAssetId !== PLACEHOLDER_DECAL_ID
  const notInList       = !assetOptions.some(o => o.value === currentAssetId)
  const isMissingAsset  = isUserAsset && notInList

  // If the current assetId isn't in the list (deleted/missing), show it as a fallback option.
  if (isMissingAsset) {
    assetOptions.push({ value: currentAssetId, label: `${currentAssetId} (missing)` })
  }

  return (
    <>
      <FrameFields frame={frame} onPatchFrame={patchFrame} />

      <InspectorGroup title="Decal">
        <SelectField
          label="assetId"
          value={currentAssetId}
          options={assetOptions}
          onChange={assetId => onPatchProps?.({ assetId })}
        />

        {isMissingAsset && (
          <div className="pluginui-designer-decal-missing">
            <div className="pluginui-designer-error-text">
              Asset not found in local registry. Import a replacement or reset.
            </div>
            <div className="pluginui-designer-decal-missing-actions">
              <button
                className="pluginui-designer-button pluginui-designer-button--compact"
                onClick={() => onPatchProps?.({ assetId: PLACEHOLDER_DECAL_ID })}
                title="Reset to placeholder"
              >
                Use Placeholder
              </button>
              <button
                className="pluginui-designer-button pluginui-designer-button--compact"
                onClick={handleImport}
                disabled={isImporting}
                title="Import a PNG or WebP to replace this missing asset"
              >
                {isImporting ? 'Importing…' : 'Import Replacement'}
              </button>
            </div>
          </div>
        )}

        <div className="pluginui-designer-field">
          <button
            className="pluginui-designer-button pluginui-designer-decal-import-btn"
            onClick={handleImport}
            disabled={isImporting}
            title="Import a PNG or WebP image as a decal asset (stored locally, not in the layout file)"
          >
            {isImporting ? 'Importing…' : 'Import PNG/WebP'}
          </button>
          {importError && (
            <div className="pluginui-designer-field-error">{importError}</div>
          )}
        </div>

        {isUserAsset && !isMissingAsset && (
          <div className="pluginui-designer-field">
            <button
              className="pluginui-designer-button pluginui-designer-button--compact pluginui-designer-button--danger"
              onClick={handleDelete}
              title="Remove from local registry — layouts using it will show placeholder"
            >
              Delete Asset
            </button>
            {deleteError && (
              <div className="pluginui-designer-field-error">{deleteError}</div>
            )}
          </div>
        )}

        <SelectField
          label="fit"
          value={props.fit || 'contain'}
          options={FIT_OPTIONS}
          onChange={fit => onPatchProps?.({ fit })}
        />

        <SelectField
          label="opacity"
          value={String(props.opacity ?? 100)}
          options={OPACITY_OPTIONS}
          onChange={v => onPatchProps?.({ opacity: parseInt(v, 10) })}
        />

        <SelectField
          label="tintToken"
          value={props.tintToken || 'tint.none'}
          options={tintTokenOptions}
          onChange={tintToken => onPatchProps?.({ tintToken: tintToken === 'tint.none' ? undefined : tintToken })}
        />
      </InspectorGroup>
    </>
  )
}
