import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

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
    <ToastCtx.Provider value={{ showToast, dismiss }}>
      {children}
      {createPortal(
        <div className="toast-stack">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast-${t.level}`} onClick={() => dismiss(t.id)}>
              <span className="toast-msg">{t.message}</span>
              {t.level === 'error' && <span className="toast-dismiss">×</span>}
            </div>
          ))}
        </div>,
        document.body
      )}
    </ToastCtx.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastCtx)
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>')
  return ctx
}
