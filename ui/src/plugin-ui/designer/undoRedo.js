import { validate } from '../schema/validate.js'
import { nodeExists } from './layoutMutations.js'

export const UNDO_STACK_LIMIT = 100
export const REDO_STACK_LIMIT = 100
export const COALESCE_WINDOW_MS = 400

export function createUndoSnapshot(state) {
  return {
    workingLayout: cloneJson(state?.workingLayout ?? null),
    selectedNodeId: state?.selectedNodeId ?? null,
    validationResult: cloneJson(state?.validationResult ?? { ok: true, errors: [] }),
  }
}

export function pushUndoSnapshot(state, reason, options = {}) {
  options = options || {}
  if (!state?.workingLayout) {
    return {
      undoStack: [...(state?.undoStack || [])],
      redoStack: [],
      pendingCoalesce: null,
    }
  }

  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const nextEdit = normalizeCoalesceEdit(reason, options, now)

  if (shouldCoalesceEdit(state.pendingCoalesce, nextEdit, now)) {
    return {
      undoStack: [...(state.undoStack || [])],
      redoStack: [],
      pendingCoalesce: {
        ...state.pendingCoalesce,
        ...nextEdit,
        startedAt: state.pendingCoalesce.startedAt ?? state.pendingCoalesce.at ?? now,
        lastAt: now,
        deadline: now + COALESCE_WINDOW_MS,
      },
    }
  }

  return {
    undoStack: capStack([...(state.undoStack || []), createUndoSnapshot(state)], UNDO_STACK_LIMIT),
    redoStack: [],
    pendingCoalesce: nextEdit,
  }
}

export function canUndo(state) {
  return (state?.undoStack?.length || 0) > 0
}

export function canRedo(state) {
  return (state?.redoStack?.length || 0) > 0
}

export function applyUndo(state) {
  if (!canUndo(state)) return null

  const undoStack = [...state.undoStack]
  const target = undoStack.pop()
  const redoStack = capStack([...(state.redoStack || []), createUndoSnapshot(state)], REDO_STACK_LIMIT)

  return buildRestoredState(state, target, {
    undoStack,
    redoStack,
  })
}

export function applyRedo(state) {
  if (!canRedo(state)) return null

  const redoStack = [...state.redoStack]
  const target = redoStack.pop()
  const undoStack = capStack([...(state.undoStack || []), createUndoSnapshot(state)], UNDO_STACK_LIMIT)

  return buildRestoredState(state, target, {
    undoStack,
    redoStack,
  })
}

export function clearRedoStack(state) {
  return {
    ...(state || {}),
    redoStack: [],
  }
}

export function shouldCoalesceEdit(prevCoalesce, nextEdit, now) {
  if (!prevCoalesce || !nextEdit) return false
  if (prevCoalesce.kind !== 'scalar' || nextEdit.kind !== 'scalar') return false
  if (!prevCoalesce.nodeId || !nextEdit.nodeId) return false
  if (!prevCoalesce.fieldPath || !nextEdit.fieldPath) return false
  if (prevCoalesce.nodeId !== nextEdit.nodeId) return false
  if (prevCoalesce.fieldPath !== nextEdit.fieldPath) return false

  const deadline = Number.isFinite(prevCoalesce.deadline)
    ? prevCoalesce.deadline
    : (prevCoalesce.lastAt ?? prevCoalesce.at ?? 0) + COALESCE_WINDOW_MS

  return now <= deadline
}

function buildRestoredState(state, snapshot, stacks) {
  const restoredLayout = cloneJson(snapshot?.workingLayout ?? null)
  const result = restoredLayout
    ? validate(restoredLayout, state?.manifest ?? null)
    : { ok: true, errors: [] }
  const workingLayout = result.ok ? result.doc : restoredLayout

  return {
    ...stacks,
    workingLayout,
    selectedNodeId: resolveSelectedNodeId(workingLayout, snapshot?.selectedNodeId),
    validationResult: result,
    dirty: !layoutMatchesSavedBase(workingLayout, state?.savedOverride, state?.shippedLayout),
    pendingCoalesce: null,
    mutationError: null,
  }
}

function resolveSelectedNodeId(layout, selectedNodeId) {
  if (selectedNodeId && nodeExists(layout, selectedNodeId)) return selectedNodeId
  return layout?.root?.id ?? null
}

function normalizeCoalesceEdit(reason, options, now) {
  const edit = options.editMeta || options.coalesce || null
  if (!edit || edit.kind !== 'scalar') return null

  const nodeId = edit.nodeId ?? options.nodeId
  const fieldPath = edit.fieldPath ?? edit.field ?? options.fieldPath
  if (!nodeId || !fieldPath) return null

  return {
    kind: 'scalar',
    reason: reason ?? 'edit',
    nodeId,
    fieldPath,
    at: now,
    startedAt: now,
    lastAt: now,
    deadline: now + COALESCE_WINDOW_MS,
  }
}

function capStack(stack, limit) {
  if (stack.length <= limit) return stack
  return stack.slice(stack.length - limit)
}

function layoutMatchesSavedBase(layout, savedOverride, shippedLayout) {
  return jsonEqual(layout, savedOverride ?? shippedLayout)
}

function jsonEqual(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

function cloneJson(value) {
  if (value == null) return value
  return JSON.parse(JSON.stringify(value))
}
