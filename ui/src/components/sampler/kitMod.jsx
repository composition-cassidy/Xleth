import { Knob, NumberBox } from '../../ui-kit'
import { useModTarget } from './modulation/useModTarget.js'

// Kit value controls that can RECEIVE sampler modulation. `modTarget` is the
// declarative registration ({ target, index, stage, scale }, see modTargets.js);
// omit it and these are the plain kit controls. The registration hook supplies the
// kit's `mod` prop: drop target, routed range, amount drag, right-click bipolar.

export function ModKnob({ modTarget = null, ...props }) {
  const mod = useModTarget(modTarget, { value: props.value, min: props.min, max: props.max })
  return <Knob {...props} mod={mod} />
}

export function ModNumberBox({ modTarget = null, ...props }) {
  const mod = useModTarget(modTarget, { value: props.value, min: props.min, max: props.max })
  return <NumberBox {...props} mod={mod} />
}
