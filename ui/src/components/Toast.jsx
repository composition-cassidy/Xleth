import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

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

  return (
    <span
      key={current.id}
      className={`toast-status toast-status-${current.level}`}
      onClick={() => dismiss(current.id)}
      role="status"
    >
      {current.message}
    </span>
  )
}
