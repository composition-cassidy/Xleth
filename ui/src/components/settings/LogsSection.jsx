import React, { useCallback, useEffect, useState } from 'react'
import { FolderOpen, RefreshCw } from 'lucide-react'

// ─── Settings → Application → Logs ───────────────────────────────────────────
//
// Reads and drives the main-process session buffer (electron-main/console-log.js).
// The lines themselves never cross IPC — this panel only shows how many there
// are and asks for exports — because shipping thousands of log entries to the
// renderer to render a preview would cost more than capturing them does.

function formatClock(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleTimeString()
  } catch {
    return iso
  }
}

export default function LogsSection({ SettingsSection, SettingsRow }) {
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
      <SettingsSection title="Session Log" index={0}>
        <div className="settings-panel-hint settings-panel-hint--inline">
          Log capture is unavailable in this environment.
        </div>
      </SettingsSection>
    )
  }

  return (
    <>
      <SettingsSection title="Session Log" index={0}>
        <SettingsRow
          label="Captured this session"
          description="Main-process and renderer console output since XLETH started."
        >
          <div className="settings-panel-inline-row">
            <span className="settings-panel-value">
              {status ? `${status.lines.toLocaleString()} lines` : '—'}
              {status?.dropped > 0 ? ` (${status.dropped.toLocaleString()} dropped)` : ''}
            </span>
            <button
              type="button"
              className="settings-panel-button settings-panel-button--icon"
              onClick={refresh}
              title="Refresh"
              aria-label="Refresh captured line count"
            >
              <RefreshCw size={14} aria-hidden="true" />
            </button>
          </div>
        </SettingsRow>

        <SettingsRow label="Session started" description="Capture begins when the app launches.">
          <span className="settings-panel-value">{formatClock(status?.sessionStart)}</span>
        </SettingsRow>

        <SettingsRow
          label="Export now"
          description="Writes everything captured so far, with system and version details in the header."
        >
          <div className="settings-panel-inline-row">
            <button
              type="button"
              className="settings-panel-button"
              onClick={() => handleExport('txt')}
              disabled={busy}
            >
              Export .txt
            </button>
            <button
              type="button"
              className="settings-panel-button"
              onClick={() => handleExport('md')}
              disabled={busy}
            >
              Export .md
            </button>
          </div>
        </SettingsRow>

        {result && (
          <div className={`settings-panel-hint settings-panel-hint--inline settings-panel-hint--${result.kind}`}>
            {result.kind === 'success' ? 'Written to: ' : ''}{result.text}
            {result.path && (
              <button
                type="button"
                className="settings-panel-button settings-panel-button--icon"
                onClick={() => bridge.reveal?.(result.path)}
                title="Show in folder"
              >
                <FolderOpen size={13} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="Automatic Export" index={1}>
        <SettingsRow
          label="Write a log file when XLETH closes"
          htmlFor="settings-logs-auto-export"
          description="Saves a report on every exit, and always on a crash even when this is off. Turning it on opens the folder the files go to."
        >
          <input
            id="settings-logs-auto-export"
            type="checkbox"
            className="settings-panel-checkbox"
            checked={!!status?.autoExport}
            onChange={e => handleAutoExport(e.target.checked)}
          />
        </SettingsRow>

        <SettingsRow
          label="Log folder"
          description="The 20 most recent reports are kept; older ones are removed automatically."
        >
          <button
            type="button"
            className="settings-panel-button"
            onClick={() => bridge.openFolder?.()}
          >
            Open Folder
          </button>
        </SettingsRow>

        {status?.logsDir && (
          <div className="settings-panel-hint settings-panel-hint--inline">{status.logsDir}</div>
        )}
        {status?.crash && (
          <div className="settings-panel-hint settings-panel-hint--inline settings-panel-hint--warning">
            A problem was recorded this session: {status.crash}
          </div>
        )}
      </SettingsSection>
    </>
  )
}
