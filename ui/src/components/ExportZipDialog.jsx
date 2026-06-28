import { useEffect, useState } from 'react'
import ProgressBar from './ProgressBar.jsx'

export default function ExportZipDialog({ isOpen, onClose }) {
  const [mode, setMode] = useState('full')
  const [phase, setPhase] = useState('idle')  // idle | preparing | running | done | error
  const [percent, setPercent] = useState(0)
  const [archPhase, setArchPhase] = useState('preparing')
  const [errorMsg, setErrorMsg] = useState('')
  const [resultPath, setResultPath] = useState('')

  useEffect(() => {
    if (!isOpen) return
    const unsub = window.xleth?.project?.onZipExportProgress?.((p) => {
      if (!p) return
      if (p.running) {
        setPhase('running')
        setArchPhase(p.phase || 'archiving')
        setPercent(p.percent ?? 0)
      } else {
        if (p.phase === 'done') {
          setPhase('done')
          setPercent(100)
          setResultPath(p.path || '')
        } else if (p.phase === 'error') {
          setPhase('error')
          setErrorMsg(p.error || 'Export failed')
        }
      }
    })
    return unsub
  }, [isOpen])

  useEffect(() => {
    if (isOpen) {
      setPhase('idle')
      setPercent(0)
      setErrorMsg('')
      setResultPath('')
    }
  }, [isOpen])

  const start = async () => {
    setPhase('preparing')
    setPercent(0)
    setErrorMsg('')
    const result = await window.xleth?.project?.exportZip?.({ mode })
    if (!result) {
      setPhase('error')
      setErrorMsg('No response from main process')
      return
    }
    if (result.cancelled) {
      setPhase('idle')
      return
    }
    if (!result.ok && phase !== 'done') {
      setPhase('error')
      setErrorMsg(result.error || 'Export failed')
    }
  }

  const showInFolder = () => {
    if (resultPath) window.xleth?.shell?.showItemInFolder?.(resultPath)
  }

  if (!isOpen) return null

  const running = phase === 'preparing' || phase === 'running'
  const finished = phase === 'done' || phase === 'error'

  return (
    <div className="export-dialog-backdrop" onClick={() => { if (!running) onClose() }}>
      <div className="export-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="export-dialog-header">
          <span>Export as ZIP</span>
          <button
            className="export-dialog-close"
            onClick={onClose}
            disabled={running}
            title={running ? 'Export in progress' : 'Close'}
          >×</button>
        </div>

        <div className="export-dialog-body">
          <div className="export-row-zip-mode">
            <label>
              <input
                type="radio"
                value="full"
                checked={mode === 'full'}
                onChange={() => setMode('full')}
                disabled={running}
              />
              Full bundle — all sources included
            </label>
            <p className="export-zip-hint">
              Copies all video and audio sources into the ZIP. Opens on any machine
              without relinking. Proxies are excluded — they regenerate automatically.
            </p>
          </div>

          <div className="export-row-zip-mode">
            <label>
              <input
                type="radio"
                value="projectOnly"
                checked={mode === 'projectOnly'}
                onChange={() => setMode('projectOnly')}
                disabled={running}
              />
              Project only — smaller ZIP
            </label>
            <p className="export-zip-hint">
              Leaves large video sources out. The recipient must relink them from their
              own copies. Samples, edits, and exports are always included.
            </p>
          </div>

          {(running || finished) && (
            <div className="export-progress">
              <ProgressBar progress={phase === 'preparing' ? null : percent / 100} />
              <div className="export-progress-label">
                {phase === 'preparing' && 'Saving project…'}
                {phase === 'running' && archPhase === 'archiving' && `Archiving… ${percent}%`}
                {phase === 'running' && archPhase !== 'archiving' && 'Preparing archive…'}
                {phase === 'done' && 'ZIP created successfully.'}
                {phase === 'error' && (errorMsg || 'Export failed.')}
              </div>
            </div>
          )}
        </div>

        <div className="export-dialog-footer">
          {phase === 'done' ? (
            <>
              <button onClick={showInFolder}>Show in Folder</button>
              <button className="export-btn-primary" onClick={onClose}>Close</button>
            </>
          ) : (
            <>
              <button onClick={onClose} disabled={running}>Close</button>
              <button className="export-btn-primary" onClick={start} disabled={running}>
                {running ? 'Exporting…' : 'Export…'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
