import { createContext, useContext } from 'react'

// Context provided by StockPluginRuntimeRenderer to all leaf components.
// Never read this directly in container nodes — they forward it implicitly
// by rendering children via renderChildren().

export const PluginUIContext = createContext(null)

export function usePluginUI() {
  const ctx = useContext(PluginUIContext)
  if (!ctx) throw new Error('usePluginUI must be used inside StockPluginRuntimeRenderer')
  return ctx
}
