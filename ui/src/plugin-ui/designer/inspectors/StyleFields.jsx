import React, { useEffect, useRef, useState } from 'react'

const NUMERIC_FIELDS = [
  'paddingPx',
  'gapPx',
  'widthPx',
  'heightPx',
  'flexBasis',
]

const ALIGN_VALUES = ['start', 'center', 'end', 'stretch']
const JUSTIFY_VALUES = ['start', 'center', 'end', 'spaceBetween', 'spaceAround']

export default function StyleFields({ style = {}, onPatchStyle }) {
  return (
    <div className="pluginui-designer-inspector-group">
      <div className="pluginui-designer-inspector-group-title">Style</div>

      {NUMERIC_FIELDS.map(field => (
        <NumericStyleField
          key={field}
          name={field}
          value={style[field]}
          onPatchStyle={onPatchStyle}
        />
      ))}

      <label className="pluginui-designer-field pluginui-designer-field--checkbox">
        <span className="pluginui-designer-field-label">growsToFill</span>
        <input
          className="pluginui-designer-checkbox"
          type="checkbox"
          checked={style.growsToFill === true}
          onChange={event => {
            onPatchStyle?.({ growsToFill: event.target.checked ? true : undefined })
          }}
        />
      </label>

      <SelectStyleField
        name="align"
        value={style.align}
        options={ALIGN_VALUES}
        onPatchStyle={onPatchStyle}
      />

      <SelectStyleField
        name="justify"
        value={style.justify}
        options={JUSTIFY_VALUES}
        onPatchStyle={onPatchStyle}
      />
    </div>
  )
}

function NumericStyleField({ name, value, onPatchStyle }) {
  const formattedValue = formatNumericValue(value)
  const [draft, setDraft] = useState(formattedValue)
  const [fieldError, setFieldError] = useState(null)
  const [touched, setTouched] = useState(false)
  const skipNextCommitRef = useRef(false)

  useEffect(() => {
    setDraft(formatNumericValue(value))
    setFieldError(null)
    setTouched(false)
  }, [value])

  const commit = () => {
    if (skipNextCommitRef.current) {
      skipNextCommitRef.current = false
      return
    }

    if (!touched) return

    if (draft === formattedValue && !Array.isArray(value)) {
      setTouched(false)
      return
    }

    if (draft.trim() === '') {
      const result = onPatchStyle?.({ [name]: undefined })
      if (result?.ok === false) {
        setFieldError(result.error || 'Could not update style')
        return
      }
      setFieldError(null)
      setTouched(false)
      return
    }

    const parsed = Number(draft)
    if (!Number.isFinite(parsed)) {
      setFieldError('Enter a valid number')
      return
    }

    const result = onPatchStyle?.({ [name]: parsed })
    if (result?.ok === false) {
      setFieldError(result.error || 'Could not update style')
      return
    }

    setFieldError(null)
    setTouched(false)
  }

  const cancel = () => {
    setDraft(formattedValue)
    setFieldError(null)
    setTouched(false)
  }

  return (
    <>
      <label className="pluginui-designer-field">
        <span className="pluginui-designer-field-label">{name}</span>
        <input
          className="pluginui-designer-input"
          type="number"
          value={draft}
          placeholder={Array.isArray(value) ? 'array' : ''}
          onChange={event => {
            setDraft(event.target.value)
            setFieldError(null)
            setTouched(true)
          }}
          onBlur={commit}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              event.currentTarget.blur()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              cancel()
              skipNextCommitRef.current = true
              event.currentTarget.blur()
            }
          }}
        />
      </label>
      {fieldError && (
        <div className="pluginui-designer-field-error">{fieldError}</div>
      )}
    </>
  )
}

function SelectStyleField({ name, value, options, onPatchStyle }) {
  return (
    <label className="pluginui-designer-field">
      <span className="pluginui-designer-field-label">{name}</span>
      <select
        className="pluginui-designer-select"
        value={value || ''}
        onChange={event => {
          const nextValue = event.target.value || undefined
          onPatchStyle?.({ [name]: nextValue })
        }}
      >
        <option value="">(unset)</option>
        {options.map(option => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    </label>
  )
}

function formatNumericValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return ''
}
