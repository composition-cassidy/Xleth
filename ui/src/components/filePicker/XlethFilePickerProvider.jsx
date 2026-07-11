import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import XlethFilePickerModal from './XlethFilePickerModal.jsx'
import { setFilePickerOpener } from './filePickerService.js'

const FilePickerContext = createContext({
  openFilePicker: async () => ({ canceled: true }),
})

export function useXlethFilePicker() {
  return useContext(FilePickerContext)
}

export default function XlethFilePickerProvider({ children }) {
  const [request, setRequest] = useState(null)
  const resolverRef = useRef(null)

  const finish = useCallback((result) => {
    const resolver = resolverRef.current
    resolverRef.current = null
    setRequest(null)
    resolver?.(result || { canceled: true })
  }, [])

  const openFilePicker = useCallback((options = {}) => {
    if (resolverRef.current) {
      resolverRef.current({ canceled: true })
      resolverRef.current = null
    }
    return new Promise(resolve => {
      resolverRef.current = resolve
      setRequest({
        ...options,
        mode: options.mode || 'openFile',
      })
    })
  }, [])

  useEffect(() => setFilePickerOpener(openFilePicker), [openFilePicker])

  const value = useMemo(() => ({ openFilePicker }), [openFilePicker])

  return (
    <FilePickerContext.Provider value={value}>
      {children}
      {request && (
        <XlethFilePickerModal
          options={request}
          onCancel={() => finish({ canceled: true })}
          onAccept={(result) => finish(result)}
        />
      )}
    </FilePickerContext.Provider>
  )
}

