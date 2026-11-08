import { Link2, Link2Off } from 'lucide-react'
import { IconButton } from '../../ui-kit'
import type { TokenDef } from '../tokens/catalog'
import { DERIVED_FORMULA_TOKEN_NAMES_SET } from '../tokens/catalog'
import ColorPicker from './ColorPicker'
import styles from './ThemeEditor.module.css'

interface Props {
  token: TokenDef
  resolvedValue: string
  isDetached: boolean
  isReadOnly: boolean
  onTokenChange: (name: string, value: string) => void
  onDetachToggle: (name: string) => void
}

const isHex = (v: string) => /^#[0-9a-fA-F]{3,8}$/.test(v.trim())

export default function TokenRow({ token, resolvedValue, isDetached, isReadOnly, onTokenChange, onDetachToggle }: Props) {
  const isColor = token.kind === 'color'
  const canPickColor = isColor && isHex(resolvedValue) && !isReadOnly
  const showDetachToggle = DERIVED_FORMULA_TOKEN_NAMES_SET.has(token.name) && !isReadOnly

  const shortName = token.name.replace(/^--theme-/, '')

  return (
    <div className={styles.tokenRow} data-detached={isDetached || undefined}>
      {isColor && (
        <div
          className={styles.swatch}
          style={{ background: resolvedValue || 'transparent' }}
          title={resolvedValue}
          aria-hidden="true"
        />
      )}

      <div className={styles.tokenName} title={token.name}>
        {shortName}
      </div>

      <div className={styles.tokenControl}>
        {canPickColor ? (
          <ColorPicker
            label={`${shortName} colour`}
            value={resolvedValue}
            onChange={v => onTokenChange(token.name, v)}
          />
        ) : (
          <span className={styles.tokenValue} title={resolvedValue}>
            {resolvedValue || '—'}
          </span>
        )}
      </div>

      {showDetachToggle && (
        <IconButton
          size="sm"
          variant="ghost"
          pressed={isDetached}
          label={isDetached ? `Re-attach ${shortName} to its derivation formula` : `Detach ${shortName} and use an explicit override`}
          hint={isDetached ? 'Re-attach to derivation formula' : 'Detach and use an explicit override'}
          onClick={() => onDetachToggle(token.name)}
        >
          {isDetached ? <Link2Off aria-hidden="true" /> : <Link2 aria-hidden="true" />}
        </IconButton>
      )}
    </div>
  )
}
