import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  formatValidationError,
  getErrorsForNode,
  getGlobalErrors,
  getValidationSeverity,
  isExportAllowed,
  isSaveAllowed,
} from '../validationStatus.js'
import {
  buildValidationRows,
  selectValidationRow,
  ValidationPanelContent,
} from '../ValidationPanel.jsx'

describe('Phase G validation status helpers', () => {
  it('isSaveAllowed returns true for a valid layout with no errors', () => {
    expect(isSaveAllowed({ ok: true, errors: [] })).toBe(true)
    expect(isExportAllowed({ ok: true, errors: [] })).toBe(true)
  })

  it('isSaveAllowed returns true for only style-strip errors', () => {
    const result = {
      ok: true,
      errors: [
        { nodeId: 'body', code: 'UNKNOWN_STYLE_KEY', message: 'Stripped unknown style key: "position"' },
        { nodeId: 'body', code: 'BAD_STYLE_ALIGN', message: 'Invalid align value: "middle"' },
      ],
    }

    expect(isSaveAllowed(result)).toBe(true)
    expect(isExportAllowed(result)).toBe(true)
    expect(getValidationSeverity(result, result.errors[0])).toBe('info')
  })

  it('isSaveAllowed returns false for UNKNOWN_PARAM', () => {
    expect(isSaveAllowed({
      ok: true,
      errors: [{ nodeId: 'knob', code: 'UNKNOWN_PARAM', message: 'Unknown param "missing" for plugin "compressor"' }],
    })).toBe(false)
  })

  it('isSaveAllowed returns false for DUPLICATE_ID', () => {
    expect(isSaveAllowed({
      ok: true,
      errors: [{ nodeId: 'knob', code: 'DUPLICATE_ID', message: 'Duplicate node id: "knob"' }],
    })).toBe(false)
  })

  it('getErrorsForNode filters by node id', () => {
    const result = {
      ok: true,
      errors: [
        { nodeId: 'a', code: 'UNKNOWN_PARAM' },
        { nodeId: 'b', code: 'UNKNOWN_SLOT' },
      ],
    }

    expect(getErrorsForNode(result, 'a')).toEqual([{ nodeId: 'a', code: 'UNKNOWN_PARAM' }])
  })

  it('getGlobalErrors returns errors without node id', () => {
    const result = {
      ok: false,
      errors: [
        { code: 'BAD_INPUT', message: 'Layout document is not an object' },
        { nodeId: 'a', code: 'UNKNOWN_PARAM' },
      ],
    }

    expect(getGlobalErrors(result)).toEqual([{ code: 'BAD_INPUT', message: 'Layout document is not an object' }])
  })

  it('formatValidationError handles key binding error codes', () => {
    expect(formatValidationError({ code: 'UNKNOWN_PARAM', message: 'Unknown param "missing" for plugin "compressor"' })).toBe('Unknown parameter binding: missing')
    expect(formatValidationError({ code: 'UNKNOWN_SLOT', message: 'Unknown meter slot: "BAD_SLOT". Valid: PEAK_L' })).toBe('Unknown meter slot: BAD_SLOT')
    expect(formatValidationError({ code: 'UNKNOWN_VIZ_SOURCE', message: 'Unknown viz source "missing.source" for plugin "compressor"' })).toBe('Unknown visualizer source: missing.source')
    expect(formatValidationError({ nodeId: 'dup', code: 'DUPLICATE_ID', message: 'Duplicate node id: "dup"' })).toBe('Duplicate node id: dup')
  })
})

describe('Phase G ValidationPanelContent', () => {
  it('renders Layout valid when there are no errors', () => {
    const html = renderToStaticMarkup(
      <ValidationPanelContent validationResult={{ ok: true, errors: [] }} />,
    )

    expect(html).toContain('Layout valid')
  })

  it('renders hard, soft, and info rows with node ids', () => {
    const result = {
      ok: true,
      errors: [
        { nodeId: 'dup', code: 'DUPLICATE_ID', message: 'Duplicate node id: "dup"' },
        { nodeId: 'knob', code: 'UNKNOWN_PARAM', message: 'Unknown param "missing" for plugin "compressor"' },
        { nodeId: 'body', code: 'UNKNOWN_STYLE_KEY', message: 'Stripped unknown style key: "position"' },
      ],
    }

    const html = renderToStaticMarkup(
      <ValidationPanelContent validationResult={result} selectedNodeId="knob" />,
    )

    expect(html).toContain('pluginui-designer-validation-row--hard')
    expect(html).toContain('pluginui-designer-validation-row--soft')
    expect(html).toContain('pluginui-designer-validation-row--info')
    expect(html).toContain('dup')
    expect(html).toContain('knob')
    expect(html).toContain('body')
  })

  it('selectValidationRow calls the select callback for node rows only', () => {
    const rows = buildValidationRows({
      ok: true,
      errors: [
        { nodeId: 'knob', code: 'UNKNOWN_PARAM' },
        { code: 'BAD_INPUT' },
      ],
    })
    const onSelectNode = vi.fn()

    selectValidationRow(rows[0], onSelectNode)
    selectValidationRow(rows[1], onSelectNode)

    expect(onSelectNode).toHaveBeenCalledTimes(1)
    expect(onSelectNode).toHaveBeenCalledWith('knob')
  })
})
