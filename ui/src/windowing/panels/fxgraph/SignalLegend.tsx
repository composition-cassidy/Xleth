import React from 'react';
import styles from './SignalLegend.module.css';

// The cable key for the FX Graph header. Only the signal types the graph really carries
// are listed (audio, parameter, sidechain key): the events and video hues have no cables
// here. Each swatch repeats its cable's stroke pattern, so the key reads without colour.
const ENTRIES = [
  { signal: 'audio', label: 'Audio' },
  { signal: 'parameter', label: 'Parameter' },
  { signal: 'sidechain', label: 'Sidechain key' },
] as const;

export default function SignalLegend() {
  return (
    <ul className={styles.legend} aria-label="Cable types">
      {ENTRIES.map((entry) => (
        <li className={styles.item} key={entry.signal}>
          <svg className={styles.swatch} width="24" height="8" viewBox="0 0 24 8" aria-hidden="true">
            <line className={styles.line} data-signal={entry.signal} x1="1" y1="4" x2="23" y2="4" />
          </svg>
          <span>{entry.label}</span>
        </li>
      ))}
    </ul>
  );
}
