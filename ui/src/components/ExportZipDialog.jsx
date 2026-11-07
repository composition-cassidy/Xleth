import { useEffect, useState } from 'react'
import ProgressBar from './ProgressBar.jsx'
import { Button, Dialog } from '../ui-kit'
import styles from './ExportZipDialog.module.css'
import { getPickerPath, openFilePicker } from './filePicker/filePickerService.js'

function basename(filePath) {
  return String(filePath || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
}

function joinPath(dirPath, fileName) {
  const dir = String(dirPath || '')
  if (!dir) return fileName
  return `${dir.replace(/[\\/]+$/, '')}\\${fileName}`
}

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
    setPercent(0)
    setErrorMsg('')

    let info = null
    try {
      info = await window.xleth?.project?.getInfo?.()
    } catch {}
    const projectStem = basename(info?.projectDir) || 'project'
    const defaultName = `${projectStem}.zip`
    const picked = await openFilePicker({
      mode: 'saveFile',
      title: 'Export Project as ZIP',
      subtitle: 'Choose where the project bundle should be written.',
      actionLabel: 'Export',
      defaultPath: info?.exportsDir ? joinPath(info.exportsDir, defaultName) : undefined,
      defaultName,
      defaultExtension: 'zip',
      filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
    })
    const destPath = getPickerPath(picked)
    if (!destPath && !picked?.unavailable) {
      setPhase('idle')
      return
    }

    setPhase('preparing')
    const result = await window.xleth?.project?.exportZip?.(destPath ? { mode, destPath } : { mode })
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
    <Dialog
      title="Export as ZIP"
      width="md"
      dismissable={!running}
      onClose={onClose}
      actions={
        phase === 'done' ? (
          <>
            <Button size="lg" onClick={showInFolder}>Show in folder</Button>
            <Button size="lg" variant="primary" onClick={onClose} data-autofocus>Close</Button>
          </>
        ) : (
          <>
            <Button size="lg" onClick={onClose} disabled={running}>Close</Button>
            <Button size="lg" variant="primary" onClick={start} disabled={running} data-autofocus>
              {running ? 'Exporting…' : 'Export…'}
            </Button>
          </>
        )
      }
    >
      <fieldset className={styles.modes} disabled={running}>
        <legend className={styles.legend}>Contents</legend>
        <label className={styles.mode}>
          <input
            type="radio"
            name="zip-mode"
            value="full"
            checked={mode === 'full'}
            onChange={() => setMode('full')}
          />
          <span className={styles.modeText}>
            <span className={styles.modeTitle}>Full bundle — all sources included</span>
            <span className={styles.modeHint}>
              Copies all video and audio sources into the ZIP. Opens on any machine
              without relinking. Proxies are excluded — they regenerate automatically.
            </span>
          </span>
        </label>
        <label className={styles.mode}>
          <input
            type="radio"
            name="zip-mode"
            value="projectOnly"
            checked={mode === 'projectOnly'}
            onChange={() => setMode('projectOnly')}
          />
          <span className={styles.modeText}>
            <span className={styles.modeTitle}>Project only — smaller ZIP</span>
            <span className={styles.modeHint}>
              Leaves large video sources out. The recipient must relink them from their
              own copies. Samples, edits, and exports are always included.
            </span>
          </span>
        </label>
      </fieldset>

      {(running || finished) && (
        <div className={styles.progress} role="status">
          <ProgressBar progress={phase === 'preparing' ? null : percent / 100} />
          <div className={styles.progressLabel}>
            {phase === 'preparing' && 'Saving project…'}
            {phase === 'running' && archPhase === 'archiving' && `Archiving… ${percent}%`}
            {phase === 'running' && archPhase !== 'archiving' && 'Preparing archive…'}
            {phase === 'done' && 'ZIP created successfully.'}
            {phase === 'error' && (errorMsg || 'Export failed.')}
          </div>
        </div>
      )}
    </Dialog>
  )
}
