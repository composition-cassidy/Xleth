// Loudness normalization platform targets for the audio ExportDialog.
// 'none' (default) leaves AudioExporter::Config.normalizationEnabled false —
// bit-identical to a pre-normalization export. 'custom' lets the user set
// target/ceiling directly; it always forces allowUpwardGain: false since
// there's no platform spec backing an upward trim.
export const PLATFORM_TARGETS = {
  none: {
    label: 'None (off)',
    targetLufs: null,
    maxDbtp: null,
    allowUpwardGain: false,
  },
  youtube: {
    label: 'YouTube',
    targetLufs: -14,
    maxDbtp: -1,
    allowUpwardGain: false,
  },
  spotify: {
    label: 'Spotify',
    targetLufs: -14,
    maxDbtp: -1,
    allowUpwardGain: true,
  },
  apple_music: {
    label: 'Apple Music',
    targetLufs: -16,
    maxDbtp: -1,
    allowUpwardGain: true,
  },
  custom: {
    label: 'Custom',
    targetLufs: -14,
    maxDbtp: -1,
    allowUpwardGain: false,
  },
}

export const DEFAULT_PLATFORM_TARGET = 'none'
