import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import {
  SHORTCUT_COMMANDS,
  SHORTCUT_GROUPS,
  comboFromEvent,
  formatCombo,
  isEditable,
} from '../../windowing/managers/shortcutCatalog.ts'
import {
  findConflicts,
  hasOverride,
  load as loadOverrides,
  reset as resetCommand,
  resetAll as resetAllCommands,
  resolveCombo,
  setCombo,
  subscribe as subscribeOverrides,
} from '../../windowing/managers/shortcutOverrides.ts'

// ─── Settings → Application → Shortcuts ──────────────────────────────────────
//
// An editor over shortcutCatalog's commands. It never spells a combo itself:
// every row's current key comes from resolveCombo, so what this panel shows is
// by construction the key KeyboardManager will actually dispatch on.
//
// ── Capture beats the router ────────────────────────────────────────────────
// While a row is listening, the next key press has to reach THIS component and
// nothing else — otherwise pressing Ctrl+S to rebind Save would save the
// project, and pressing F9 would toggle the Mixer behind the dialog. The
// capture listener therefore runs on window in the capture phase (ahead of
// KeyboardManager's own capture-phase overlay listener, because it is added
// later on the same target only while listening) and calls
// stopImmediatePropagation, so the event dies before any router sees it.

function useOverridesVersion() {
  // The override map lives outside React; this re-renders the editor whenever
  // it changes, including changes made by rebind() from elsewhere.
  const [version, setVersion] = useState(0)
  useEffect(() => subscribeOverrides(() => setVersion(v => v + 1)), [])
  return version
}

function ShortcutRow({ command, listening, onStartCapture, onCancelCapture, onReset }) {
  const combo = resolveCombo(command.id)
  const overridden = hasOverride(command.id)
  const conflicts = useMemo(
    () => (combo ? findConflicts(command.id, combo) : []),
    [command.id, combo]
  )
  const editable = isEditable(command)

  return (
    <div className="settings-panel-row settings-panel-shortcut-row">
      <div className="settings-panel-row-copy">
        <div className="settings-panel-label">{command.label}</div>
        {command.description && (
          <div className="settings-panel-field-copy">{command.description}</div>
        )}
        {conflicts.length > 0 && (
          <div className="settings-panel-hint settings-panel-hint--warning">
            Also assigned to {conflicts.map(c => c.label).join(', ')}
          </div>
        )}
      </div>
      <div className="settings-panel-control settings-panel-shortcut-control">
        <button
          type="button"
          className={
            'settings-panel-shortcut-key'
            + (listening ? ' settings-panel-shortcut-key--listening' : '')
            + (overridden ? ' settings-panel-shortcut-key--custom' : '')
          }
          disabled={!editable}
          aria-label={
            editable
              ? `Change shortcut for ${command.label}. Currently ${formatCombo(combo)}.`
              : `${command.label} shortcut is fixed at ${formatCombo(combo)}.`
          }
          onClick={() => (listening ? onCancelCapture() : onStartCapture(command.id))}
        >
          {listening ? 'Press a key…' : formatCombo(combo)}
        </button>
        <button
          type="button"
          className="settings-panel-button settings-panel-button--icon"
          onClick={() => onReset(command.id)}
          disabled={!overridden}
          title={overridden ? `Reset to ${formatCombo(command.defaultCombo)}` : 'Already the default'}
          aria-label={`Reset ${command.label} to its default shortcut`}
        >
          <RotateCcw size={13} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

export default function ShortcutsSection({ SettingsSection }) {
  const [listeningId, setListeningId] = useState(null)
  const [status, setStatus] = useState(null)
  useOverridesVersion()

  // Re-read on mount: another window, or a rebind() call elsewhere in this
  // session, may have changed the stored map since it was last loaded.
  useEffect(() => { loadOverrides() }, [])

  const cancelCapture = useCallback(() => setListeningId(null), [])

  useEffect(() => {
    if (!listeningId) return undefined

    const onKeyDown = (event) => {
      event.preventDefault()
      event.stopImmediatePropagation()

      // Escape abandons the capture rather than being assigned. Binding a
      // command to Escape would collide with the app-wide cancel key, and
      // "press Escape to get out of this" is what a user will try first.
      if (event.key === 'Escape') {
        setListeningId(null)
        return
      }

      const combo = comboFromEvent(event)
      if (!combo) return // a bare modifier — still assembling the chord

      const conflicts = findConflicts(listeningId, combo)
      setCombo(listeningId, combo).then((ok) => {
        if (!ok) return
        setStatus(
          conflicts.length > 0
            ? { kind: 'warning', text: `Assigned — also used by ${conflicts.map(c => c.label).join(', ')}.` }
            : { kind: 'success', text: 'Shortcut updated.' }
        )
      })
      setListeningId(null)
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [listeningId])

  const handleReset = useCallback(async (commandId) => {
    await resetCommand(commandId)
    setStatus({ kind: 'success', text: 'Shortcut restored to its default.' })
  }, [])

  const handleResetAll = useCallback(async () => {
    await resetAllCommands()
    setStatus({ kind: 'success', text: 'All shortcuts restored to their defaults.' })
  }, [])

  const byGroup = useMemo(() => {
    const map = new Map()
    for (const command of SHORTCUT_COMMANDS) {
      if (!map.has(command.group)) map.set(command.group, [])
      map.get(command.group).push(command)
    }
    return map
  }, [])

  return (
    <>
      {SHORTCUT_GROUPS.map((group, index) => {
        const commands = byGroup.get(group.id) || []
        if (commands.length === 0) return null
        return (
          <SettingsSection
            key={group.id}
            title={group.label}
            index={index}
            className="settings-panel-section--list"
          >
            <div className="settings-panel-hint settings-panel-hint--inline">
              {group.description}
            </div>
            {commands.map(command => (
              <ShortcutRow
                key={command.id}
                command={command}
                listening={listeningId === command.id}
                onStartCapture={setListeningId}
                onCancelCapture={cancelCapture}
                onReset={handleReset}
              />
            ))}
          </SettingsSection>
        )
      })}

      <SettingsSection title="Defaults" index={SHORTCUT_GROUPS.length}>
        <div className="settings-panel-row">
          <div className="settings-panel-row-copy">
            <div className="settings-panel-label">Restore all shortcuts</div>
            <div className="settings-panel-field-copy">
              Discards every customised key and returns to the shipped defaults.
            </div>
          </div>
          <div className="settings-panel-control">
            <button type="button" className="settings-panel-button" onClick={handleResetAll}>
              Reset All
            </button>
          </div>
        </div>
        {status && (
          <div className={`settings-panel-hint settings-panel-hint--inline settings-panel-hint--${status.kind}`}>
            {status.text}
          </div>
        )}
        <div className="settings-panel-hint settings-panel-hint--inline">
          Panel and Sample Sandbox shortcuts only fire while that panel is focused, so
          they may reuse a key the rest of the app also uses.
        </div>
      </SettingsSection>
    </>
  )
}
