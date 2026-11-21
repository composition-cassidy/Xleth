import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useGhostExit, useMotionEnter } from '../ui-kit'
import styles from './Toast.module.css'
import { iconComponent } from '../ui-kit/icons'

const IcCheckCircle = iconComponent('check-circle')
const IcInfo = iconComponent('info')
const IcWarningCircle = iconComponent('warning-circle')

const LEVEL_GLYPH = { info: IcInfo, success: IcCheckCircle, error: IcWarningCircle }

const ToastCtx = createContext(null)

let nextId = 1

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const timers = useRef(new Map())

  const dismiss = useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id))
    const t = timers.current.get(id)
    if (t) { clearTimeout(t); timers.current.delete(id) }
  }, [])

  const showToast = useCallback((message, level = 'info') => {
    const id = nextId++
    setToasts((list) => [...list, { id, message, level }])
    if (level !== 'error') {
      const handle = setTimeout(() => dismiss(id), 4000)
      timers.current.set(id, handle)
    }
    return id
  }, [dismiss])

  useEffect(() => () => {
    for (const t of timers.current.values()) clearTimeout(t)
    timers.current.clear()
  }, [])

  return (
    <ToastCtx.Provider value={{ showToast, dismiss, toasts }}>
      {children}
    </ToastCtx.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastCtx)
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>')
  return ctx
}

export function ToastStatusText() {
  const { toasts, dismiss } = useToast()
  const current = toasts[toasts.length - 1]
  if (!current) return null

  // key: each toast is its own element, so it enters (and the one it replaces exits) on its own.
  return <ToastLine key={current.id} toast={current} dismiss={dismiss} />
}

function ToastLine({ toast, dismiss }) {
  const ref = useRef(null)
  // Motion (ui-kit/motion.css): the line rises into the bar and sinks back out of it. The exit is
  // pinned where the line stood, so the next toast never waits for it or shifts around it.
  const enter = useMotionEnter('toast')
  useGhostExit(ref, { pin: true, shiftY: 4 })
  const Glyph = LEVEL_GLYPH[toast.level] || IcInfo
  return (
    <span role={toast.level === 'error' ? 'alert' : 'status'}>
      <button
        ref={ref}
        type="button"
        className={styles.toast}
        data-level={toast.level}
        onClick={() => dismiss(toast.id)}
        title="Dismiss"
        {...enter}
      >
        <span className={styles.glyph} aria-hidden="true"><Glyph size={12} /></span>
        <span className={styles.message}>{toast.message}</span>
      </button>
    </span>
  )
}
