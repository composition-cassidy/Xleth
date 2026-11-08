import useMixerStore from '../../../stores/mixerStore.js'
import useTimelineFocusStore from '../../../stores/timelineFocusStore.js'
import { usePanelRegistry } from '../../../windowing/registry/PanelRegistry'
import useVideoDeviceStore from './videoDeviceStore.js'

/** Select a track, switch the Devices tab to its picture, and open the tab (the Inspector's "Video effects" button). */
export function openVideoDevicesFor(trackId) {
  if (trackId == null) return
  useTimelineFocusStore.getState().setFocusedTrackId(trackId)
  useMixerStore.getState().setSelectedChainKey(String(trackId))
  useVideoDeviceStore.getState().setView('video')
  usePanelRegistry.getState().openPanel('devices')
}
