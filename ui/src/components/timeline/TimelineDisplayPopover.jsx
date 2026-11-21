import { Menu, MenuCustom, SegmentedControl } from '../../ui-kit'
import styles from './TimelineDisplayPopover.module.css'

// The timeline display popover (DESIGN.md 22): a kit Menu of eight settings, each a label over
// a SegmentedControl in sentence case ("Minimal", "Gradient", "Medium", not "Min" and "Grad").
// Values, keys and the onSet(settingKey, value) call are exactly what they were.

const BODY_OPTIONS = [
  { label: 'Minimal', value: 'minimal' },
  { label: 'Plain', value: 'plain' },
  { label: 'Gradient', value: 'gradient' },
  { label: 'Solid', value: 'solid' },
]

const GRADIENT_OPTIONS = [
  { label: 'Top', value: 'top' },
  { label: 'Bottom', value: 'bottom' },
]

const CONTRAST_OPTIONS = [
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
]

const VISIBILITY_OPTIONS = [
  { label: 'Auto', value: 'auto', hint: 'Shown when the clip is large enough' },
  { label: 'Always', value: 'always' },
  { label: 'Never', value: 'never' },
]

const ROWS = [
  { label: 'Clip body', key: 'timelineClipBodyMode', options: BODY_OPTIONS, hint: 'How audio and video clips are filled' },
  { label: 'Pattern body', key: 'timelinePatternBodyMode', options: BODY_OPTIONS, hint: 'How pattern blocks are filled' },
  { label: 'Gradient', key: 'timelineBodyGradientDirection', options: GRADIENT_OPTIONS, hint: 'Which edge a gradient body is darker toward', needsGradient: true },
  { label: 'Contrast', key: 'timelineClipContrast', options: CONTRAST_OPTIONS, hint: 'Contrast of clip bodies against the lane' },
  { label: 'Names', key: 'timelineShowClipNames', options: VISIBILITY_OPTIONS, hint: 'Clip names' },
  { label: 'Metadata', key: 'timelineShowPitchShift', options: VISIBILITY_OPTIONS, hint: 'Pitch-shift chips on clips' },
  { label: 'Waveforms', key: 'timelineShowWaveforms', options: VISIBILITY_OPTIONS, hint: 'Waveforms inside audio clips' },
  { label: 'Pattern preview', key: 'timelineShowPatternPreview', options: VISIBILITY_OPTIONS, hint: 'A mini piano roll inside pattern blocks' },
]

export default function TimelineDisplayPopover({ settings, onSet, onClose, triggerRef }) {
  const rect = triggerRef?.current?.getBoundingClientRect?.()
  const x = rect ? rect.left : 0
  const y = rect ? rect.bottom + 4 : 0

  const gradientDisabled =
    settings.timelineClipBodyMode !== 'gradient' &&
    settings.timelinePatternBodyMode !== 'gradient'

  return (
    <Menu x={x} y={y} onClose={onClose} label="Timeline display" className={styles.menu}>
      <MenuCustom>
        <div className={`tl-display-popover ${styles.rows}`}>
          {ROWS.map((row) => (
            <div key={row.key} className={`tl-display-section ${styles.row}`}>
              <span className={styles.label}>{row.label}</span>
              <SegmentedControl
                size="sm"
                label={row.label}
                value={settings[row.key]}
                options={row.options}
                onChange={(value) => onSet(row.key, value)}
                disabled={row.needsGradient ? gradientDisabled : false}
                hint={row.needsGradient && gradientDisabled ? 'Gradient: turn on a Gradient body first' : row.hint}
              />
            </div>
          ))}
        </div>
      </MenuCustom>
    </Menu>
  )
}
