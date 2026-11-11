// The Xleth UI kit (ui/DESIGN.md). Controls share one interaction grammar and
// never call IPC or the engine: callers decide what onChange / onCommit do.

export { formatValue, formatValueText, THIN_SPACE, MINUS } from './format';
export type { Unit, FormatOptions } from './format';
export { parseValue, parseSyncDivision, syncBeats, syncCodec, syncLabel } from './parse';
export type { Codec, SyncDivision } from './parse';
export { hintAttrs, resolveHint, VALUE_HINT_MODS } from './hint';
export type { HintProps } from './hint';
export { dbTaperScale, linearScale, logScale, skewScale } from './valueScale';
export type { Scale } from './valueScale';
export { useValueDrag } from './useValueDrag';
export type { UseValueDragOptions } from './useValueDrag';
export { MOD_AMOUNT_PX, MOD_HINT_MODS, clampAmount, modRangeNorm, stepAmount, useModRing } from './modRing';
export type { ControlMod } from './modRing';

export { default as Knob } from './Knob';
export type { KnobProps } from './Knob';
export { default as NumberBox } from './NumberBox';
export type { NumberBoxProps } from './NumberBox';
export { default as Fader } from './Fader';
export type { FaderProps } from './Fader';
export { default as Meter, MeterScale, meterWidth, visibleScaleMarks } from './Meter';
export type { MeterProps, MeterScaleMode, MeterScaleProps, MeterSubscribe } from './Meter';
export { default as FaderMeter } from './FaderMeter';
export type { FaderMeterProps } from './FaderMeter';

export { Button, IconButton } from './Button';
export type { ButtonProps, IconButtonProps } from './Button';
export { default as Toggle } from './Toggle';
export { TextField } from './TextField';
export type { TextFieldProps } from './TextField';
export { Checkbox } from './Checkbox';
export type { CheckboxProps } from './Checkbox';
export { Progress } from './Progress';
export type { ProgressProps } from './Progress';
export type { ToggleProps } from './Toggle';
export { default as SegmentedControl } from './SegmentedControl';
export type { Segment, SegmentedControlProps } from './SegmentedControl';
export { default as Tabs } from './Tabs';
export type { TabItem, TabsProps } from './Tabs';
export { Toolbar, ToolbarSeparator } from './Toolbar';
export type { ToolbarProps } from './Toolbar';
export { PanelHeader, SectionHeader } from './Headers';
export type { PanelHeaderProps, SectionHeaderProps } from './Headers';
export { default as EmptyState } from './EmptyState';
export type { EmptyStateProps } from './EmptyState';
export { default as Select, getSelectedOption } from './Select';
export type { SelectOption, SelectProps } from './Select';

export * from './device';

export * from './icons';

export { Menu, MenuItem, MenuSeparator, MenuCustom } from './Menu';
export type { MenuProps, MenuItemProps } from './Menu';
export { default as Dialog, DialogText, DialogList, DialogListItem } from './Dialog';
export type { DialogProps } from './Dialog';
