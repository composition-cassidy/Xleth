// Named action registry for Button nodes.
// Actions receive a context object ({ close, target, manifest }).
// Only actions registered here can be triggered from layout JSON.

const ACTION_REGISTRY = {
  'panel.close': (ctx) => ctx.close?.(),
}

export function resolveAction(actionId) {
  return ACTION_REGISTRY[actionId] ?? null
}

export function isKnownAction(actionId) {
  return actionId in ACTION_REGISTRY
}
