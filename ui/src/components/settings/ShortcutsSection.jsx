import React, { useCallback, useEffect, useMemo, useState } from 'react'
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
import { Button, IconButton, TextField } from '../../ui-kit'
import { SettingsHint, SettingsSection } from './settingsKit.jsx'
import styles from './Shortcuts.module.css'
import { iconComponent } from '../../ui-kit/icons'

const IcArrowCounterClockwise = iconComponent('arrow-counter-clockwise')
const IcWarning = iconComponent('warning')

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

/** One cap per key of a combo ("Ctrl + Shift + S" is three caps). */
function KeyCaps({ text }) {
  const parts = text === 'Unassigned' ? [] : text.split(' + ')
  if (parts.length === 0) return <span className={styles.unassigned}>Unassigned</span>
  return (
    <span className={styles.caps}>
      {parts.map((part, i) => <kbd key={`${part}-${i}`} className={styles.cap}>{part}</kbd>)}
    </span>
  )
}

function ShortcutRow({ command, listening, onStartCapture, onCancelCapture, onReset }) {
  const combo = resolveCombo(command.id)
  const overridden = hasOverride(command.id)
  const conflicts = useMemo(
    () => (combo ? findConflicts(command.id, combo) : []),
    [command.id, combo]
  )
  const editable = isEditable(command)
  const shown = formatCombo(combo)

  return (
    <tr className={styles.row}>
      <td className={styles.action}>
        <div className={styles.actionName}>{command.label}</div>
        {command.description && <div className={styles.actionNote}>{command.description}</div>}
      </td>
      <td className={styles.binding}>
        <div className={styles.bindingCell}>
          <button
            type="button"
            className={styles.keyButton}
            data-listening={listening || undefined}
            data-custom={overridden || undefined}
            disabled={!editable}
            aria-label={
              editable
                ? `Change shortcut for ${command.label}. Currently ${shown}.`
                : `${command.label} shortcut is fixed at ${shown}.`
            }
            onClick={() => (listening ? onCancelCapture() : onStartCapture(command.id))}
          >
            {listening ? <span className={styles.listening}>Press a key…</span> : <KeyCaps text={shown} />}
          </button>
          {overridden ? <span className={styles.custom}>Custom</span> : null}
          <IconButton
            size="sm"
            variant="ghost"
            label={`Reset ${command.label} to its default shortcut`}
            hint={overridden ? `Reset to ${formatCombo(command.defaultCombo)}` : 'Already the default'}
            onClick={() => onReset(command.id)}
            disabled={!overridden}
          >
            <IcArrowCounterClockwise aria-hidden="true" />
          </IconButton>
        </div>
      </td>
      <td className={styles.conflicts}>
        {conflicts.length > 0 ? (
          <span className={styles.conflict}>
            <IcWarning size={14} aria-hidden="true" />
            Also assigned to {conflicts.map(c => c.label).join(', ')}
          </span>
        ) : null}
      </td>
    </tr>
  )
}

export default function ShortcutsSection() {
  const [listeningId, setListeningId] = useState(null)
  const [status, setStatus] = useState(null)
  const [query, setQuery] = useState('')
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

  const q = query.trim().toLowerCase()
  const byGroup = useMemo(() => {
    const map = new Map()
    for (const command of SHORTCUT_COMMANDS) {
      if (q) {
        const group = SHORTCUT_GROUPS.find(g => g.id === command.group)
        const haystack = [
          command.label,
          command.description || '',
          group?.label || '',
          formatCombo(resolveCombo(command.id)),
        ].join(' ').toLowerCase()
        // A listening row stays in view even when the search would hide it.
        if (!haystack.includes(q) && command.id !== listeningId) continue
      }
      if (!map.has(command.group)) map.set(command.group, [])
      map.get(command.group).push(command)
    }
    return map
  }, [q, listeningId])

  const shownCount = Array.from(byGroup.values()).reduce((n, list) => n + list.length, 0)

  return (
    <>
      <div className={styles.toolbar}>
        <TextField
          className={styles.search}
          label="Search shortcuts"
          type="search"
          placeholder="Search by action or key…"
          value={query}
          onChange={setQuery}
        />
        <span className={styles.count}>{shownCount} of {SHORTCUT_COMMANDS.length} actions</span>
        <Button onClick={handleResetAll} hint="Discards every customised key and returns to the shipped defaults">
          Restore all shortcuts
        </Button>
      </div>
      {status && <SettingsHint tone={status.kind}>{status.text}</SettingsHint>}

      {SHORTCUT_GROUPS.map((group) => {
        const commands = byGroup.get(group.id) || []
        if (commands.length === 0) return null
        return (
          <SettingsSection key={group.id} title={group.label}>
            <SettingsHint>{group.description}</SettingsHint>
            <table className={styles.table} aria-label={group.label}>
              <colgroup>
                <col className={styles.colAction} />
                <col className={styles.colBinding} />
                <col className={styles.colConflicts} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Action</th>
                  <th scope="col">Shortcut</th>
                  <th scope="col">Conflicts</th>
                </tr>
              </thead>
              <tbody>
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
              </tbody>
            </table>
          </SettingsSection>
        )
      })}

      {shownCount === 0 && <SettingsHint>No shortcuts match this search.</SettingsHint>}

      <SettingsHint>
        Panel and Sample Sandbox shortcuts only fire while that panel is focused, so
        they may reuse a key the rest of the app also uses.
      </SettingsHint>
    </>
  )
}
