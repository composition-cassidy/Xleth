import { createContext, useContext } from 'react'

const NOOP = () => {}

const defaultValue = {
  onOpenPicker: NOOP,
  pickerSource: null,
  onClosePicker: NOOP,
  activeSampleId: null,
  setActiveSampleId: NOOP,
  currentPatternIdByTrack: {},
  setCurrentPatternIdByTrack: NOOP,
  activeCenterTab: 'timeline',
  availablePatterns: [],
  allPatterns: {},
  onSwitchPattern: null,
  onNewPattern: NOOP,
  onOpenMidiImport: NOOP,
}

const XlethRootContext = createContext(defaultValue)

export function useXlethRootContext() {
  return useContext(XlethRootContext)
}

export default XlethRootContext
