import React, { useCallback, useMemo, useRef } from 'react'
import { Button, DeviceFrame } from '../../ui-kit'
import useEffectChainStore from '../../stores/effectChainStore.js'
import useVstStore from '../../stores/vstStore.js'
import useEffectPresets from '../../fx-presets/useEffectPresets.js'
import { EFFECT_EDITORS, resolveTrackId } from '../mixer/effectEditorOpeners.js'
import { runEffectModuleInlineAction } from '../mixer/EffectModule.jsx'
import { deviceName } from './deviceNames.js'
import { deviceBodyFor } from './deviceRegistry.js'
import useDeviceUiStore, { deviceKey } from './deviceUiStore.js'
import useAbCompare from './useAbCompare.js'
import DevicePresetMenu, { presetMoreItems } from './DevicePresetMenu.jsx'
import styles from './EffectDevice.module.css'

const EXTERNAL_WIDTH = 200
const NO_EDITOR_STORE = () => null

// One chain entry as a device. Wires the frame to the existing stores:
// bypass -> useEffectChainStore.setBypass, delete -> removeEffect, move ->
// moveEffect, pop-out -> the effect's editor opener (EffectEditorHost mounts it).
//
// Every stock effect has a body in deviceRegistry.js. An entry without one is not
// a stock effect: a third-party plugin (its editor is a native window the app
// cannot draw), a missing or crashed one, or one still being added.
//
// Props:
//   effect        — chain entry { nodeId, pluginId, bypassed, missing, crashed, ... }
//   storeKey      — "master" | String(trackId)
//   presentation  — 'docked' (chain) | 'floating' (popped out, EffectEditorHost)
//   identityColor — owning track's colour
//   dragHandleProps, moveItems — chain reorder (docked only)
//   onClose       — floating only
//   canBypass     — false when the chain store does not own this effect (FX Graph)
export default function EffectDevice(props) {
  const reg = deviceBodyFor(props.effect?.pluginId)
  return reg ? <MigratedDevice {...props} reg={reg} /> : <ExternalPluginDevice {...props} />
}

function useCommonDeviceState({ effect, storeKey, canBypass = true, moveItems = [] }) {
  const vstPlugins = useVstStore((s) => s.plugins)
  const setBypass = useEffectChainStore((s) => s.setBypass)
  const removeEffect = useEffectChainStore((s) => s.removeEffect)
  const key = deviceKey(storeKey, effect.nodeId)
  const folded = useDeviceUiStore((s) => !!s.folded[key])
  const setFolded = useDeviceUiStore((s) => s.setFolded)
  const name = deviceName(effect, vstPlugins)
  const live = Number.isInteger(effect.nodeId) && effect.nodeId >= 0

  const onBypassChange = canBypass && live
    ? (bypassed) => {
        setBypass(storeKey, effect.nodeId, bypassed)
      }
    : undefined

  const tailItems = [
    ...moveItems,
    ...(live && canBypass
      ? [{ label: `Delete ${name}`, danger: true, onSelect: () => removeEffect(storeKey, effect.nodeId) }]
      : []),
  ]

  return {
    key, name, live, folded, onBypassChange, tailItems,
    onFoldChange: (next) => setFolded(key, next),
  }
}

function MigratedDevice({
  effect, storeKey, presentation = 'docked', identityColor, dragHandleProps, moveItems, onClose,
  canBypass, reg, ...rest
}) {
  const common = useCommonDeviceState({ effect, storeKey, canBypass, moveItems })
  const trackId = resolveTrackId(storeKey)
  const target = useMemo(
    () => (common.live ? { trackId, nodeId: effect.nodeId, storeKey } : null),
    [common.live, trackId, effect.nodeId, storeKey],
  )

  // The body owns its parameter state; presets and A/B tell it what they applied.
  const appliedRef = useRef(null)
  const registerApplied = useCallback((fn) => { appliedRef.current = fn }, [])
  const onApplied = useCallback((blob) => appliedRef.current?.(blob), [])

  const presetType = reg.presetType ?? effect.pluginId
  const presets = useEffectPresets({ effectType: presetType, target, onApplied })
  const ab = useAbCompare({ effectType: presetType, target, onApplied })

  const useEditorStore = reg.useEditorStore ?? NO_EDITOR_STORE
  const editorTarget = useEditorStore((s) => s?.target ?? null)
  const poppedOut = presentation === 'docked'
    && editorTarget != null
    && editorTarget.nodeId === effect.nodeId
    && editorTarget.storeKey === storeKey

  const popOut = useCallback(() => {
    const opener = EFFECT_EDITORS[effect.pluginId]
    if (!opener || !target) return
    opener(target.trackId, target.nodeId, storeKey)
  }, [effect.pluginId, target, storeKey, effect.nodeId])

  const moreItems = [
    ...presetMoreItems(presets),
    { label: `Copy ${ab.side.toUpperCase()} to ${ab.side === 'a' ? 'B' : 'A'}`, onSelect: ab.copyToOther, disabled: !target || ab.busy },
    ...common.tailItems,
  ]

  const { Body } = reg
  return (
    <DeviceFrame
      {...rest}
      name={common.name}
      width={reg.width}
      identityColor={identityColor}
      bypassed={!!effect.bypassed}
      onBypassChange={common.onBypassChange}
      bypassHint={canBypass === false ? 'Bypass this effect from the FX Graph, which owns this track.' : undefined}
      folded={common.folded}
      onFoldChange={common.onFoldChange}
      presentation={presentation}
      presetSlot={<DevicePresetMenu presets={presets} deviceName={common.name} />}
      compare={{ side: ab.side, onSwitch: ab.switchTo, disabled: !target || ab.busy }}
      moreItems={moreItems}
      onPopOut={target ? popOut : undefined}
      onClose={onClose}
      poppedOut={poppedOut}
      onReturn={() => useEditorStore.getState?.().close?.()}
      dragHandleProps={dragHandleProps}
      data-device-plugin={effect.pluginId}
    >
      {target && !common.folded && !poppedOut ? (
        <Body target={target} registerApplied={registerApplied} deviceKey={common.key} presentation={presentation} effect={effect} />
      ) : null}
    </DeviceFrame>
  )
}

// A chain entry that is not a stock effect. The frame is the same; the body says
// what the plugin is doing and, for a live one, opens its own editor window.
function ExternalPluginDevice({
  effect, storeKey, presentation = 'docked', identityColor, dragHandleProps, moveItems, onClose,
  canBypass, ...rest
}) {
  const common = useCommonDeviceState({ effect, storeKey, canBypass, moveItems })
  const fetchChain = useEffectChainStore((s) => s.fetchChain)
  const removeEffect = useEffectChainStore((s) => s.removeEffect)
  const trackId = resolveTrackId(storeKey)

  const open = () => {
    if (!common.live) return
    window.xleth?.audio?.openPluginEditor?.(trackId, effect.nodeId)
  }

  let status
  let action = null
  if (!common.live) {
    status = 'Adding…'
  } else if (effect.missing && effect.missingReason === 'quarantined') {
    status = "Plugin quarantined. It crashed XLETH's engine while loading; its settings are kept."
  } else if (effect.missing) {
    status = 'Plugin missing. It is not installed on this computer.'
  } else if (effect.crashed) {
    status = 'Plugin crashed and is bypassed.'
    action = (
      <Button size="sm" onClick={() => runEffectModuleInlineAction('reset', {
        audio: window.xleth?.audio, fetchChain, removeEffect, storeKey, nodeId: effect.nodeId,
      })}
      >
        Reset
      </Button>
    )
  } else {
    status = 'Plugin editor opens in its own window.'
    action = <Button size="sm" onClick={open}>Open editor</Button>
  }

  return (
    <DeviceFrame
      {...rest}
      name={common.name}
      width={EXTERNAL_WIDTH}
      identityColor={identityColor}
      bypassed={!!effect.bypassed}
      onBypassChange={common.onBypassChange}
      folded={common.folded}
      onFoldChange={common.onFoldChange}
      presentation={presentation}
      moreItems={common.tailItems}
      onPopOut={common.live && !effect.missing ? open : undefined}
      onClose={onClose}
      dragHandleProps={dragHandleProps}
      data-device-plugin={effect.pluginId}
    >
      <div className={styles.external}>
        <p className={styles.status}>{status}</p>
        {action}
      </div>
    </DeviceFrame>
  )
}
