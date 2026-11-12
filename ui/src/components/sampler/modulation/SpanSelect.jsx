import FieldSelect from '../FieldSelect.jsx'
import { SPAN_OPTIONS, useModSpanStore } from './modTime.js'

// How much time the envelope and LFO displays cover. One setting for all of
// them, so every source is drawn at the same scale. A view setting: it is not
// part of the sampler's data and is never sent to the engine.
export default function SpanSelect() {
  const span = useModSpanStore((s) => s.span)
  const setSpan = useModSpanStore((s) => s.setSpan)
  return (
    <FieldSelect
      label="Span" width={84} value={span} options={SPAN_OPTIONS}
      onChange={(v) => setSpan(Number(v))}
      hint="How much time the display covers. Fixed, so a short stage looks short and a long one long; anything longer runs off the right edge and says by how much. Fit scales to the content instead. Shared by every envelope and LFO."
      data-mod-field="span"
    />
  )
}
