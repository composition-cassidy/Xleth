import Fader, { type FaderProps } from './Fader';
import styles from './FaderMeter.module.css';
import Meter, { type MeterProps } from './Meter';
import NumberBox from './NumberBox';
import { dbTaperScale } from './valueScale';

export interface FaderMeterProps extends Omit<FaderProps, 'width'> {
  subscribe: MeterProps['subscribe'];
  channels?: MeterProps['channels'];
  meterMin?: number;
  meterMax?: number;
  clipDb?: number;
  onClipChange?: MeterProps['onClipChange'];
  /** Width of the numeric field above the fader. Default 56. */
  fieldWidth?: number;
}

/**
 * The mixer pair: a numeric dB field on top (drag it, or type "-6" / "-inf"),
 * the fader and a canvas meter side by side beneath. The meter's levels come from
 * the caller's `subscribe`; the kit does not know where they originate.
 */
export default function FaderMeter(props: FaderMeterProps) {
  const {
    subscribe, channels = 2, meterMin, meterMax, clipDb, onClipChange, fieldWidth = 56,
    label, scale = dbTaperScale, unit = 'dB', className, ...faderProps
  } = props;
  const { value, defaultValue = 0, disabled, onChange, onCommit, onCancel, hint, hintMods, formatOptions, format, parse } = faderProps;
  return (
    <div className={`${styles.pair}${className ? ` ${className}` : ''}`} data-disabled={disabled || undefined}>
      <NumberBox
        label={`${label} level`}
        hideLabel
        width={fieldWidth}
        value={value}
        scale={scale}
        unit={unit}
        defaultValue={defaultValue}
        formatOptions={formatOptions}
        format={format}
        parse={parse}
        disabled={disabled}
        onChange={onChange}
        onCommit={onCommit}
        onCancel={onCancel}
        hint={hint ? `${hint} (level)` : undefined}
      />
      <div className={styles.body}>
        <Fader {...faderProps} label={label} scale={scale} unit={unit} hint={hint} hintMods={hintMods} />
        <Meter
          subscribe={subscribe}
          label={label}
          channels={channels}
          min={meterMin}
          max={meterMax}
          clipDb={clipDb}
          onClipChange={onClipChange}
        />
      </div>
    </div>
  );
}
