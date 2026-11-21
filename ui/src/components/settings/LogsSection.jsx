import React, { useCallback, useEffect, useState } from 'react'
import { Button, IconButton, Toggle } from '../../ui-kit'
import { SettingsHint, SettingsRow, SettingsSection, settingsStyles } from './settingsKit.jsx'
import { iconComponent } from '../../ui-kit/icons'

const IcArrowsClockwise = iconComponent('arrows-clockwise')
const IcCheckFill = iconComponent('check', 'fill')
const IcFolderOpen = iconComponent('folder-open')

// ─── Settings → Application → Logs ───────────────────────────────────────────
//
// Reads and drives the main-process session buffer (electron-main/console-log.js).
// The lines themselves never cross IPC — this panel only shows how many there
// are and asks for exports — because shipping thousands of log entries to the
// renderer to render a preview would cost more than capturing them does.
// (So there is no line view and no level filter here: that needs a bridge call
// that returns lines, which is an IPC change.)

function formatClock(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleTimeString()
  } catch {
    return iso
  }
}

export default function LogsSection() {
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)

  const bridge = typeof window !== 'undefined' ? window.xleth?.logs : undefined

  const refresh = useCallback(async () => {
    if (!bridge?.getStatus) return
    try {
      setStatus(await bridge.getStatus())
    } catch (e) {
      setResult({ kind: 'warning', text: String(e?.message || e) })
    }
  }, [bridge])

  useEffect(() => { refresh() }, [refresh])

  // The captured count only moves forward while the app runs, so a slow poll
  // keeps the number honest without the panel having to subscribe to a stream
  // of log lines it does not display.
  useEffect(() => {
    const id = setInterval(refresh, 4000)
    return () => clearInterval(id)
  }, [refresh])

  const handleExport = useCallback(async (format) => {
    if (!bridge?.exportNow) return
    setBusy(true)
    setResult(null)
    try {
      const res = await bridge.exportNow(format)
      if (res?.cancelled) setResult(null)
      else if (res?.error) setResult({ kind: 'warning', text: res.error })
      else if (res?.path) setResult({ kind: 'success', text: res.path, path: res.path })
    } catch (e) {
      setResult({ kind: 'warning', text: String(e?.message || e) })
    } finally {
      setBusy(false)
    }
  }, [bridge])

  const handleAutoExport = useCallback(async (enabled) => {
    if (!bridge?.setAutoExport) return
    try {
      // Turning it ON also opens the destination folder, so the setting
      // answers "and where do these end up?" in the same gesture.
      const res = await bridge.setAutoExport(enabled)
      setStatus(s => (s ? { ...s, autoExport: res?.autoExport ?? enabled } : s))
    } catch (e) {
      setResult({ kind: 'warning', text: String(e?.message || e) })
    }
  }, [bridge])

  if (!bridge) {
    return (
      <SettingsSection title="Session log">
        <SettingsHint>Log capture is unavailable in this environment.</SettingsHint>
      </SettingsSection>
    )
  }

  const autoExport = !!status?.autoExport

  return (
    <>
      <SettingsSection title="Session log">
        <SettingsRow
          label="Captured this session"
          description="Main-process and renderer console output since XLETH started."
        >
          <span className={settingsStyles.mono}>
            {status ? `${status.lines.toLocaleString()} lines` : '—'}
            {status?.dropped > 0 ? ` (${status.dropped.toLocaleString()} dropped)` : ''}
          </span>
          <IconButton label="Refresh captured line count" onClick={refresh}>
            <IcArrowsClockwise aria-hidden="true" />
          </IconButton>
        </SettingsRow>

        <SettingsRow label="Session started" description="Capture begins when the app launches.">
          <span className={settingsStyles.mono}>{formatClock(status?.sessionStart)}</span>
        </SettingsRow>

        <SettingsRow
          label="Export now"
          description="Writes everything captured so far, with system and version details in the header."
        >
          <Button onClick={() => handleExport('txt')} disabled={busy}>Export .txt</Button>
          <Button onClick={() => handleExport('md')} disabled={busy}>Export .md</Button>
        </SettingsRow>

        {result && (
          <SettingsHint tone={result.kind}>
            <span>{result.kind === 'success' ? 'Written to: ' : ''}<span className={settingsStyles.mono}>{result.text}</span></span>
            {result.path && (
              <IconButton size="sm" variant="ghost" label="Show in folder" onClick={() => bridge.reveal?.(result.path)}>
                <IcFolderOpen aria-hidden="true" />
              </IconButton>
            )}
          </SettingsHint>
        )}
      </SettingsSection>

      <SettingsSection title="Automatic export">
        <SettingsRow
          label="Write a log file when XLETH closes"
          htmlFor="settings-logs-auto-export"
          description="Saves a report on every exit, and always on a crash even when this is off. Turning it on opens the folder the files go to."
        >
          <Toggle
            id="settings-logs-auto-export"
            aria-label="Write a log file when XLETH closes"
            on={autoExport}
            onChange={handleAutoExport}
            glyph={<IcCheckFill size={14} />}
          >
            {autoExport ? 'On' : 'Off'}
          </Toggle>
        </SettingsRow>

        <SettingsRow
          label="Log folder"
          description="The 20 most recent reports are kept; older ones are removed automatically."
        >
          <Button onClick={() => bridge.openFolder?.()}>Open folder</Button>
        </SettingsRow>

        {status?.logsDir && (
          <SettingsHint><span className={settingsStyles.mono}>{status.logsDir}</span></SettingsHint>
        )}
        {status?.crash && (
          <SettingsHint tone="warning">A problem was recorded this session: {status.crash}</SettingsHint>
        )}
      </SettingsSection>
    </>
  )
}
