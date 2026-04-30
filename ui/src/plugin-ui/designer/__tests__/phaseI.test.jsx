import { beforeEach, describe, expect, it, vi } from 'vitest'

import { usePluginUIDesignerStore } from '../usePluginUIDesignerStore.js'
import {
  addChildToSelected,
  patchSelectedProps,
  patchSelectedStyle,
  renameSelectedNode,
} from '../designerActions.js'
import {
  createUndoSnapshot,
  pushUndoSnapshot,
  shouldCoalesceEdit,
} from '../undoRedo.js'
import { findNode } from '../layoutMutations.js'
import { SHIPPED_LAYOUTS } from '../../layouts/index.js'

describe('Phase I undo/redo helpers', () => {
  it('pushUndoSnapshot caps stack at 100', () => {
    const baseState = {
      workingLayout: cloneCompressorLayout(),
      selectedNodeId: 'root',
      validationResult: { ok: true, errors: [] },
      undoStack: Array.from({ length: 100 }, (_, index) => ({
        workingLayout: { marker: index },
        selectedNodeId: null,
        validationResult: { ok: true, errors: [] },
      })),
      redoStack: [],
      pendingCoalesce: null,
    }

    const next = pushUndoSnapshot(baseState, 'structural edit')

    expect(next.undoStack).toHaveLength(100)
    expect(next.undoStack[0].workingLayout.marker).toBe(1)
    expect(next.undoStack.at(-1).workingLayout.root?.id).toBe('root')
  })

  it('structural edits do not coalesce', () => {
    const prev = {
      kind: 'scalar',
      nodeId: 'k-threshold',
      fieldPath: 'props.size',
      lastAt: 1000,
      deadline: 1400,
    }

    expect(shouldCoalesceEdit(prev, null, 1100)).toBe(false)
  })

  it('scalar edits with same node/field within 400 ms coalesce', () => {
    const prev = {
      kind: 'scalar',
      nodeId: 'k-threshold',
      fieldPath: 'props.size',
      lastAt: 1000,
      deadline: 1400,
    }
    const next = {
      kind: 'scalar',
      nodeId: 'k-threshold',
      fieldPath: 'props.size',
    }

    expect(shouldCoalesceEdit(prev, next, 1399)).toBe(true)
  })

  it('scalar edits on different fields do not coalesce', () => {
    const prev = {
      kind: 'scalar',
      nodeId: 'k-threshold',
      fieldPath: 'props.size',
      lastAt: 1000,
      deadline: 1400,
    }
    const next = {
      kind: 'scalar',
      nodeId: 'k-threshold',
      fieldPath: 'props.label',
    }

    expect(shouldCoalesceEdit(prev, next, 1100)).toBe(false)
  })
})

describe('Phase I store/action undo-redo behavior', () => {
  beforeEach(async () => {
    vi.useRealTimers()
    usePluginUIDesignerStore.getState().reset()
    await usePluginUIDesignerStore.getState().loadInitial('compressor')
    usePluginUIDesignerStore.getState().setSelectedNodeId('k-threshold')
  })

  it('undo restores previous workingLayout', () => {
    const beforeLabel = findNode(usePluginUIDesignerStore.getState().workingLayout, 'k-threshold').props.label

    patchSelectedProps({ label: 'Threshold Test' })
    expect(findNode(usePluginUIDesignerStore.getState().workingLayout, 'k-threshold').props.label).toBe('Threshold Test')

    const result = usePluginUIDesignerStore.getState().undo()

    expect(result.ok).toBe(true)
    expect(findNode(usePluginUIDesignerStore.getState().workingLayout, 'k-threshold').props.label).toBe(beforeLabel)
  })

  it('redo restores undone layout', () => {
    patchSelectedProps({ label: 'Redo Label' })
    usePluginUIDesignerStore.getState().undo()

    const result = usePluginUIDesignerStore.getState().redo()

    expect(result.ok).toBe(true)
    expect(findNode(usePluginUIDesignerStore.getState().workingLayout, 'k-threshold').props.label).toBe('Redo Label')
  })

  it('fresh mutation clears redoStack', () => {
    patchSelectedProps({ label: 'First Label' })
    usePluginUIDesignerStore.getState().undo()
    expect(usePluginUIDesignerStore.getState().redoStack).toHaveLength(1)

    patchSelectedProps({ label: 'Second Label' })

    expect(usePluginUIDesignerStore.getState().redoStack).toHaveLength(0)
  })

  it('rename id edits are structural and do not coalesce', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)

    renameSelectedNode('k-threshold-a')
    vi.setSystemTime(1100)
    renameSelectedNode('k-threshold-b')

    expect(usePluginUIDesignerStore.getState().undoStack).toHaveLength(2)
    vi.useRealTimers()
  })

  it('rapid scalar edits to the same node and field produce one undo step', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)

    patchSelectedProps({ size: 53 })
    vi.setSystemTime(1200)
    patchSelectedProps({ size: 54 })

    const state = usePluginUIDesignerStore.getState()
    expect(state.undoStack).toHaveLength(1)
    expect(findNode(state.workingLayout, 'k-threshold').props.size).toBe(54)

    state.undo()
    expect(findNode(usePluginUIDesignerStore.getState().workingLayout, 'k-threshold').props.size).toBe(52)
    vi.useRealTimers()
  })

  it('scalar edits on different fields produce separate undo steps', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)

    patchSelectedProps({ size: 53 })
    vi.setSystemTime(1100)
    patchSelectedProps({ label: 'Different Field' })

    expect(usePluginUIDesignerStore.getState().undoStack).toHaveLength(2)
    vi.useRealTimers()
  })

  it('undo restores selectedNodeId when it still exists', () => {
    patchSelectedStyle({ paddingPx: 3 })

    usePluginUIDesignerStore.getState().undo()

    expect(usePluginUIDesignerStore.getState().selectedNodeId).toBe('k-threshold')
  })

  it('undo falls back selection when restored selectedNodeId no longer exists', () => {
    const base = cloneCompressorLayout()
    usePluginUIDesignerStore.setState({
      workingLayout: cloneCompressorLayout(),
      undoStack: [{
        ...createUndoSnapshot({
          workingLayout: base,
          selectedNodeId: 'missing-node',
          validationResult: { ok: true, errors: [] },
        }),
        selectedNodeId: 'missing-node',
      }],
      redoStack: [],
    })

    usePluginUIDesignerStore.getState().undo()

    expect(usePluginUIDesignerStore.getState().selectedNodeId).toBe('root')
  })

  it('dirty becomes false when undo returns to shipped baseline', () => {
    patchSelectedProps({ label: 'Dirty Label' })
    expect(usePluginUIDesignerStore.getState().dirty).toBe(true)

    usePluginUIDesignerStore.getState().undo()

    expect(usePluginUIDesignerStore.getState().dirty).toBe(false)
  })

  it('validationResult recomputes after undo/redo', () => {
    const invalidLayout = cloneCompressorLayout()
    findNode(invalidLayout, 'k-threshold').props.param = 'missing-param'

    usePluginUIDesignerStore.setState({
      workingLayout: cloneCompressorLayout(),
      selectedNodeId: 'root',
      undoStack: [{
        workingLayout: invalidLayout,
        selectedNodeId: 'k-threshold',
        validationResult: { ok: true, errors: [] },
      }],
      redoStack: [],
      pendingCoalesce: null,
    })

    usePluginUIDesignerStore.getState().undo()
    expect(usePluginUIDesignerStore.getState().validationResult.errors.map(error => error.code)).toContain('UNKNOWN_PARAM')

    usePluginUIDesignerStore.getState().redo()
    expect(usePluginUIDesignerStore.getState().validationResult.errors.map(error => error.code)).not.toContain('UNKNOWN_PARAM')
  })

  it('structural add edits undo and redo cleanly', () => {
    usePluginUIDesignerStore.getState().setSelectedNodeId('root')

    const added = addChildToSelected('row')
    expect(added.ok).toBe(true)
    expect(findNode(usePluginUIDesignerStore.getState().workingLayout, 'row')).toBeTruthy()

    usePluginUIDesignerStore.getState().undo()
    expect(findNode(usePluginUIDesignerStore.getState().workingLayout, 'row')).toBeNull()

    usePluginUIDesignerStore.getState().redo()
    expect(findNode(usePluginUIDesignerStore.getState().workingLayout, 'row')).toBeTruthy()
  })
})

function cloneCompressorLayout() {
  return JSON.parse(JSON.stringify(SHIPPED_LAYOUTS.compressor))
}
