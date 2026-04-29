import { createContext, useContext } from 'react'

const NOOP = () => {}

const defaultValue = {
  onOpenPicker: NOOP,
  activeSampleId: null,
  setActiveSampleId: NOOP,
  currentPatternIdByTrack: {},
  setCurrentPatternIdByTrack: NOOP,
  activeCenterTab: 'timeline',
  availablePatterns: [],
  onSwitchPattern: null,
  onNewPattern: NOOP,
  onOpenMidiImport: NOOP,
}

const XlethRootContext = createContext(defaultValue)

export function useXlethRootContext() {
  return useContext(XlethRootContext)
}

export default XlethRootContext
