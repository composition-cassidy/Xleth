// The device system (ui/DESIGN.md "Device system"): one frame, one title bar,
// sections in signal order, one recessed display well. Presentational only:
// callers wire bypass, presets, A/B and parameters to the existing stores.

export { default as DeviceFrame } from './DeviceFrame';
export type { DeviceFrameProps, DeviceCompare, DeviceSide } from './DeviceFrame';
export { default as DeviceSection } from './DeviceSection';
export type { DeviceSectionProps } from './DeviceSection';
export { default as DisplayWell } from './DisplayWell';
export type { DisplayWellProps, DisplayView } from './DisplayWell';
export { default as DeviceMenu } from './DeviceMenu';
export type { DeviceMenuItem, DeviceMenuProps } from './DeviceMenu';
