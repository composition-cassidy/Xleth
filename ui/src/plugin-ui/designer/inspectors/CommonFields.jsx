import React, { useEffect, useRef, useState } from 'react'

export default function CommonFields({ node, allNodeIds, onRename }) {
  const [idDraft, setIdDraft] = useState(node?.id || '')
  const [fieldError, setFieldError] = useState(null)
  const skipNextCommitRef = useRef(false)

  useEffect(() => {
    setIdDraft(node?.id || '')
    setFieldError(null)
  }, [node?.id])

  if (!node) return null

  const commitId = () => {
    if (skipNextCommitRef.current) {
      skipNextCommitRef.current = false
      return
    }

    const nextId = idDraft.trim()

    if (!nextId) {
      setFieldError('Id cannot be empty')
      return
    }

    if (nextId !== node.id && allNodeIds?.has?.(nextId)) {
      setFieldError(`Id "${nextId}" already exists`)
      return
    }

    if (nextId === node.id) {
      setIdDraft(node.id)
      setFieldError(null)
      return
    }

    const result = onRename?.(nextId)
    if (result?.ok === false) {
      setFieldError(result.error || 'Could not rename node')
      return
    }

    setFieldError(null)
  }

  const cancelIdEdit = () => {
    setIdDraft(node.id)
    setFieldError(null)
  }

  return (
    <div className="pluginui-designer-inspector-group">
      <div className="pluginui-designer-inspector-group-title">Common</div>

      <label className="pluginui-designer-field">
        <span className="pluginui-designer-field-label">Id</span>
        <input
          className="pluginui-designer-input"
          type="text"
          value={idDraft}
          spellCheck="false"
          onChange={event => {
            setIdDraft(event.target.value)
            setFieldError(null)
          }}
          onBlur={commitId}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              event.currentTarget.blur()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              cancelIdEdit()
              skipNextCommitRef.current = true
              event.currentTarget.blur()
            }
          }}
        />
      </label>
      {fieldError && (
        <div className="pluginui-designer-field-error">{fieldError}</div>
      )}

      <label className="pluginui-designer-field">
        <span className="pluginui-designer-field-label">Type</span>
        <input
          className="pluginui-designer-input pluginui-designer-input--readonly"
          type="text"
          value={node.type || ''}
          readOnly
        />
      </label>
    </div>
  )
}
