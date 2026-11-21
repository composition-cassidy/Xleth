import { SectionHeader } from '../../ui-kit'
import useSamplerModulationStore from '../../stores/samplerModulationStore.js'
import EnvEditor from './modulation/EnvEditor.jsx'
import { ENV_SOURCE_0 } from './modulation/modConstants.js'
import styles from './Sampler.module.css'

// ── Envelope view ───────────────────────────────────────────────────────────
// The amp envelope on a page of its own: the shape every note's level follows,
// drawn large, over its stage knobs, curves and the ms / note-value switch. It is
// Env 1 of the modulation config (the same editor, the same store, the same
// commit), so an edit here and an edit to Env 1 in Modulation are one thing.

const AMP_HINT = 'The level of every note over time. It is Env 1 in Modulation, where it can also drive other controls.'

export default function SamplerEnvelopeView({ bpm }) {
  const env = useSamplerModulationStore((s) => s.config?.envs?.[0])
  const loading = useSamplerModulationStore((s) => s.loading)
  const previewEnv = useSamplerModulationStore((s) => s.previewEnv)
  const commit = useSamplerModulationStore((s) => s.commit)

  return (
    <div className={styles.envelope} data-view="envelope">
      <div className={styles.envBox} data-section="amp">
        <SectionHeader actions={<span className={styles.caption} data-hint={AMP_HINT}>Env 1 · every note's level</span>}>
          Amp envelope
        </SectionHeader>
        {env ? (
          <EnvEditor
            env={env}
            color="var(--ui-signal-parameter)"
            bpm={bpm}
            source={ENV_SOURCE_0}
            label="Amp envelope"
            preview={(patch) => previewEnv(0, patch)}
            commit={commit}
          />
        ) : (
          <span className={`${styles.caption} ${styles.envEmpty}`}>{loading ? 'Loading…' : 'No envelope data'}</span>
        )}
      </div>
    </div>
  )
}
