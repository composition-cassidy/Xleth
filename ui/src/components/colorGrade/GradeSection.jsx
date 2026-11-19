import { SectionHeader } from '../../ui-kit'
import inspector from '../inspector/Inspector.module.css'
import GradeStack from './GradeStack.jsx'
import styles from './colorGrade.module.css'

// The Inspector's "Color" section: the stack view for whatever is selected.
// It lists every Color Grade level this picture passes through, in order, says
// which are on, and opens any of them in the Color Grade window. The controls
// themselves live in that window, one design for every level.

/**
 * @param {object} props
 * @param {object} props.stack  { source:{id,name}, clip:{level,id,name}, layer:{id,name} }
 * @param {string} [props.note] one line under the header
 */
export default function GradeSection({ stack, note }) {
  return (
    <section className={inspector.section} aria-label="Color" data-testid="xleth-inspector-color">
      <SectionHeader>Color</SectionHeader>
      {note ? <p className={styles.caption}>{note}</p> : null}
      {/* "Open", not "Edit": the Inspector's Edit buttons open a clip's
          vibrato and scratch editors, and two meanings for one word in one
          panel would be a trap. */}
      <GradeStack stack={stack} openLabel="Open" />
    </section>
  )
}
