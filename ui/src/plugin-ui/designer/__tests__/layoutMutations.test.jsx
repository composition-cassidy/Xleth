import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { InspectorContent } from '../InspectorPanel.jsx'
import {
  collectNodeIds,
  findNode,
  updateNodeId,
  updateNodeProps,
  updateNodeStyle,
} from '../layoutMutations.js'
import { SHIPPED_LAYOUTS } from '../../layouts/index.js'

describe('layoutMutations', () => {
  it('updateNodeProps updates one node and preserves unrelated ids', () => {
    const layout = cloneCompressorLayout()
    const beforeIds = [...collectNodeIds(layout)].sort()

    const next = updateNodeProps(layout, 'k-threshold', {
      label: 'Threshold Test',
      size: 64,
    })

    expect(next).not.toBe(layout)
    expect(findNode(next, 'k-threshold').props.label).toBe('Threshold Test')
    expect(findNode(next, 'k-threshold').props.size).toBe(64)
    expect(findNode(layout, 'k-threshold').props.label).toBe('THRESH')
    expect([...collectNodeIds(next)].sort()).toEqual(beforeIds)
    expect(findNode(next, 'btn-rms')).toBeTruthy()
  })

  it('updateNodeStyle drops unknown style keys', () => {
    const layout = cloneCompressorLayout()

    const next = updateNodeStyle(layout, 'body', {
      gapPx: 20,
      color: 'red',
      position: 'absolute',
    })

    expect(findNode(next, 'body').style.gapPx).toBe(20)
    expect(findNode(next, 'body').style.color).toBeUndefined()
    expect(findNode(next, 'body').style.position).toBeUndefined()
  })

  it('updateNodeId rejects empty id', () => {
    const layout = cloneCompressorLayout()

    expect(() => updateNodeId(layout, 'k-threshold', '   ')).toThrow(/empty/i)
  })

  it('updateNodeId rejects duplicate id', () => {
    const layout = cloneCompressorLayout()

    expect(() => updateNodeId(layout, 'k-threshold', 'k-ratio')).toThrow(/already exists/i)
  })

  it('updateNodeId successfully renames selected node', () => {
    const layout = cloneCompressorLayout()

    const next = updateNodeId(layout, 'k-threshold', 'k-threshold-renamed')

    expect(findNode(next, 'k-threshold')).toBeNull()
    expect(findNode(next, 'k-threshold-renamed')).toBeTruthy()
    expect(findNode(layout, 'k-threshold')).toBeTruthy()
  })
})

describe('InspectorContent', () => {
  it('renders selected id and type from props', () => {
    const layout = cloneCompressorLayout()
    const node = findNode(layout, 'k-ratio')

    const html = renderToStaticMarkup(
      <InspectorContent
        node={node}
        allNodeIds={collectNodeIds(layout)}
        validationErrors={[]}
        mutationError={null}
        onRename={() => ({ ok: true })}
        onPatchStyle={() => ({ ok: true })}
      />,
    )

    expect(html).toContain('value="k-ratio"')
    expect(html).toContain('value="knob"')
  })
})

function cloneCompressorLayout() {
  return JSON.parse(JSON.stringify(SHIPPED_LAYOUTS.compressor))
}
