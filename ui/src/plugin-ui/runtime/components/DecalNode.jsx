import React, { useEffect, useState } from 'react'
import { PLACEHOLDER_DECAL_ID } from '../../appearance/decals/placeholder.js'
import { getDecalAssetDataUrl } from '../../appearance/decals/assetRegistry.js'

export default function DecalNode({ node }) {
  const { props = {} } = node
  const { assetId, fit = 'contain', opacity = 100 } = props

  const isPlaceholder = !assetId || assetId === PLACEHOLDER_DECAL_ID

  const [dataUrl, setDataUrl]       = useState(null)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    if (isPlaceholder) {
      setDataUrl(null)
      setLoadFailed(false)
      return
    }

    let cancelled = false
    setDataUrl(null)
    setLoadFailed(false)

    getDecalAssetDataUrl(assetId)
      .then(url => {
        if (cancelled) return
        if (url) {
          setDataUrl(url)
        } else {
          setLoadFailed(true)
        }
      })
      .catch(() => { if (!cancelled) setLoadFailed(true) })

    return () => { cancelled = true }
  }, [assetId, isPlaceholder])

  const baseStyle = {
    display:       'block',
    width:         '100%',
    height:        '100%',
    opacity:       opacity / 100,
    boxSizing:     'border-box',
    pointerEvents: 'none',
    userSelect:    'none',
  }

  if (isPlaceholder || !dataUrl) {
    return (
      <div
        className={[
          'pluginui-decal',
          'pluginui-decal--placeholder',
          loadFailed ? 'pluginui-decal--missing' : '',
        ].join(' ').trim()}
        style={{
          ...baseStyle,
          border:          '1px dashed var(--theme-text-subtle, rgba(255,255,255,0.2))',
          backgroundColor: 'var(--theme-bg-inset, rgba(0,0,0,0.15))',
        }}
        aria-hidden="true"
        data-decal-id={assetId}
        data-pluginui-id={node.id}
      />
    )
  }

  // CSS object-fit uses 'fill' for what the schema calls 'stretch'.
  const objectFit = fit === 'stretch' ? 'fill' : fit

  return (
    <img
      className="pluginui-decal pluginui-decal--image"
      src={dataUrl}
      alt=""
      style={{ ...baseStyle, objectFit }}
      aria-hidden="true"
      data-decal-id={assetId}
      data-pluginui-id={node.id}
      draggable={false}
    />
  )
}
