import { Icon } from '../../ui-kit/icons'
import styles from './Browser.module.css'

/**
 * The disclosure caret (Phosphor caret-right): points right when closed and down
 * when open. Decorative; the button that holds it carries aria-expanded.
 */
export default function Disclosure({ open }) {
  return (
    <Icon
      name="caret-right"
      size={14}
      className={styles.disclosure}
      data-open={open ? 'true' : 'false'}
    />
  )
}
