import type { TokenDef } from '../tokens/catalog'
import { DERIVED_FORMULA_TOKEN_NAMES_SET } from '../tokens/catalog'
import ColorPicker from './ColorPicker'

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
    <div className={`token-row ${isDetached ? 'token-row--detached' : ''}`}>
      {isColor && (
        <div
          className="token-row-swatch"
          style={{ background: resolvedValue || 'transparent' }}
          title={resolvedValue}
        />
      )}

      <div className="token-row-name" title={token.name}>
        {shortName}
      </div>

      <div className="token-row-control">
        {canPickColor ? (
          <ColorPicker
            value={resolvedValue}
            onChange={v => onTokenChange(token.name, v)}
          />
        ) : (
          <span className="token-row-value-text" title={resolvedValue}>
            {resolvedValue || '—'}
          </span>
        )}
      </div>

      {showDetachToggle && (
        <button
          className={`token-row-detach ${isDetached ? 'token-row-detach--on' : ''}`}
          title={isDetached ? 'Re-attach to derivation formula' : 'Detach — use explicit override'}
          onClick={() => onDetachToggle(token.name)}
        >
          {isDetached ? '⚡' : '⊙'}
        </button>
      )}
    </div>
  )
}
